import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import { codexAuthHeaders } from "../plugin/codex"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"

type ImageItem = {
  id?: string
  type?: string
  status?: string
  revised_prompt?: string
  result?: string
}

const ORCHESTRATOR_MODEL = "gpt-5.5"
const OutputFormat = z.enum(["png", "jpeg", "webp"])

function safeName(value: string | undefined, fallback: string) {
  const safe = (value || fallback).replace(/[^A-Za-z0-9_-]/g, "_")
  return safe.length ? safe : fallback
}

function format(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71 &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10
  ) {
    return "image/png"
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (
    bytes.length >= 6 &&
    bytes[0] === 71 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 56 &&
    (bytes[4] === 55 || bytes[4] === 57) &&
    bytes[5] === 97
  ) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  ) {
    return "image/webp"
  }
}

async function reference(value: string, ctx: Tool.Context) {
  if (value.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
    if (!match) {
      throw new Error("Reference image must be a PNG, JPEG, GIF, or WebP data URL")
    }
    const bytes = Buffer.from(match[2], "base64")
    const mime = format(bytes)
    if (mime !== match[1]) throw new Error("Reference image must be a PNG, JPEG, GIF, or WebP data URL")
    return `data:${mime};base64,${bytes.toString("base64")}`
  }

  if (!path.isAbsolute(value) && URL.canParse(value)) {
    if (new URL(value).protocol !== "https:") {
      throw new Error("Reference image URL must use HTTPS")
    }
    return value
  }

  const raw = path.resolve(Instance.directory, value)
  const local = Instance.containsPath(raw)
  const opts = {
    bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    kind: "file" as const,
  }
  if (!local) await assertExternalDirectory(ctx, raw, opts)

  const file = Filesystem.resolve(raw)
  if (local) await assertExternalDirectory(ctx, file, opts)
  const stat = Filesystem.stat(file)
  if (!stat) throw new Error(`Reference image not found: ${file}`)
  if (!stat.isFile()) throw new Error(`Reference image must be a file: ${file}`)

  await ctx.ask({
    permission: "read",
    patterns: [file],
    always: ["*"],
    metadata: {},
  })
  const bytes = await Filesystem.readBytes(file)
  const mime = format(bytes)
  if (!mime) throw new Error(`Reference image must be a PNG, JPEG, GIF, or WebP file: ${file}`)
  return `data:${mime};base64,${bytes.toString("base64")}`
}

function parseSSE(buffer: string) {
  const events: unknown[] = []
  for (const block of buffer.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") continue
    try {
      events.push(JSON.parse(data))
    } catch {}
  }
  return events
}

async function collectImage(response: Response): Promise<ImageItem> {
  if (!response.body) throw new Error("Image generation response did not include a stream")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let found: ImageItem | undefined

  while (true) {
    const { value, done } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const boundary = pending.lastIndexOf("\n\n")
    if (boundary >= 0) {
      const complete = pending.slice(0, boundary + 2)
      pending = pending.slice(boundary + 2)
      for (const event of parseSSE(complete) as Array<{ type?: string; item?: ImageItem }>) {
        if (
          event.type === "response.output_item.done" &&
          event.item?.type === "image_generation_call" &&
          event.item.result
        ) {
          found = event.item
        }
      }
    }
    if (done) break
  }

  for (const event of parseSSE(pending) as Array<{ type?: string; item?: ImageItem }>) {
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "image_generation_call" &&
      event.item.result
    ) {
      found = event.item
    }
  }

  if (!found) throw new Error("The model did not return an image_generation_call result")
  if (!found.result) throw new Error("Image generation completed without image bytes")
  return found
}

export const ImageGenerateTool = Tool.define("image_generate", {
  description:
    "Generate or edit an image using the OpenAI Codex/ChatGPT image generation tool. Requires OpenAI ChatGPT Pro/Plus OAuth auth.",
  parameters: z
    .object({
      prompt: z.string().describe("Detailed image prompt describing the desired image"),
      short_name: z.string().describe("Short human-readable name shown for this image in the Generated images sidebar"),
      reference_image: z
        .string()
        .optional()
        .describe(
          "Optional single reference image: local PNG, JPEG, GIF, or WebP path; HTTPS image URL; or matching data:image/<format>;base64 URL. Do not provide with reference_images.",
        ),
      reference_images: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          "Optional ordered reference images: local PNG, JPEG, GIF, or WebP paths; HTTPS image URLs; or matching data:image/<format>;base64 URLs. Do not provide with reference_image.",
        ),
      input_fidelity: z
        .enum(["low", "high"])
        .optional()
        .describe("Optional reference-image fidelity for models that support it."),
      model: z
        .enum(["gpt-image-2", "gpt-image-1.5"])
        .optional()
        .describe("Image generation model (defaults to gpt-image-2)"),
      size: z
        .string()
        .optional()
        .describe("Image size, such as auto, 1024x1024, 1536x1024, 1024x1536, or another supported WIDTHxHEIGHT value"),
      quality: z.enum(["auto", "low", "medium", "high"]).optional().describe("Image quality (defaults to auto)"),
      background: z
        .enum(["auto", "opaque", "transparent"])
        .optional()
        .describe(
          "Background mode when supported by the selected image model (defaults to auto). Transparent is most likely not what you want, check the imagegen skill to know how to generate transparent images",
        ),
      output_format: OutputFormat.optional().describe("Output image format (defaults to png)"),
      output_compression: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Compression level for jpeg/webp outputs, 0-100"),
      moderation: z.enum(["auto", "low"]).optional().describe("Image moderation strictness (defaults to auto)"),
    })
    .refine((params) => !(params.reference_image !== undefined && params.reference_images !== undefined), {
      message: "Use reference_images instead of reference_image when providing multiple reference images",
    }),
  async execute(params, ctx) {
    const refs = params.reference_images ?? (params.reference_image === undefined ? [] : [params.reference_image])
    const images: string[] = []
    // Preserve input and permission-request order for local references.
    for (const value of refs) images.push(await reference(value, ctx))
    const headers = await codexAuthHeaders()
    headers.set("content-type", "application/json")

    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers,
      signal: ctx.abort,
      body: JSON.stringify({
        model: ORCHESTRATOR_MODEL,
        instructions: "You generate images by calling the image_generation tool. Do not answer with text only.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${images.length ? `Use the provided reference image${images.length > 1 ? "s in their supplied order" : ""} to create exactly one image` : "Generate exactly one image"} for this prompt using the image_generation tool. Prompt: ${params.prompt}`,
              },
              ...images.map((image) => ({
                type: "input_image",
                image_url: image,
              })),
            ],
          },
        ],
        tools: [
          {
            type: "image_generation",
            model: params.model || "gpt-image-2",
            size: params.size || "auto",
            quality: params.quality || "auto",
            background: params.background || "auto",
            output_format: params.output_format || "png",
            output_compression: params.output_compression ?? 100,
            moderation: params.moderation || "auto",
            ...(params.input_fidelity ? { input_fidelity: params.input_fidelity } : {}),
          },
        ],
        tool_choice: "auto",
        stream: true,
        store: false,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Image generation request failed (${response.status}): ${text || response.statusText}`)
    }

    const item = await collectImage(response)
    const bytes = Buffer.from(item.result!.trim(), "base64")
    const outputFormat = params.output_format || "png"
    const mime = `image/${outputFormat === "jpeg" ? "jpeg" : outputFormat}`
    const callID = safeName(item.id || ctx.callID, "generated_image")
    const sessionID = safeName(ctx.sessionID, "session")
    const filepath = path.join(Global.Path.data, "generated_images", sessionID, `${callID}.${outputFormat}`)
    await Filesystem.write(filepath, bytes)

    const filename = path.basename(filepath)
    const file = {
      path: filepath,
      mime,
      prompt: params.prompt,
      revisedPrompt: item.revised_prompt,
      model: params.model || "gpt-image-2",
      shortName: params.short_name,
    }
    return {
      title: params.short_name,
      metadata: { files: [file], truncated: false },
      output: [
        `Generated image: ${filepath}`,
        item.revised_prompt ? `Revised prompt: ${item.revised_prompt}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      attachments: [
        {
          type: "file" as const,
          mime,
          filename,
          url: `data:${mime};base64,${item.result!.trim()}`,
        },
      ],
    }
  },
})

import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import { codexAuthHeaders } from "../plugin/codex"

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
        if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call" && event.item.result) {
          found = event.item
        }
      }
    }
    if (done) break
  }

  for (const event of parseSSE(pending) as Array<{ type?: string; item?: ImageItem }>) {
    if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call" && event.item.result) {
      found = event.item
    }
  }

  if (!found) throw new Error("The model did not return an image_generation_call result")
  if (!found.result) throw new Error("Image generation completed without image bytes")
  return found
}

export const ImageGenerateTool = Tool.define("image_generate", {
  description:
    "Generate an image from a text prompt using the OpenAI Codex/ChatGPT image generation tool. Requires OpenAI ChatGPT Pro/Plus OAuth auth.",
  parameters: z.object({
    prompt: z.string().describe("Detailed image prompt describing the desired image"),
    short_name: z.string().describe("Short human-readable name shown for this image in the Generated images sidebar"),
    model: z.enum(["gpt-image-2", "gpt-image-1.5"]).optional().describe("Image generation model (defaults to gpt-image-2)"),
    size: z.string().optional().describe("Image size, such as auto, 1024x1024, 1536x1024, 1024x1536, or another supported WIDTHxHEIGHT value"),
    quality: z.enum(["auto", "low", "medium", "high"]).optional().describe("Image quality (defaults to auto)"),
    background: z.enum(["auto", "opaque", "transparent"]).optional().describe("Background mode when supported by the selected image model (defaults to auto)"),
    output_format: OutputFormat.optional().describe("Output image format (defaults to png)"),
    output_compression: z.number().int().min(0).max(100).optional().describe("Compression level for jpeg/webp outputs, 0-100"),
    moderation: z.enum(["auto", "low"]).optional().describe("Image moderation strictness (defaults to auto)"),
  }),
  async execute(params, ctx) {
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
                text: `Generate exactly one image for this prompt using the image_generation tool. Prompt: ${params.prompt}`,
              },
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
      output: [`Generated image: ${filepath}`, item.revised_prompt ? `Revised prompt: ${item.revised_prompt}` : undefined]
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

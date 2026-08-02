import { describe, expect, test } from "bun:test"
import path from "path"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ImageGenerateTool } from "../../src/tool/image"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1qwAAAABJRU5ErkJggg==",
  "base64",
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

async function auth(fn: () => Promise<void>) {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "refresh",
    access: "access",
    expires: Date.now() + 60_000,
  })
  try {
    await fn()
  } finally {
    await Auth.remove("openai")
  }
}

async function intercept(
  mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch
  globalThis.fetch = mock as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

function response() {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        id: "image",
        type: "image_generation_call",
        result: "AQID",
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

describe("tool.image", () => {
  test("describes mutually exclusive reference arguments", async () => {
    const tool = await ImageGenerateTool.init()
    expect(tool.parameters.shape.reference_image.description).toContain("Do not provide with reference_images")
    expect(tool.parameters.shape.reference_images.description).toContain("Do not provide with reference_image")
  })

  test("sends an extensionless local reference image as an input", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => Bun.write(path.join(dir, "source"), png),
    })
    let body: unknown

    await auth(async () => {
      await intercept(
        async (_input, init) => {
          body = JSON.parse(init?.body as string)
          return response()
        },
        async () => {
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const tool = await ImageGenerateTool.init()
              await tool.execute(
                {
                  prompt: "Make the background blue",
                  short_name: "edited",
                  reference_image: "source",
                },
                ctx,
              )
            },
          })
        },
      )
    })

    expect(body).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: expect.stringContaining("Use the provided reference image") },
            { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
          ],
        },
      ],
      tools: [{ type: "image_generation" }],
    })
    expect(body).not.toHaveProperty("tools.0.action")
  })

  test("allows reference-image fidelity to be overridden", async () => {
    let body: unknown

    await auth(async () => {
      await intercept(
        async (_input, init) => {
          body = JSON.parse(init?.body as string)
          return response()
        },
        async () => {
          const tool = await ImageGenerateTool.init()
          await tool.execute(
            {
              prompt: "Make the background blue",
              short_name: "edited-low-fidelity",
              reference_image: `data:image/png;base64,${png.toString("base64")}`,
              input_fidelity: "low",
            },
            ctx,
          )
        },
      )
    })

    expect(body).toMatchObject({
      tools: [{ type: "image_generation", input_fidelity: "low" }],
    })
  })

  test("keeps generation requests free of edit inputs", async () => {
    let body: unknown

    await auth(async () => {
      await intercept(
        async (_input, init) => {
          body = JSON.parse(init?.body as string)
          return response()
        },
        async () => {
          const tool = await ImageGenerateTool.init()
          await tool.execute(
            {
              prompt: "A ceramic coffee mug",
              short_name: "mug",
            },
            ctx,
          )
        },
      )
    })

    expect(body).toMatchObject({
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: expect.stringContaining("Generate exactly one image") }],
        },
      ],
      tools: [{ type: "image_generation" }],
    })
    expect(body).not.toHaveProperty("tools.0.action")
  })

  test("passes HTTPS and data URL references through", async () => {
    const bodies: unknown[] = []

    await auth(async () => {
      await intercept(
        async (_input, init) => {
          bodies.push(JSON.parse(init?.body as string))
          return response()
        },
        async () => {
          const tool = await ImageGenerateTool.init()
          await tool.execute(
            {
              prompt: "Make the sky orange",
              short_name: "url",
              reference_image: "https://example.com/source.png",
            },
            ctx,
          )
          await tool.execute(
            {
              prompt: "Make the sky purple",
              short_name: "data",
              reference_image: `data:image/png;base64,${png.toString("base64")}`,
            },
            ctx,
          )
        },
      )
    })

    expect(bodies).toMatchObject([
      {
        input: [
          { content: [{ type: "input_text" }, { type: "input_image", image_url: "https://example.com/source.png" }] },
        ],
      },
      {
        input: [
          {
            content: [
              { type: "input_text" },
              { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
            ],
          },
        ],
      },
    ])
  })

  test("sends multiple references in supplied order", async () => {
    let body: unknown

    await auth(async () => {
      await intercept(
        async (_input, init) => {
          body = JSON.parse(init?.body as string)
          return response()
        },
        async () => {
          const tool = await ImageGenerateTool.init()
          await tool.execute(
            {
              prompt: "Use Image 1 for the subject and Image 2 for the palette",
              short_name: "combined",
              reference_images: ["https://example.com/subject.png", `data:image/png;base64,${png.toString("base64")}`],
            },
            ctx,
          )
        },
      )
    })

    expect(body).toMatchObject({
      input: [
        {
          content: [
            { type: "input_text", text: expect.stringContaining("reference images in their supplied order") },
            { type: "input_image", image_url: "https://example.com/subject.png" },
            { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
          ],
        },
      ],
    })
  })

  test("rejects both reference arguments", async () => {
    const tool = await ImageGenerateTool.init()
    await expect(
      tool.execute(
        {
          prompt: "Combine the references",
          short_name: "invalid-refs",
          reference_image: "https://example.com/one.png",
          reference_images: ["https://example.com/two.png"],
        },
        ctx,
      ),
    ).rejects.toThrow("Use reference_images instead of reference_image")
  })

  test("rejects unsupported local reference formats", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => Bun.write(path.join(dir, "source"), "not an image"),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageGenerateTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Make the background blue",
              short_name: "invalid",
              reference_image: "source",
            },
            ctx,
          ),
        ).rejects.toThrow("Reference image must be a PNG, JPEG, GIF, or WebP file")
      },
    })
  })

  test("rejects malformed data URL references", async () => {
    const tool = await ImageGenerateTool.init()
    await expect(
      tool.execute(
        {
          prompt: "Make the background blue",
          short_name: "invalid-data",
          reference_image: "data:image/png;base64,!!!!",
        },
        ctx,
      ),
    ).rejects.toThrow("Reference image must be a PNG, JPEG, GIF, or WebP data URL")
  })

  test("requests permissions for external local references", async () => {
    await using tmp = await tmpdir()
    await using ref = await tmpdir({
      init: async (dir) =>
        Promise.all([Bun.write(path.join(dir, "first"), png), Bun.write(path.join(dir, "second"), png)]),
    })
    const asks: string[] = []
    const context: Tool.Context = {
      ...ctx,
      ask: async (input) => {
        asks.push(input.permission)
      },
    }

    await auth(async () => {
      await intercept(
        async () => response(),
        async () => {
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const tool = await ImageGenerateTool.init()
              await tool.execute(
                {
                  prompt: "Make the background blue",
                  short_name: "external",
                  reference_images: [path.join(ref.path, "first"), path.join(ref.path, "second")],
                },
                context,
              )
            },
          })
        },
      )
    })

    expect(asks).toEqual(["external_directory", "read", "external_directory", "read"])
  })

  test("requests external access before inspecting a reference", async () => {
    await using tmp = await tmpdir()
    await using ref = await tmpdir()
    const asks: string[] = []
    const context: Tool.Context = {
      ...ctx,
      ask: async (input) => {
        asks.push(input.permission)
        throw new Error("denied")
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageGenerateTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Make the background blue",
              short_name: "denied",
              reference_image: path.join(ref.path, "missing"),
            },
            context,
          ),
        ).rejects.toThrow("denied")
      },
    })

    expect(asks).toEqual(["external_directory"])
  })
})

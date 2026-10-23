import { describe, expect, test } from "bun:test"
import { image } from "../../../src/cli/cmd/tui/routes/session/image"

describe("image presentation", () => {
  test("native completion shows actual fields without exposing the enriched result", () => {
    const view = image(
      {
        revised_prompt: "A detailed\nlandscape with a river",
        action: "generate",
        background: "opaque",
        output_format: "png",
        quality: "high",
        size: "1536x1024",
        result: "INPUT_BYTES",
      },
      {
        native: { result: "NATIVE_BYTES".repeat(10000) },
        files: [{ path: "/tmp/river.png", shortName: "River", revisedPrompt: "A detailed\nlandscape with a river" }],
      },
      "River valley",
    )
    expect(view).toEqual({
      title: "Image generation: River valley",
      prompt: undefined,
      request: undefined,
      revised: ["A detailed\nlandscape with a river"],
      settings: ["Action: generate", "Background: opaque", "Format: png", "Quality: high", "Size: 1536x1024"],
      refs: [],
      files: ["/tmp/river.png"],
    })
    expect(JSON.stringify(view)).not.toContain("BYTES")
  })

  test("preserves local parameters, prompt and ordered references without displaying embedded bytes", () => {
    const input = {
      prompt: "Original prompt",
      short_name: "Local image",
      model: "gpt-image-2.5-flare",
      background: "transparent",
      quality: "medium",
      size: "auto",
      output_format: "webp",
      output_compression: 0,
      moderation: "low",
      reference_images: [
        "/tmp/reference.png",
        "data:image/png;base64,REFERENCE_BYTES",
        "https://example.com/image.png",
      ],
    }
    const view = image(input, { files: [{ path: "/tmp/image.webp", revisedPrompt: "Revised prompt" }] })
    expect(view.title).toBe("Image generation: Local image")
    expect(view.prompt).toBe("Original prompt")
    expect(view.revised).toEqual(["Revised prompt"])
    expect(view.settings).toEqual([
      "Model: gpt-image-2.5-flare",
      "Background: transparent",
      "Format: webp",
      "Quality: medium",
      "Size: auto",
      "Compression: 0",
      "Moderation: low",
    ])
    expect(view.refs).toEqual(["/tmp/reference.png", "Embedded image", "https://example.com/image.png"])
    expect(JSON.stringify(view)).not.toContain("REFERENCE_BYTES")
    expect(input.reference_images[1]).toContain("REFERENCE_BYTES")
  })

  test("running title and completed file names provide short titles", () => {
    expect(image({}, { title: "Running name" }).title).toBe("Image generation: Running name")
    expect(image({}, { files: [{ shortName: "File name" }] }).title).toBe("Image generation: File name")
    expect(image({}, {}).title).toBe("Image generation")
  })

  test("file prompt metadata retains original and distinct revised prompts", () => {
    expect(
      image(
        {},
        {
          files: [
            { path: "/tmp/one.png", prompt: "Original", revisedPrompt: "First revision" },
            { path: "/tmp/two.png", revisedPrompt: "Second revision" },
          ],
        },
      ),
    ).toMatchObject({
      prompt: "Original",
      revised: ["First revision", "Second revision"],
      files: ["/tmp/one.png", "/tmp/two.png"],
    })
  })

  test("malformed metadata and unknown fields are not stringified", () => {
    for (const files of [null, {}, "invalid", [null, 42, { path: false, revisedPrompt: {} }]]) {
      expect(image({ quality: {}, result: "BYTES" }, { files, native: { result: "BYTES" } })).toEqual({
        title: "Image generation",
        prompt: undefined,
        request: undefined,
        revised: [],
        settings: [],
        refs: [],
        files: [],
      })
    }
  })

  test("optional settings stay absent and a single embedded reference is redacted", () => {
    expect(image({ reference_image: "data:image/png;base64,BYTES" }, {})).toMatchObject({
      settings: [],
      refs: ["Embedded image"],
    })
  })

  test("never reads native results or unlisted input fields", () => {
    expect(
      image(
        {
          revised_prompt: "Safe prompt",
          get result() {
            throw new Error("Image bytes must not be read")
          },
        },
        {
          get native() {
            throw new Error("Native output must not be read")
          },
        },
      ).revised,
    ).toEqual(["Safe prompt"])
  })

  test("shows the requested prompt until a provider prompt becomes available", () => {
    const metadata = { request: "Draw a red fox", title: "Red Fox" }
    expect(image({}, metadata)).toMatchObject({
      title: "Image generation: Red Fox",
      request: "Draw a red fox",
      prompt: undefined,
      revised: [],
    })
    expect(image({ prompt: "Original provider prompt" }, metadata)).toMatchObject({
      prompt: "Original provider prompt",
      request: undefined,
    })
    expect(image({ revised_prompt: "A red fox on white" }, metadata)).toMatchObject({
      request: undefined,
      revised: ["A red fox on white"],
    })
  })
})

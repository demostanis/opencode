import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { NativeImage } from "../../src/session/native-image"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const spies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore())
})

function stream(text: string | Promise<string>) {
  const spy = spyOn(LLM, "stream").mockResolvedValue({
    text: Promise.resolve(text),
  } as Awaited<ReturnType<typeof LLM.stream>>)
  spies.push(spy)
  return spy
}

async function fixture(fn: (input: LLM.StreamInput) => Promise<void>) {
  await using tmp = await tmpdir({
    config: {
      lightweight_model: "native-image/canvas",
      small_model: "native-image/canvas",
      agent: { title: { model: "native-image/caption" } },
      provider: {
        "native-image": {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "test", baseURL: "http://127.0.0.1:1/v1" },
          models: { canvas: { name: "Canvas" }, caption: { name: "Caption" } },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel(ProviderID.make("native-image"), ModelID.make("canvas"))
      const agent = await Agent.get("build")
      const session = SessionID.descending()
      await fn({
        sessionID: session,
        model,
        agent,
        user: {
          id: MessageID.ascending(),
          sessionID: session,
          role: "user",
          time: { created: 0 },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
        },
        messages: [],
        system: ["Do not forward this system prompt"],
        tools: {},
        abort: new AbortController().signal,
      })
    },
  })
}

describe("session.native-image.fields", () => {
  test("keeps only whitelisted raw string fields without rewriting them", () => {
    const fields = {
      action: "generate",
      prompt: "  A red fox\nunder the moon  ",
      revised_prompt: "A fox in moonlight",
      background: "transparent",
      output_format: "png",
      quality: "high",
      size: "1024x1024",
      model: "image-model",
    }
    expect(
      NativeImage.fields({
        ...fields,
        id: "ig_1",
        type: "image_generation_call",
        status: "completed",
        result: "IMAGE_BYTES",
        partial_image_b64: "PARTIAL_BYTES",
        metadata: { result: "NESTED_BYTES" },
      }),
    ).toEqual(fields)
    expect(NativeImage.fields({ prompt: "", unknown: "discard" })).toEqual({ prompt: "" })
  })

  test.each(
    [null, undefined, "image", 42, [], { prompt: 42 }, { quality: null }, { size: {} }].map((value) => [value]),
  )("returns empty fields for malformed input %j", (value) => {
    expect(NativeImage.fields(value)).toEqual({})
  })
})

describe("session.native-image.parse", () => {
  test.each(["response.output_item.added", "response.output_item.done"])(
    "parses %s without retaining image bytes or extra event fields",
    (type) => {
      expect(
        NativeImage.parse({
          type,
          result: "EVENT_BYTES",
          output_index: 2,
          item: {
            id: "ig_1",
            type: "image_generation_call",
            prompt: "A lighthouse",
            revised_prompt: "A lighthouse at sunset",
            output_format: "webp",
            result: "IMAGE_BYTES",
            partial_image_b64: "PARTIAL_BYTES",
            data: new Uint8Array([1, 2, 3]),
            metadata: { result: "NESTED_BYTES" },
          },
        }),
      ).toEqual({
        id: "ig_1",
        fields: {
          prompt: "A lighthouse",
          revised_prompt: "A lighthouse at sunset",
          output_format: "webp",
        },
      })
    },
  )

  test("accepts an image item with no optional fields", () => {
    expect(
      NativeImage.parse({ type: "response.output_item.added", item: { id: "ig_1", type: "image_generation_call" } }),
    ).toEqual({ id: "ig_1", fields: {} })
  })

  test.each(
    [
      null,
      undefined,
      [],
      "event",
      {},
      { type: "response.output_item.done" },
      { type: "response.output_item.done", item: null },
      { type: "response.output_item.done", item: { id: "ws_1", type: "web_search_call" } },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", item: { id: "ig_1", type: "image_generation_call" } },
      { type: "response.image_generation_call.partial_image", item: { id: "ig_1", type: "image_generation_call" } },
      { type: "response.output_item.done", item: { type: "image_generation_call" } },
      { type: "response.output_item.done", item: { id: 1, type: "image_generation_call" } },
      { type: "response.output_item.done", item: { id: "ig_1", type: "image_generation_call", prompt: [] } },
    ].map((value) => [value]),
  )("rejects nonimage or malformed events %j", (value) => {
    expect(NativeImage.parse(value)).toBeUndefined()
  })
})

describe("session.native-image.label", () => {
  test.each([
    [undefined, undefined],
    ["", undefined],
    [" \n\t\n", undefined],
    ["<think>Only reasoning\nNo label</think>", undefined],
    ["<think>First\nthought</think>\n<think>Second thought</think>\n  'Moonlit Fox'  \nCommentary", "Moonlit Fox"],
    ['\n\n""\n  ```\n  `Coastal Lighthouse`\nAnother label', "Coastal Lighthouse"],
    ['  "Fox\'s Forest"  ', "Fox's Forest"],
    ["x".repeat(61), "x".repeat(60)],
    ["x".repeat(60), "x".repeat(60)],
  ])("cleans and caps %j", (value, expected) => {
    expect(NativeImage.label(value)).toBe(expected)
  })
})

describe("session.native-image.request", () => {
  test("uses the latest user text without treating image bytes or assistant text as the prompt", () => {
    expect(
      NativeImage.request([
        { role: "user", content: "An old request" },
        {
          role: "user",
          content: [
            { type: "image", image: "data:image/png;base64,IMAGE_BYTES" },
            { type: "text", text: "Edit the fox." },
            { type: "text", text: "Make it blue." },
          ],
        },
        { role: "assistant", content: "I will edit it now." },
        { role: "user", content: [{ type: "image", image: "data:image/png;base64,REPLAY_BYTES" }] },
        { role: "user", content: "  " },
      ]),
    ).toBe("Edit the fox.\nMake it blue.")
    expect(NativeImage.request([])).toBeUndefined()
    expect(NativeImage.request([{ role: "assistant", content: "Not a user prompt" }])).toBeUndefined()
  })
})

describe("session.native-image.name", () => {
  test("uses the title agent model ahead of lightweight and small models", async () => {
    await fixture(async (input) => {
      const lookup = spyOn(Provider, "getLightweightModel")
      spies.push(lookup)
      const title = await Agent.get("title")
      const spy = stream('<think>Choose a short label</think>\n"Moonlit Fox"\nExtra commentary')
      input.messages = [{ role: "user", content: "Draw a fox" }]

      expect(await NativeImage.name(input, "The blue variant", 2, new AbortController().signal)).toBe("Moonlit Fox")
      expect(lookup).not.toHaveBeenCalled()
      expect(spy).toHaveBeenCalledTimes(1)
      const request = spy.mock.calls[0][0]
      expect(request.model).toBe(await Provider.getModel(ProviderID.make("native-image"), ModelID.make("caption")))
      expect(request.model).not.toBe(input.model)
      expect(request.user).toBe(input.user)
      expect(request.sessionID).toBe(input.sessionID)
      expect(request.small).toBe(true)
      expect(request.tools).toEqual({})
      expect(request.toolChoice).toBe("none")
      expect(request.system).toEqual([])
      expect(request.agent.prompt).toContain("Do not claim to have seen the image")
      expect(request.agent).toEqual({ ...title, prompt: request.agent.prompt })
      expect(request.messages).toEqual([
        {
          role: "user",
          content:
            "Conversation:\nuser: Draw a fox\nAssistant's current description:\nThe blue variant\nImage number in this response: 2",
        },
      ])
    })
  })

  test("passes only user and assistant text, never image, file, reasoning, or tool payloads", async () => {
    await fixture(async (input) => {
      const spy = stream("Blue Fox")
      input.messages = [
        { role: "system", content: "SYSTEM_SECRET" },
        { role: "user", content: "Draw two fox variants" },
        {
          role: "user",
          content: [
            { type: "text", text: "Use this reference" },
            { type: "image", image: "data:image/png;base64,IMAGE_BYTES" },
            { type: "file", data: "FILE_BYTES", mediaType: "image/png" },
            { type: "text", text: "Make the second blue" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "REASONING_SECRET" },
            { type: "text", text: "Preparing the blue variant" },
            { type: "tool-call", toolCallId: "ig_1", toolName: "image_generation", input: { result: "TOOL_BYTES" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "ig_1",
              toolName: "image_generation",
              output: { type: "text", value: "RESULT_BYTES" },
            },
          ],
        },
        { role: "user", content: [{ type: "image", image: new Uint8Array([1, 2, 3]) }] },
      ]
      expect(await NativeImage.name(input, "Blue fox on snow", 2, new AbortController().signal)).toBe("Blue Fox")
      expect(spy.mock.calls[0][0].messages).toEqual([
        {
          role: "user",
          content:
            "Conversation:\nuser: Draw two fox variants\nuser: Use this reference\nMake the second blue\nassistant: Preparing the blue variant\nAssistant's current description:\nBlue fox on snow\nImage number in this response: 2",
        },
      ])
    })
  })

  test("keeps only the last six nonempty text messages", async () => {
    await fixture(async (input) => {
      const spy = stream("Fox")
      input.messages = Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `Variant ${index}` }))
      input.messages.push({ role: "assistant", content: "" })
      await NativeImage.name(input, "Latest variant", 8, new AbortController().signal)
      expect(spy.mock.calls[0][0].messages).toEqual([
        {
          role: "user",
          content:
            "Conversation:\nuser: Variant 2\nuser: Variant 3\nuser: Variant 4\nuser: Variant 5\nuser: Variant 6\nuser: Variant 7\nAssistant's current description:\nLatest variant\nImage number in this response: 8",
        },
      ])
    })
  })

  test("bounds conversation to its last 12000 characters and description to its last 4000", async () => {
    await fixture(async (input) => {
      const spy = stream("Fox")
      input.messages = [{ role: "user", content: `OLD_CONVERSATION${"u".repeat(12000)}` }]
      await NativeImage.name(input, `OLD_DESCRIPTION${"d".repeat(4000)}`, 3, new AbortController().signal)
      expect(spy.mock.calls[0][0].messages).toEqual([
        {
          role: "user",
          content: `Conversation:\n${"u".repeat(12000)}\nAssistant's current description:\n${"d".repeat(4000)}\nImage number in this response: 3`,
        },
      ])
    })
  })

  test.each(["supplied", "input"])("propagates the %s abort signal to an in-flight stream", async (source) => {
    await fixture(async (input) => {
      const controller = new AbortController()
      input.abort = source === "input" ? controller.signal : input.abort
      const ready = Promise.withResolvers<AbortSignal>()
      const spy = spyOn(LLM, "stream").mockImplementation(async (request) => {
        ready.resolve(request.abort)
        return {
          text: new Promise<string>((_, reject) => {
            request.abort.addEventListener("abort", () => reject(request.abort.reason), { once: true })
          }),
        } as Awaited<ReturnType<typeof LLM.stream>>
      })
      spies.push(spy)
      const pending = NativeImage.name(
        input,
        "Fox",
        1,
        source === "supplied" ? controller.signal : new AbortController().signal,
      )
      const signal = await ready.promise
      expect(signal.aborted).toBe(false)
      const reason = new Error("Naming cancelled")
      controller.abort(reason)
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBe(reason)
      expect(await pending).toBeUndefined()
    })
  })

  test("forwards an already-aborted supplied signal", async () => {
    await fixture(async (input) => {
      const spy = stream("unused")
      spy.mockImplementation(async (request) => {
        request.abort.throwIfAborted()
        throw new Error("Expected an aborted signal")
      })
      const reason = new Error("Already cancelled")
      expect(await NativeImage.name(input, "Fox", 1, AbortSignal.abort(reason))).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].abort.reason).toBe(reason)
    })
  })

  test.each(["", " \n\t", "<think>No usable label</think>"])("falls back for empty label %j", async (text) => {
    await fixture(async (input) => {
      stream(text)
      expect(await NativeImage.name(input, "Fox", 1, new AbortController().signal)).toBeUndefined()
    })
  })

  test("caps the generated name at 60 characters", async () => {
    await fixture(async (input) => {
      stream(`\n"${"f".repeat(80)}"\nCommentary`)
      expect(await NativeImage.name(input, "Fox", 1, new AbortController().signal)).toBe("f".repeat(60))
    })
  })

  test.each(["lookup", "agent", "stream", "text"])("falls back on a %s error", async (stage) => {
    await fixture(async (input) => {
      const spy = stream("unused")
      const error = new Error("Naming failed")
      if (stage === "lookup") spies.push(spyOn(Provider, "getModel").mockRejectedValue(error))
      if (stage === "agent") spies.push(spyOn(Agent, "get").mockRejectedValue(error))
      if (stage === "stream") spy.mockRejectedValue(error)
      if (stage === "text") {
        spy.mockImplementation(async () => ({ text: Promise.reject(error) }) as Awaited<ReturnType<typeof LLM.stream>>)
      }
      expect(await NativeImage.name(input, "Fox", 1, new AbortController().signal)).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(stage === "lookup" || stage === "agent" ? 0 : 1)
    })
  })

  test("skips the stream when the title agent is unavailable", async () => {
    await fixture(async (input) => {
      const spy = stream("unused")
      spies.push(spyOn(Agent, "get").mockResolvedValue(undefined!))
      expect(await NativeImage.name(input, "Fox", 1, new AbortController().signal)).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
    })
  })

  test.each([true, false])("uses the session-title fallback when small model exists=%s", async (small) => {
    await fixture(async (input) => {
      const agent = await Agent.get("title")
      const caption = await Provider.getModel(ProviderID.make("native-image"), ModelID.make("caption"))
      spies.push(spyOn(Agent, "get").mockResolvedValue({ ...agent, model: undefined }))
      const lookup = spyOn(Provider, "getSmallModel").mockResolvedValue(small ? caption : undefined)
      spies.push(lookup)
      const spy = stream("Red Circle")
      expect(await NativeImage.name(input, "Red circle", 1, new AbortController().signal)).toBe("Red Circle")
      expect(lookup).toHaveBeenCalledWith(input.model.providerID)
      expect(spy.mock.calls[0][0].model).toBe(small ? caption : input.model)
    })
  })
})

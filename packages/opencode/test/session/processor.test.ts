import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { PermissionNext } from "../../src/permission"
import { Global } from "../../src/global"
import path from "path"
import { fileURLToPath } from "url"
import { rm } from "fs/promises"
import { NativeImage } from "../../src/session/native-image"

const model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test-provider"),
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test model",
  family: "test",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, input: 90_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Provider.Model

const agent = {
  name: "test",
  mode: "primary",
  ultra_mode_allowed: false,
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
} satisfies Agent.Info

const emptyResponse = [
  { type: "start-step" },
  {
    type: "finish-step",
    finishReason: "unknown",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  },
]

const textResponse = [
  { type: "start-step" },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", text: "Recovered" },
  { type: "text-end", id: "text-1" },
  {
    type: "finish-step",
    finishReason: "unknown",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
]

function fakeStream(events: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const event of events) yield event
    })(),
  } as unknown as Awaited<ReturnType<typeof LLM.stream>>
}

async function setup() {
  const session = await Session.create({})
  const user = (await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: agent.name,
    model: { providerID: model.providerID, modelID: model.id },
  } satisfies MessageV2.User)) as MessageV2.User
  const assistant = (await Session.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    role: "assistant",
    mode: agent.name,
    agent: agent.name,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: Date.now() },
    sessionID: session.id,
  })) as MessageV2.Assistant
  const abort = new AbortController().signal
  const processor = SessionProcessor.create({
    assistantMessage: assistant,
    sessionID: session.id,
    model,
    abort,
  })
  return {
    session,
    processor,
    input: {
      user,
      sessionID: session.id,
      model,
      agent,
      system: [],
      abort,
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: {},
    } satisfies LLM.StreamInput,
  }
}

afterEach(async () => {
  await resetDatabase()
})

describe("session.processor empty responses", () => {
  test("retries an empty response in the same assistant message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const responses = [emptyResponse, textResponse]
        const stream = spyOn(LLM, "stream").mockImplementation(async () => fakeStream(responses.shift()!))
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()

        try {
          const result = await fixture.processor.process(fixture.input)
          const parts = await MessageV2.parts(fixture.processor.message.id)

          expect(result).toBe("continue")
          expect(stream).toHaveBeenCalledTimes(2)
          expect(sleep).toHaveBeenCalledTimes(1)
          expect(fixture.processor.message.finish).toBe("stop")
          expect(fixture.processor.message.error).toBeUndefined()
          expect(parts.find((part) => part.type === "text")?.text).toBe("Recovered")
        } finally {
          stream.mockRestore()
          sleep.mockRestore()
          summarize.mockRestore()
        }
      },
    })
  })

  test("stops with an error after bounded empty retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const responses = [emptyResponse, emptyResponse, emptyResponse]
        const stream = spyOn(LLM, "stream").mockImplementation(async () => fakeStream(responses.shift()!))
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()

        try {
          const result = await fixture.processor.process(fixture.input)
          const messages = await Session.messages({ sessionID: fixture.session.id })

          expect(result).toBe("stop")
          expect(stream).toHaveBeenCalledTimes(3)
          expect(sleep).toHaveBeenCalledTimes(2)
          expect(fixture.processor.message.finish).toBe("error")
          expect(fixture.processor.message.error?.name).toBe("APIError")
          expect(fixture.processor.message.error?.data).toMatchObject({
            isRetryable: false,
            metadata: { reason: "empty_model_response", attempts: "3" },
          })
          expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
        } finally {
          stream.mockRestore()
          sleep.mockRestore()
          summarize.mockRestore()
        }
      },
    })
  })
})

describe("session.processor stream retries", () => {
  test("keeps retrying DNS failures until the connection recovers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const responses = [
          ...Array.from({ length: 12 }, () => [
            { type: "error", error: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }) },
          ]),
          textResponse,
        ]
        const stream = spyOn(LLM, "stream").mockImplementation(async () => fakeStream(responses.shift()!))
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()

        try {
          expect(await fixture.processor.process(fixture.input)).toBe("continue")
          expect(stream).toHaveBeenCalledTimes(13)
          expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
            2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000,
          ])
          expect(fixture.processor.message.error).toBeUndefined()
          const parts = await MessageV2.parts(fixture.processor.message.id)
          expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Recovered"])
        } finally {
          stream.mockRestore()
          sleep.mockRestore()
          summarize.mockRestore()
        }
      },
    })
  })

  test("removes partial output before retrying", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const error = new MessageV2.APIError({
          message: "stream stalled",
          isRetryable: true,
        }).toObject()
        const responses = [
          [
            { type: "start-step" },
            { type: "text-start", id: "text-stalled" },
            { type: "text-delta", id: "text-stalled", text: "Partial" },
            { type: "text-end", id: "text-stalled" },
            { type: "error", error },
          ],
          textResponse,
        ]
        const stream = spyOn(LLM, "stream").mockImplementation(async () => fakeStream(responses.shift()!))
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()

        try {
          const result = await fixture.processor.process(fixture.input)
          const parts = await MessageV2.parts(fixture.processor.message.id)

          expect(result).toBe("continue")
          expect(stream).toHaveBeenCalledTimes(2)
          expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toStrictEqual(["Recovered"])
        } finally {
          stream.mockRestore()
          sleep.mockRestore()
          summarize.mockRestore()
        }
      },
    })
  })
})

describe("session.processor native tools", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="

  test.each(["unknown", "tool-calls", "stop", undefined])(
    "persists web results without input-start and finishes native-only streams (%s)",
    async (reason) => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const fixture = await setup()
          const output = {
            action: { type: "search", query: "Bun" },
            sources: [{ type: "url", url: "https://bun.sh" }],
          }
          const events = [
            { type: "start-step" },
            ...[0, 1, 2].flatMap((id) => [
              {
                type: "tool-call",
                toolCallId: `web-${id}`,
                toolName: "websearch",
                input: {},
                providerExecuted: true,
                providerMetadata: { openai: { itemId: `item-${id}` } },
              },
              {
                type: "tool-result",
                toolCallId: `web-${id}`,
                toolName: "websearch",
                input: {},
                output,
                providerExecuted: true,
              },
            ]),
            ...(reason ? [{ ...emptyResponse[1], finishReason: reason }] : []),
          ]
          const stream = spyOn(LLM, "stream").mockResolvedValue(fakeStream(events))
          const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()
          const ask = spyOn(PermissionNext, "ask")
          try {
            await fixture.processor.process(fixture.input)
            const parts = await MessageV2.parts(fixture.processor.message.id)
            const tools = parts.filter((part) => part.type === "tool")
            expect(tools).toHaveLength(3)
            expect(tools[0]).toMatchObject({
              tool: "websearch",
              metadata: { providerExecuted: true, openai: { itemId: "item-0" } },
              state: {
                status: "completed",
                input: {},
                title: "Web search",
                output: JSON.stringify(output),
                metadata: { native: output },
              },
            })
            expect(fixture.processor.message.finish).toBe("stop")
            expect(fixture.processor.message.error).toBeUndefined()
            expect(stream).toHaveBeenCalledTimes(1)
            expect(ask).not.toHaveBeenCalled()
          } finally {
            stream.mockRestore()
            summarize.mockRestore()
            ask.mockRestore()
          }
        },
      })
    },
  )

  test.each([true, false])("saves native image bytes and attachment IDs (input-start: %s)", async (start) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const events = [
          { type: "start-step" },
          ...(start
            ? [
                {
                  type: "tool-input-start",
                  id: "image/1",
                  toolName: "image_generation",
                  providerExecuted: true,
                  providerMetadata: { openai: { itemId: "image-item" } },
                },
              ]
            : []),
          {
            type: "tool-call",
            toolCallId: "image/1",
            toolName: "image_generation",
            input: {},
            ...(!start ? { providerExecuted: true, providerMetadata: { openai: { itemId: "image-item" } } } : {}),
          },
          {
            type: "tool-result",
            toolCallId: "image/1",
            toolName: "image_generation",
            input: {},
            output: { result: png },
          },
          { ...emptyResponse[1], finishReason: "tool-calls" },
        ]
        const stream = spyOn(LLM, "stream").mockResolvedValue(fakeStream(events))
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()
        try {
          await fixture.processor.process(fixture.input)
          const parts = await MessageV2.parts(fixture.processor.message.id)
          const part = parts.find((part) => part.type === "tool")
          expect(part?.metadata).toEqual({ providerExecuted: true, openai: { itemId: "image-item" } })
          expect(part?.state.status).toBe("completed")
          if (part?.state.status !== "completed") throw new Error("Missing completed image")
          expect(part.state.metadata.native).toEqual({ result: png })
          expect(part.state.title).toBe("Generated image")
          expect(part.state.attachments).toHaveLength(1)
          const attachment = part.state.attachments![0]
          expect(attachment.id).toStartWith("prt_")
          expect(attachment.sessionID).toBe(fixture.session.id)
          expect(attachment.messageID).toBe(fixture.processor.message.id)
          expect(attachment.mime).toBe("image/png")
          const file = path.join(Global.Path.data, "generated_images", fixture.session.id, "image_1.png")
          expect(fileURLToPath(attachment.url)).toBe(file)
          expect(await Bun.file(file).bytes()).toEqual(Buffer.from(png, "base64"))
          expect(part.state.metadata.files).toEqual([{ path: file, mime: "image/png", shortName: "Generated image" }])
          expect(part.state.output).toBe(`Generated image: ${file}`)
          expect(JSON.stringify(part).split(png)).toHaveLength(2)
          expect(fixture.processor.message.finish).toBe("stop")
          expect(stream).toHaveBeenCalledTimes(1)
        } finally {
          stream.mockRestore()
          summarize.mockRestore()
          await rm(path.join(Global.Path.data, "generated_images", fixture.session.id), {
            recursive: true,
            force: true,
          })
        }
      },
    })
  })

  test.each(["Red Circle", undefined])("preserves raw image settings and names concurrently (%s)", async (name) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        fixture.input.messages = [{ role: "user", content: "Draw a red circle on white." }]
        const fields = {
          action: "generate",
          background: "opaque",
          output_format: "png",
          quality: "low",
          revised_prompt: "A single red circle centered on white.",
          size: "1254x1254",
        }
        const pending = Promise.withResolvers<string | undefined>()
        const naming = spyOn(NativeImage, "name").mockReturnValue(pending.promise)
        const stream = spyOn(LLM, "stream").mockResolvedValue({
          fullStream: (async function* () {
            yield { type: "start-step" }
            yield { type: "text-start", id: "description" }
            yield { type: "text-delta", id: "description", text: "Creating a red circle." }
            yield { type: "text-end", id: "description" }
            yield {
              type: "raw",
              rawValue: { type: "response.output_item.added", item: { id: "image/1", type: "image_generation_call" } },
            }
            yield {
              type: "tool-call",
              toolCallId: "image/1",
              toolName: "image_generation",
              input: {},
              providerExecuted: true,
            }
            expect(naming).toHaveBeenCalledTimes(1)
            expect(naming.mock.calls[0][1]).toBe("Creating a red circle.")
            expect(naming.mock.calls[0][2]).toBe(1)
            expect(fixture.processor.partFromToolCall("image/1")?.state.status).toBe("running")
            expect(fixture.processor.partFromToolCall("image/1")?.state).toMatchObject({
              input: {},
              metadata: { request: "Draw a red circle on white." },
            })
            pending.resolve(name)
            await pending.promise
            const parts = await MessageV2.parts(fixture.processor.message.id)
            const running = parts.find((part) => part.type === "tool")
            expect(running?.state.status).toBe("running")
            if (running?.state.status !== "running") throw new Error("Missing running image")
            expect(running.state.title).toBe(name)
            expect(running.state.metadata?.request).toBe("Draw a red circle on white.")
            yield {
              type: "raw",
              rawValue: {
                type: "response.output_item.done",
                item: { id: "image/1", type: "image_generation_call", result: png, ...fields },
              },
            }
            expect(fixture.processor.partFromToolCall("image/1")?.state.input).toEqual(fields)
            if (name) expect(fixture.processor.partFromToolCall("image/1")?.state).toMatchObject({ title: name })
            yield {
              type: "tool-result",
              toolCallId: "image/1",
              toolName: "image_generation",
              input: {},
              output: { result: png },
              providerExecuted: true,
            }
            yield { ...emptyResponse[1], finishReason: "stop" }
          })(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>)
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()
        try {
          await fixture.processor.process(fixture.input)
          const parts = await MessageV2.parts(fixture.processor.message.id)
          const part = parts.find((part) => part.type === "tool")
          if (part?.state.status !== "completed") throw new Error("Missing completed image")
          expect(part.state.input).toEqual(fields)
          expect(part.state.title).toBe(name ?? fields.revised_prompt)
          expect(part.state.metadata.native).toEqual({ result: png, ...fields })
          expect(part.state.metadata.files[0]).toMatchObject({
            shortName: name ?? fields.revised_prompt,
            revisedPrompt: fields.revised_prompt,
          })
          expect(JSON.stringify(part).split(png)).toHaveLength(2)
          expect(naming.mock.calls[0][3].aborted).toBe(true)
          expect(stream).toHaveBeenCalledTimes(1)
        } finally {
          naming.mockRestore()
          stream.mockRestore()
          summarize.mockRestore()
          await rm(path.join(Global.Path.data, "generated_images", fixture.session.id), {
            recursive: true,
            force: true,
          })
        }
      },
    })
  })

  test("mixed native and local calls still request a local follow-up", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await setup()
        const events = [
          { type: "start-step" },
          ...[
            { toolName: "websearch", providerExecuted: true, output: { action: { type: "search", query: "Bun" } } },
            {
              toolName: "local",
              providerExecuted: false,
              output: { title: "Local", output: "\u001b[31mok\u001b[0m", metadata: {} },
            },
          ].flatMap((tool) => [
            { type: "tool-call", toolCallId: tool.toolName, input: {}, ...tool },
            { type: "tool-result", toolCallId: tool.toolName, input: {}, ...tool },
          ]),
          emptyResponse[1],
        ]
        const stream = spyOn(LLM, "stream").mockResolvedValue(fakeStream(events))
        const summarize = spyOn(SessionSummary, "summarize").mockResolvedValue()
        try {
          await fixture.processor.process(fixture.input)
          expect(fixture.processor.message.finish).toBe("tool-calls")
          const parts = await MessageV2.parts(fixture.processor.message.id)
          expect(parts.find((part) => part.type === "tool" && part.tool === "local")).toMatchObject({
            state: { status: "completed", title: "Local", output: "ok", metadata: {} },
          })
        } finally {
          stream.mockRestore()
          summarize.mockRestore()
        }
      },
    })
  })
})

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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { MultiAgent } from "../../src/agent/multi-agent"
import { Instance } from "../../src/project/instance"
import { ModelsDev } from "../../src/provider/models"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { Collaboration } from "../../src/tool/collaboration"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  reply: () => response("child result") as Response | Promise<Response>,
  requests: [] as Array<Record<string, unknown>>,
}

function response(text: string) {
  const payload = [
    {
      type: "response.created",
      response: {
        id: "resp-agent",
        created_at: Math.floor(Date.now() / 1000),
        model: "gpt-5.6-sol",
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item-agent",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "item-agent",
      delta: text,
      logprobs: null,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "item-agent",
      },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}`)
    .concat("data: [DONE]")
    .join("\n\n")

  return new Response(payload + "\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      state.requests.push(await request.json())
      return state.reply()
    },
  })
})

beforeEach(() => {
  state.reply = () => response("child result")
  state.requests.length = 0
})

afterAll(() => {
  state.server?.stop()
})

describe("tool.collaboration", () => {
  test("spawns a background agent and returns its result through wait_agent", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const fixture = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(
      path.join(import.meta.dir, "fixtures/models-api.json"),
    )
    const source = fixture.openai.models["gpt-5.2"]
    const model = {
      ...source,
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      release_date: "2026-07-09",
    }

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: { [model.id]: model },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: ProviderID.openai,
            modelID: ModelID.make(model.id),
          },
          variant: "ultra",
        } satisfies MessageV2.User)
        const assistant = await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: user.id,
          sessionID: session.id,
          role: "assistant",
          mode: "build",
          agent: "build",
          variant: "ultra",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ModelID.make(model.id),
          providerID: ProviderID.openai,
          time: { created: Date.now() },
        } satisfies MessageV2.Assistant)
        const build = await Agent.get("build")
        const spawn = await Collaboration.SpawnAgentTool.init({ agent: build })
        const send = await Collaboration.SendMessageTool.init({ agent: build })
        const followup = await Collaboration.FollowupTaskTool.init({ agent: build })
        const wait = await Collaboration.WaitAgentTool.init({ agent: build })
        let asks = 0
        const ctx = {
          sessionID: session.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async (request: { permission: string }) => {
            expect(request.permission).toBe("task")
            asks++
          },
        }

        const started = await spawn.execute(
          {
            description: "Research child",
            prompt: "Return child result.",
            subagent_type: "general",
          },
          ctx,
        )
        const taskID = started.metadata.sessionId
        const result = await wait.execute({ task_ids: [taskID], timeout_ms: 5_000 }, ctx)
        const agents = JSON.parse(result.output) as Array<{
          task_id: string
          parent_id: string
          agent: string
          description: string
          status: string
          result?: string
        }>

        expect(agents).toEqual([
          {
            task_id: taskID,
            parent_id: session.id,
            agent: "build",
            description: "Research child",
            status: "completed",
            result: "child result",
          },
        ])
        expect(await Session.get(taskID)).toMatchObject({
          parentID: session.id,
          title: "Research child (@build agent)",
        })
        expect((await Session.messages({ sessionID: taskID }))[0]?.info).toMatchObject({
          agent: "build",
          model: { providerID: "openai", modelID: model.id },
          variant: "ultra",
        })
        expect(asks).toBe(2)
        expect(JSON.stringify(state.requests[0])).toContain("You are a delegated subagent")

        const queuedReplies = ["queued base result", "queued message result"]
        state.reply = () => response(queuedReplies.shift() ?? "unexpected queued result")
        const messaged = await spawn.execute(
          {
            description: "Queued message child",
            prompt: "Return the queued base result.",
            subagent_type: "general",
          },
          ctx,
        )
        await send.execute({ task_id: messaged.metadata.sessionId, message: "Return the queued message result." }, ctx)
        const messagedResult = await wait.execute({ task_ids: [messaged.metadata.sessionId], timeout_ms: 5_000 }, ctx)
        expect(JSON.parse(messagedResult.output)[0]).toMatchObject({
          status: "completed",
          result: "queued message result",
        })
        expect(queuedReplies).toHaveLength(0)
        expect(
          (await Session.messages({ sessionID: messaged.metadata.sessionId }))
            .filter((message) => message.info.role === "user")
            .every((message) => !("deferred" in message.info) || !message.info.deferred),
        ).toBe(true)
        expect(asks).toBe(5)

        let seen = () => {}
        const requested = new Promise<void>((resolve) => {
          seen = resolve
        })
        state.reply = async () => {
          seen()
          await Bun.sleep(250)
          return response("stale result")
        }
        const interrupted = await spawn.execute(
          {
            description: "Interrupt child",
            prompt: "Wait before responding.",
            subagent_type: "general",
          },
          { ...ctx, extra: { bypassAgentCheck: true } },
        )
        expect(asks).toBe(5)
        await requested
        SessionPrompt.cancel(session.id, "user")

        const interruptedID = interrupted.metadata.sessionId
        const stopped = await wait.execute({ task_ids: [interruptedID], timeout_ms: 5_000 }, ctx)
        expect(JSON.parse(stopped.output)[0].status).toBe("interrupted")

        state.reply = () => response("fresh result")
        await followup.execute({ task_id: interruptedID, message: "Try again." }, ctx)
        const resumed = await wait.execute({ task_ids: [interruptedID], timeout_ms: 5_000 }, ctx)
        expect(JSON.parse(resumed.output)[0]).toMatchObject({
          status: "completed",
          result: "fresh result",
        })
        expect(asks).toBe(8)

        const replies = ["initial result", "follow-up result"]
        state.reply = () => response(replies.shift() ?? "unexpected result")
        const queued = await spawn.execute(
          {
            description: "Queue follow-up",
            prompt: "Return the initial result.",
            subagent_type: "general",
          },
          ctx,
        )
        await followup.execute({ task_id: queued.metadata.sessionId, message: "Return the follow-up result." }, ctx)
        const completed = await wait.execute({ task_ids: [queued.metadata.sessionId], timeout_ms: 5_000 }, ctx)
        expect(JSON.parse(completed.output)[0]).toMatchObject({
          status: "completed",
          result: "follow-up result",
        })
        expect(replies).toHaveLength(0)
        expect(asks).toBe(11)

        let release = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        state.reply = async () => {
          await gate
          return response("held result")
        }
        const held = []
        for (let i = 1; i <= 3; i++) {
          held.push(
            await spawn.execute(
              {
                description: `Held child ${i}`,
                prompt: "Wait for release.",
                subagent_type: "general",
              },
              ctx,
            ),
          )
        }
        expect(() => Collaboration.guard(taskID)).toThrow("3 active across the session tree")
        await expect(
          spawn.execute(
            {
              description: "Rejected fourth child",
              prompt: "This should not start.",
              subagent_type: "explore",
            },
            ctx,
          ),
        ).rejects.toThrow('3 active across the session tree). Active agents: build "Held child 1"')
        release()

        const ids = held.map((item) => item.metadata.sessionId)
        let statuses: string[] = []
        do {
          const result = await wait.execute({ task_ids: ids, timeout_ms: 5_000 }, ctx)
          statuses = JSON.parse(result.output).map((item: { status: string }) => item.status)
        } while (statuses.includes("running"))
        expect(statuses).toEqual(["completed", "completed", "completed"])

        let directSeen = () => {}
        let directRelease = () => {}
        const directRequested = new Promise<void>((resolve) => {
          directSeen = resolve
        })
        const directGate = new Promise<void>((resolve) => {
          directRelease = resolve
        })
        state.reply = async () => {
          directSeen()
          await directGate
          return response("direct interaction result")
        }
        expect(() => Collaboration.guard(taskID)).not.toThrow()
        const direct = SessionPrompt.prompt({
          sessionID: taskID,
          messageID: MessageID.ascending(),
          model: {
            providerID: ProviderID.openai,
            modelID: ModelID.make(model.id),
          },
          agent: "build",
          variant: "ultra",
          tools: { bash: false },
          parts: await SessionPrompt.resolvePromptParts("Continue directly in the child session."),
        })
        await directRequested
        const directWait = wait.execute({ task_ids: [taskID], timeout_ms: 5_000 }, ctx)
        directRelease()
        await direct
        const directResult = await directWait
        const directBody = JSON.stringify(state.requests.at(-1))
        expect(directBody).toContain("You are an agent in a team of agents")
        expect(directBody).not.toContain("You are `/root`")
        expect((await Session.get(taskID)).permission).toContainEqual(MultiAgent.ROLE)
        expect(JSON.parse(directResult.output)[0]).toMatchObject({
          status: "completed",
          result: "direct interaction result",
        })
      },
    })
  })
})

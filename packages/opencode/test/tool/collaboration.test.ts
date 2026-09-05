import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Teammate } from "../../src/teammate/teammate"
import { Instance } from "../../src/project/instance"
import { ModelsDev } from "../../src/provider/models"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
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
  test("spawns a background Teammate with the coordinator agent and returns its result", async () => {
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
    const other = {
      ...model,
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
    }

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            enabled_providers: ["openai"],
            agent: {
              reviewer: {
                mode: "primary",
                description: "Reviews changes",
                ultra_mode_allowed: true,
              },
            },
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: { [model.id]: model, [other.id]: other },
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
        const session = await Session.create({ title: "Root coordination" })
        const user = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "reviewer",
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
          mode: "reviewer",
          agent: "reviewer",
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
          finish: "stop",
          time: { created: Date.now() },
        } satisfies MessageV2.Assistant)
        const reviewer = await Agent.get("reviewer")
        const spawn = await Collaboration.SpawnTeammateTool.init({ agent: reviewer })
        const send = await Collaboration.SendMessageTool.init({ agent: reviewer })
        const followup = await Collaboration.FollowupTaskTool.init({ agent: reviewer })
        const wait = await Collaboration.WaitTeammateTool.init({ agent: reviewer })
        expect(spawn.description).toContain("using the same agent mode as you")
        expect(spawn.description).toContain("separate, substantial workstream")
        expect(spawn.description).toContain("use the task tool instead")
        let asks = 0
        const ctx = {
          sessionID: session.id,
          messageID: assistant.id,
          agent: "reviewer",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async (request: { permission: string; patterns: string[] }) => {
            expect(request.permission).toBe("teammate")
            expect(request.patterns).toEqual(["reviewer"])
            asks++
          },
        }

        const started = await spawn.execute(
          {
            description: "Research child",
            prompt: "Return child result.",
          },
          ctx,
        )
        const taskID = started.metadata.sessionId
        expect(started.output).toContain("Spawned reviewer Teammate.")
        const result = await wait.execute({ task_ids: [taskID], timeout_ms: 5_000 }, ctx)
        const teammates = JSON.parse(result.output) as Array<{
          task_id: string
          parent_id: string
          coordinator_id: string
          agent: string
          description: string
          status: string
          result?: string
        }>

        expect(teammates).toEqual([
          {
            task_id: taskID,
            parent_id: session.id,
            coordinator_id: session.id,
            agent: "reviewer",
            description: "Research child",
            status: "completed",
            result: "child result",
          },
        ])
        expect(await Session.get(taskID)).toMatchObject({
          parentID: session.id,
          title: "Research child (@reviewer teammate)",
        })
        expect((await Session.messages({ sessionID: taskID }))[0]?.info).toMatchObject({
          agent: "reviewer",
          model: { providerID: "openai", modelID: model.id },
          variant: "ultra",
        })
        expect(asks).toBe(2)
        const body = JSON.stringify(state.requests[0])
        expect(body).toContain("You are a delegated Teammate")
        expect(body).toContain("same `reviewer` agent mode as the parent that spawned you")
        expect(body).toContain("Never pass your assigned workstream")
        expect(body).toContain("Use ordinary task subagents")

        let noticed = () => {}
        let open = () => {}
        let turn = 0
        const active = new Promise<void>((resolve) => {
          noticed = resolve
        })
        const inbox = new Promise<void>((resolve) => {
          open = resolve
        })
        const baseline = state.requests.length
        state.reply = async () => {
          turn++
          if (turn > 1) return response("coordinator received update")
          noticed()
          await inbox
          return response("coordinator initial result")
        }
        const coordinating = SessionPrompt.prompt({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          model: {
            providerID: ProviderID.openai,
            modelID: ModelID.make(model.id),
          },
          agent: "reviewer",
          variant: "ultra",
          tools: { bash: false },
          parts: await SessionPrompt.resolvePromptParts("Continue coordinating the team."),
        })
        await active
        const child = (await Session.messages({ sessionID: taskID })).findLast(
          (message) => message.info.role === "assistant",
        )
        if (!child || child.info.role !== "assistant") throw new Error("Missing Teammate response")
        const source = {
          ...ctx,
          sessionID: taskID,
          messageID: child.info.id,
          ask: async (request: { permission: string; patterns: string[] }) => {
            expect(request.permission).toBe("teammate")
            expect(request.patterns).toEqual(["reviewer"])
          },
        }
        const delivered = await send.execute(
          { task_id: session.id, message: "Backend contract is ready for integration." },
          source,
        )
        expect(delivered.output).toBe("Message queued for coordinator.")
        expect(state.requests).toHaveLength(baseline + 1)
        const pending = (await Session.messages({ sessionID: session.id })).findLast(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text.includes("Backend contract is ready")),
        )
        if (!pending || pending.info.role !== "user") throw new Error("Missing queued coordinator message")
        expect(pending.info).toMatchObject({
          agent: "reviewer",
          model: { providerID: "openai", modelID: model.id },
          variant: "ultra",
          tools: { bash: false },
        })
        expect(pending.info.deferred).toBeUndefined()
        const update = pending.parts.find((part) => part.type === "text")?.text ?? ""
        expect(update).toContain(`sender_session_id: ${taskID}`)
        expect(update).toContain("sender_agent: reviewer")
        expect(update).toContain(`sender_message_id: ${child.info.id}`)
        expect(update).toContain("sender_workstream: Research child")
        expect(update).toContain("Backend contract is ready for integration.")
        open()
        await coordinating
        expect(state.requests).toHaveLength(baseline + 2)
        expect(
          (await Session.messages({ sessionID: session.id }))
            .find((message) => message.info.role === "assistant" && message.info.parentID === pending.info.id)
            ?.parts.find((part) => part.type === "text")?.text,
        ).toBe("coordinator received update")

        const idlebase = state.requests.length
        let idlenoticed = () => {}
        let idleopen = () => {}
        const idleactive = new Promise<void>((resolve) => {
          idlenoticed = resolve
        })
        const idlegate = new Promise<void>((resolve) => {
          idleopen = resolve
        })
        state.reply = async () => {
          idlenoticed()
          await idlegate
          return response("idle coordinator received update")
        }
        let unsub = () => {}
        const idlefinished = new Promise<void>((resolve) => {
          unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
            if (event.properties.sessionID !== session.id || event.properties.status.type !== "idle") return
            unsub()
            resolve()
          })
        })
        await send.execute({ task_id: session.id, message: "Tests are ready for final review." }, source)
        await idleactive
        const idle = (await Session.messages({ sessionID: session.id })).findLast(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text.includes("Tests are ready for final review"),
            ),
        )
        if (!idle || idle.info.role !== "user") throw new Error("Missing idle coordinator message")
        expect(idle.info.deferred).toBeUndefined()
        idleopen()
        await idlefinished
        expect(state.requests).toHaveLength(idlebase + 1)
        expect(
          (await Session.messages({ sessionID: session.id }))
            .find((message) => message.info.role === "assistant" && message.info.parentID === idle.info.id)
            ?.parts.find((part) => part.type === "text")?.text,
        ).toBe("idle coordinator received update")
        ctx.messageID = (await Session.messages({ sessionID: session.id })).findLast(
          (message) => message.info.role === "assistant",
        )!.info.id

        const queuedReplies = ["queued base result", "queued message result"]
        const receiving = Promise.withResolvers<void>()
        const received = Promise.withResolvers<void>()
        state.reply = async () => {
          const text = queuedReplies.shift() ?? "unexpected queued result"
          receiving.resolve()
          await received.promise
          return response(text)
        }
        const messaged = await spawn.execute(
          {
            description: "Queued message child",
            prompt: "Return the queued base result.",
          },
          ctx,
        )
        await receiving.promise
        await send.execute({ task_id: messaged.metadata.sessionId, message: "Return the queued message result." }, ctx)
        received.resolve()
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
        const ready = Promise.withResolvers<void>()
        let count = 0
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        state.reply = async () => {
          if (++count === Teammate.MAX) ready.resolve()
          await gate
          return response("held result")
        }
        const held = []
        for (let i = 1; i <= Teammate.MAX; i++) {
          held.push(
            await spawn.execute(
              {
                description: `Held child ${i}`,
                prompt: "Wait for release.",
              },
              ctx,
            ),
          )
        }
        expect(() => Collaboration.guard(taskID)).toThrow("10 active across the session tree")
        await expect(
          spawn.execute(
            {
              description: "Rejected eleventh child",
              prompt: "This should not start.",
            },
            ctx,
          ),
        ).rejects.toThrow('10 active across the session tree). Active Teammates: reviewer "Held child 1"')
        await ready.promise

        const controller = new AbortController()
        const caller = (await Session.messages({ sessionID: held[2].metadata.sessionId })).findLast(
          (message) => message.info.role === "assistant",
        )!
        const unrelated = wait
          .execute(
            { task_ids: [held[1].metadata.sessionId], timeout_ms: 60_000 },
            {
              ...ctx,
              sessionID: held[2].metadata.sessionId,
              messageID: caller.info.id,
              abort: controller.signal,
            },
          )
          .then(
            () => "woke",
            (err: Error) => err.message,
          )
        const authorized = Promise.withResolvers<void>()
        const waiting = wait.execute(
          { task_ids: [held[0].metadata.sessionId], timeout_ms: 60_000 },
          {
            ...ctx,
            abort: AbortSignal.timeout(2_000),
            ask: async () => authorized.resolve(),
          },
        )
        await authorized.promise
        await send.execute({ task_id: session.id, message: "Progress while you are waiting." }, source)
        expect(JSON.parse((await waiting).output)[0].status).toBe("running")

        // A message queued before wait starts must also prevent blocking.
        const unread = await wait.execute(
          { task_ids: [held[0].metadata.sessionId], timeout_ms: 60_000 },
          { ...ctx, abort: AbortSignal.timeout(2_000) },
        )
        expect(JSON.parse(unread.output)[0].status).toBe("running")

        const recipient = held[0].metadata.sessionId
        const latest = (await Session.messages({ sessionID: recipient })).findLast(
          (message) => message.info.role === "assistant",
        )!
        await followup.execute({ task_id: recipient, message: "Follow-up after the current work." }, source)
        const listening = Promise.withResolvers<void>()
        const incoming = wait.execute(
          { task_ids: [held[1].metadata.sessionId], timeout_ms: 60_000 },
          {
            ...ctx,
            sessionID: recipient,
            messageID: latest.info.id,
            abort: AbortSignal.timeout(2_000),
            ask: async () => listening.resolve(),
          },
        )
        await listening.promise
        await send.execute({ task_id: recipient, message: "Peer update while you are waiting." }, source)
        expect(JSON.parse((await incoming).output)[0].status).toBe("running")
        expect(
          (await Session.messages({ sessionID: recipient })).some((message) =>
            message.parts.some((part) => part.type === "text" && part.text === "Peer update while you are waiting."),
          ),
        ).toBe(true)
        controller.abort()
        expect(await unrelated).toBe("Teammate operation interrupted")
        release()
        await SessionPrompt.loop({ sessionID: session.id })
        ctx.messageID = (await Session.messages({ sessionID: session.id })).findLast(
          (message) => message.info.role === "assistant",
        )!.info.id

        const ids = held.map((item) => item.metadata.sessionId)
        let statuses: string[] = []
        do {
          const result = await wait.execute({ task_ids: ids, timeout_ms: 5_000 }, ctx)
          statuses = JSON.parse(result.output).map((item: { status: string }) => item.status)
        } while (statuses.includes("running"))
        expect(statuses).toEqual(Array.from({ length: Teammate.MAX }, () => "completed"))

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
          agent: "reviewer",
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
        expect(directBody).toContain("You are a Teammate running the same `reviewer` agent mode")
        expect(directBody).not.toContain("You are `/root`")
        expect((await Session.get(taskID)).permission).toContainEqual(Teammate.ROLE)
        expect(JSON.parse(directResult.output)[0]).toMatchObject({
          status: "completed",
          result: "direct interaction result",
        })

        await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: ProviderID.openai,
            modelID: ModelID.make(other.id),
          },
          variant: "medium",
        } satisfies MessageV2.User)
        const nested = await spawn.execute(
          {
            description: "Nested child",
            prompt: "Return the nested result.",
          },
          source,
        )
        const nestedResult = await wait.execute({ task_ids: [nested.metadata.sessionId], timeout_ms: 5_000 }, source)
        expect(JSON.parse(nestedResult.output)[0]).toMatchObject({
          parent_id: taskID,
          coordinator_id: session.id,
          agent: "reviewer",
          status: "completed",
        })
        expect(nested.metadata.model).toEqual({
          providerID: ProviderID.openai,
          modelID: ModelID.make(model.id),
        })
        expect(await Session.get(nested.metadata.sessionId)).toMatchObject({
          parentID: taskID,
          title: "Nested child (@reviewer teammate)",
        })
        expect((await Session.messages({ sessionID: nested.metadata.sessionId }))[0]?.info).toMatchObject({
          agent: "reviewer",
          model: { providerID: "openai", modelID: model.id },
          variant: "ultra",
        })
      },
    })
  })

  test("rejects Teammate spawning when the agent disallows Ultra", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          reviewer: { mode: "primary" },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Denied coordination" })
        const user = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "reviewer",
          model: { providerID: ProviderID.openai, modelID: ModelID.make("gpt-5.6-sol") },
          variant: "ultra",
        } satisfies MessageV2.User)
        const assistant = await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: user.id,
          sessionID: session.id,
          role: "assistant",
          mode: "reviewer",
          agent: "reviewer",
          variant: "ultra",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("gpt-5.6-sol"),
          providerID: ProviderID.openai,
          time: { created: Date.now() },
        } satisfies MessageV2.Assistant)
        const reviewer = await Agent.get("reviewer")
        const spawn = await Collaboration.SpawnTeammateTool.init({ agent: reviewer })
        const ctx = {
          sessionID: session.id,
          messageID: assistant.id,
          agent: "reviewer",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {
            throw new Error("Permission should not be requested")
          },
        }

        await expect(spawn.execute({ description: "Denied child", prompt: "Do not run." }, ctx)).rejects.toMatchObject({
          data: { message: 'Ultra mode is not allowed for agent "reviewer"' },
        })
        const list = await Collaboration.ListTeammatesTool.init({ agent: reviewer })
        await expect(list.execute({}, ctx)).rejects.toMatchObject({
          data: { message: 'Ultra mode is not allowed for agent "reviewer"' },
        })
        const send = await Collaboration.SendMessageTool.init({ agent: reviewer })
        await expect(send.execute({ task_id: session.id, message: "Denied" }, ctx)).rejects.toMatchObject({
          data: { message: 'Ultra mode is not allowed for agent "reviewer"' },
        })
        expect(state.requests).toHaveLength(0)
      },
    })
  })
})

import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Btw } from "../../src/session/btw"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

test("btw answers during an active turn without changing history or status", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cancelling = Promise.withResolvers<void>()
  const requests: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      requests.push(body)
      if (requests.length === 1) {
        started.resolve()
        await release.promise
      }
      if (requests.length === 3) {
        cancelling.resolve()
        await release.promise
      }
      if (requests.length === 4) return new Response("Provider unavailable", { status: 503 })
      const chunks = [
        { id: "reply", choices: [{ delta: { role: "assistant", content: "A separate answer." } }] },
        { id: "reply", choices: [{ delta: {}, finish_reason: "stop" }] },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  await using tmp = await tmpdir({
    config: {
      model: "side/test",
      enabled_providers: ["side"],
      provider: {
        side: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${server.url.origin}/v1`, apiKey: "test" },
          models: { test: { name: "Test", limit: { context: 128000, output: 1000 } } },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Side question regression" })
      const model = { providerID: ProviderID.make("side"), modelID: ModelID.make("test") }
      await SessionPrompt.prompt({
        sessionID: session.id,
        model,
        noReply: true,
        parts: [{ type: "text", text: "Main task context" }],
      })
      const running = SessionPrompt.loop({ sessionID: session.id })
      try {
        await started.promise
        const before = await Session.messages({ sessionID: session.id })
        const info = await Session.get(session.id)
        expect(SessionStatus.get(session.id).type).toBe("busy")
        const res = await Server.Default().request(`/session/${session.id}/btw`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({ model, question: "What is the main task?" }),
        })
        expect({ status: res.status, body: await res.json() }).toEqual({
          status: 200,
          body: { text: "A separate answer." },
        })
        expect(requests).toHaveLength(2)
        expect(requests[1]).toContain("Main task context")
        expect(requests[1]).toContain("What is the main task?")
        expect(JSON.parse(requests[1]).tools ?? []).toHaveLength(0)
        expect(SessionStatus.get(session.id).type).toBe("busy")
        expect(await Session.messages({ sessionID: session.id })).toEqual(before)
        expect(await Session.get(session.id)).toEqual(info)
        const abort = new AbortController()
        const cancelled = Btw.ask(session.id, { model, question: "Cancel this side question" }, abort.signal)
        const rejected = cancelled.then(
          () => false,
          () => true,
        )
        await cancelling.promise
        abort.abort()
        expect(await rejected).toBe(true)
        expect(SessionStatus.get(session.id).type).toBe("busy")
        expect(await Session.messages({ sessionID: session.id })).toEqual(before)
        await expect(
          Btw.ask(session.id, { model, question: "Fail this side question" }, new AbortController().signal),
        ).rejects.toThrow()
        expect(SessionStatus.get(session.id).type).toBe("busy")
        expect(await Session.messages({ sessionID: session.id })).toEqual(before)
        release.resolve()
        await running
        expect(JSON.stringify(await Session.messages({ sessionID: session.id }))).not.toContain(
          "What is the main task?",
        )
        expect(SessionStatus.get(session.id).type).toBe("idle")
      } finally {
        release.resolve()
        SessionPrompt.cancel(session.id, "user")
        await running.catch(() => {})
        await Session.remove(session.id)
      }
    },
  })
}, 30000)

test("btw snapshots exclude deferred, ignored, and reverted content", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
      const ids = Array.from({ length: 3 }, () => MessageID.ascending())
      for (const [index, id] of ids.entries()) {
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model,
          deferred: index === 1,
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: `message-${index}`,
        })
      }
      await Session.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: ids[0],
        type: "text",
        text: "ignored",
        ignored: true,
      })
      await Session.setRevert({ sessionID: session.id, revert: { messageID: ids[2] } })
      expect(await Btw.context(session.id)).toEqual([{ role: "user", parts: [{ type: "text", text: "message-0" }] }])
      await Session.remove(session.id)
    },
  })
})

test("btw rejects empty questions without adding messages", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const res = await Server.Default().request(`/session/${session.id}/btw`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ model: { providerID: "test", modelID: "test" }, question: "  " }),
      })
      expect(res.status).toBe(400)
      expect(await Session.messages({ sessionID: session.id })).toEqual([])
      await Session.remove(session.id)
    },
  })
})

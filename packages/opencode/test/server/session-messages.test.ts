import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await Session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

describe("session messages endpoint", () => {
  test("accepts an asynchronous deferred prompt", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const res = await Server.Default().request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noReply: true,
            deferred: true,
            parts: [{ type: "text", text: "queued" }],
          }),
        })

        expect(res.status).toBe(204)
        const pending = async (tries = 50): Promise<boolean> => {
          const messages = await Session.messages({ sessionID: session.id })
          if (messages.some((item) => item.info.role === "user" && item.info.deferred)) return true
          if (tries === 0) return false
          await Bun.sleep(10)
          return pending(tries - 1)
        }
        expect(await pending()).toBe(true)
        await Session.remove(session.id)
      },
    })
  })

  test("rejects forbidden Ultra prompts before accepting them", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const body = JSON.stringify({
          agent: "plan",
          model: { providerID: "openai", modelID: "gpt-5.6-sol" },
          variant: "ultra",
          noReply: true,
          parts: [{ type: "text", text: "denied" }],
        })

        for (const path of ["message", "prompt_async"]) {
          const res = await Server.Default().request(`/session/${session.id}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
          expect(res.status).toBe(400)
          expect(await res.json()).toMatchObject({
            name: "UltraModeError",
            data: { message: 'Ultra mode is not allowed for agent "plan"' },
          })
        }

        const command = await Server.Default().request(`/session/${session.id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "plan",
            model: "openai/gpt-5.6-sol",
            variant: "ultra",
            command: "security",
            arguments: "denied",
          }),
        })
        expect(command.status).toBe(400)
        expect(await command.json()).toMatchObject({
          name: "UltraModeError",
          data: { message: 'Ultra mode is not allowed for agent "plan"' },
        })

        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        await Session.remove(session.id)
      },
    })
  })

  test("promotes a pending deferred message", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const id = MessageID.ascending()
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          deferred: true,
        })

        const res = await Server.Default().request(`/session/${session.id}/message/${id}/queue`, { method: "POST" })
        expect(res.status).toBe(204)
        const msg = await MessageV2.get({ sessionID: session.id, messageID: id })
        expect(msg.info.role === "user" && msg.info.deferred).toBeUndefined()

        SessionPrompt.cancel(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("rejects messages that are not pending and deferred", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const normal = MessageID.ascending()
        const answered = MessageID.ascending()
        await Session.updateMessage({
          id: normal,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await Session.updateMessage({
          id: answered,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          deferred: true,
        })
        await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parentID: answered,
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "test",
          agent: "test",
          path: { cwd: root, root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })

        const app = Server.Default()
        const a = await app.request(`/session/${session.id}/message/${normal}/queue`, { method: "POST" })
        const b = await app.request(`/session/${session.id}/message/${answered}/queue`, { method: "POST" })
        expect(a.status).toBe(400)
        expect(b.status).toBe(400)
        expect(await a.json()).toMatchObject({ success: false })

        await Session.remove(session.id)
      },
    })
  })

  test("returns cursor headers for older pages", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const ids = await fill(session.id, 5)
        const app = Server.Default()

        const a = await app.request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = (await a.json()) as MessageV2.WithParts[]
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(a.headers.get("link")).toContain('rel="next"')

        const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = (await b.json()) as MessageV2.WithParts[]
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

        await Session.remove(session.id)
      },
    })
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const ids = await fill(session.id, 3)
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as MessageV2.WithParts[]
        expect(body.map((item) => item.info.id)).toEqual(ids)

        await Session.remove(session.id)
      },
    })
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = await app.request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)

        await Session.remove(session.id)
      },
    })
  })

  test("does not truncate large legacy limit requests", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        await fill(session.id, 520)
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as MessageV2.WithParts[]
        expect(body).toHaveLength(510)

        await Session.remove(session.id)
      },
    })
  })
})

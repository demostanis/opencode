import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"

const root = path.join(import.meta.dir, "../..")

test("session search validates queries and returns bounded previews", async () => {
  await Instance.provide({
    directory: root,
    fn: async () => {
      const session = await Session.create({})
      const message = await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      })
      const part = await Session.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: message.id,
        type: "text",
        text: "prefix ".repeat(1000) + "the unique needle " + "suffix ".repeat(1000),
      })
      const app = Server.Default()
      const response = await app.request(`/session/${session.id}/search?query=UNIQUE%20NEEDLE&limit=1`)
      expect(response.status).toBe(200)
      const hits = await response.json()
      expect(hits).toMatchObject([{ messageID: message.id, partID: part.id, role: "user" }])
      expect(hits[0].preview).toContain("unique needle")
      expect(hits[0].preview.length).toBeLessThan(100)
      expect((await app.request(`/session/${session.id}/search?query=`)).status).toBe(200)
      for (const query of [
        "query=ab",
        "query=%F0%9F%98%80",
        "query=needle&limit=101",
        "query=needle&limit=0",
        "query=needle&limit=1.5",
        "query=%00needle",
      ]) {
        expect((await app.request(`/session/${session.id}/search?${query}`)).status).toBe(400)
      }
      expect((await app.request("/session/ses_missing/search?query=needle")).status).toBe(404)
      await Session.remove(session.id)
    },
  })
})

test("global search works without a selected conversation and spans project directories", async () => {
  await Instance.provide({
    directory: root,
    fn: async () => {
      const sessions = await Promise.all([
        Session.create({ title: "First workspace" }),
        Session.create({ title: "Second workspace" }),
      ])
      for (const session of sessions) {
        const message = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "Global workspace needle",
        })
      }
      const { Database, sql } = await import("../../src/storage/db")
      Database.use((db) => db.run(sql`UPDATE session SET directory = '/other/workspace' WHERE id = ${sessions[1].id}`))
      const response = await Server.Default().request("/session/search?query=workspace%20needle")
      expect(response.status).toBe(200)
      const hits = await response.json()
      expect(hits).toHaveLength(2)
      expect(hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionID: sessions[0].id, title: "First workspace", directory: root }),
          expect.objectContaining({
            sessionID: sessions[1].id,
            title: "Second workspace",
            directory: "/other/workspace",
          }),
        ]),
      )
      const status = await Server.Default().request("/session/search/status")
      expect(status.status).toBe(200)
      expect(await status.json()).toEqual({ indexing: false })
      expect((await Server.Default().request("/session/search?query=ab")).status).toBe(400)
      expect((await Server.Default().request("/session/search?query=&limit=101")).status).toBe(400)
      for (const session of sessions) await Session.remove(session.id)
    },
  })
})

import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSync } from "../../src/session/sync"
import { Database, eq, and } from "../../src/storage/db"
import { SessionTable, MessageTable, PartTable, SyncTable } from "../../src/session/session.sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
import { GlobalBus } from "../../src/bus/global"
import { ProjectTable } from "../../src/project/project.sql"
import { MessageV2 } from "../../src/session/message-v2"
import { pathToFileURL } from "url"

Log.init({ print: false })

describe("portable session sync", () => {
  test("imports complete revisions, updates unchanged copies and branches on local edits", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Portable conversation" })
        const mid = MessageID.ascending()
        await Session.updateMessage({
          id: mid,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        const part = PartID.ascending()
        await Session.updatePart({ id: part, sessionID: session.id, messageID: mid, type: "text", text: "first" })
        const base = path.join(tmp.path, "sync")
        const remote = path.join(base, "sessions", "remote-host", session.id)
        await fs.mkdir(remote, { recursive: true })
        const publish = async () => {
          await SessionSync.exportSession(session.id, base)
          const hosts = await fs.readdir(path.join(base, "sessions"))
          const own = hosts.find((host) => host !== "remote-host")!
          const files = await fs.readdir(path.join(base, "sessions", own, session.id))
          const bundle = await Bun.file(path.join(base, "sessions", own, session.id, files.sort().at(-1)!)).json()
          bundle.machine = "remote-host"
          const hash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex")
          await fs.writeFile(path.join(remote, `${Date.now()}-${hash}.json`), JSON.stringify(bundle))
        }
        await publish()
        await SessionSync.scan(base)
        const entry = () =>
          Database.use(
            (db) =>
              db
                .select()
                .from(SyncTable)
                .where(and(eq(SyncTable.machine, "remote-host"), eq(SyncTable.source_id, session.id)))
                .get()!,
          )
        const first = entry().local_id
        expect(first).not.toBe(session.id)
        const read = (id: string) =>
          Database.use((db) => {
            const messages = db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, SessionID.make(id)))
              .all()
            return messages.flatMap((msg) => db.select().from(PartTable).where(eq(PartTable.message_id, msg.id)).all())
          })
        expect(read(first).some((part) => JSON.stringify(part.data).includes("transferred from another host"))).toBe(
          true,
        )
        expect(read(first).some((part) => JSON.stringify(part.data).includes('"synthetic":true'))).toBe(false)
        const hosts = await fs.readdir(path.join(base, "sessions"))
        const own = hosts.find((host) => host !== "remote-host")!
        await SessionSync.exportSession(SessionID.make(first), base)
        expect(await fs.readdir(path.join(base, "sessions", own))).toEqual([session.id])
        await SessionSync.scan(base)
        expect(entry().local_id).toBe(first)
        await Session.updatePart({ id: part, sessionID: session.id, messageID: mid, type: "text", text: "second" })
        await publish()
        await SessionSync.scan(base)
        expect(entry().local_id).toBe(first)
        expect(read(first).some((part) => JSON.stringify(part.data).includes('"text":"second"'))).toBe(true)
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ title: "Local edit" })
            .where(eq(SessionTable.id, SessionID.make(first)))
            .run(),
        )
        await Session.updatePart({ id: part, sessionID: session.id, messageID: mid, type: "text", text: "third" })
        await publish()
        await SessionSync.scan(base)
        expect(entry().local_id).not.toBe(first)
        expect(
          Database.use(
            (db) =>
              db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(first)))
                .get()?.title,
          ),
        ).toBe("Local edit")
      },
    })
  })

  test("empty sessions retain empty history and show the transfer banner", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Empty" })
        const base = path.join(tmp.path, "sync")
        await SessionSync.exportSession(session.id, base)
        const own = (await fs.readdir(path.join(base, "sessions")))[0]
        const dir = path.join(base, "sessions", own, session.id)
        const file = (await fs.readdir(dir))[0]
        const data = await Bun.file(path.join(dir, file)).json()
        data.machine = "remote-host"
        const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex")
        const remote = path.join(base, "sessions", "remote-host", session.id)
        await fs.mkdir(remote, { recursive: true })
        await fs.writeFile(path.join(remote, `${Date.now()}-${hash}.json`), JSON.stringify(data))
        await SessionSync.scan(base)
        const entry = Database.use(
          (db) =>
            db
              .select()
              .from(SyncTable)
              .where(and(eq(SyncTable.machine, "remote-host"), eq(SyncTable.source_id, session.id)))
              .get()!,
        )
        const messages = Database.use((db) =>
          db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.session_id, SessionID.make(entry.local_id)))
            .all(),
        )
        expect(messages).toHaveLength(0)
        expect(
          Database.use(
            (db) =>
              db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(entry.local_id)))
                .get()?.title,
          )?.endsWith(" (from another host)"),
        ).toBe(true)
        await SessionSync.scan(base)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, SessionID.make(entry.local_id)))
              .all(),
          ),
        ).toHaveLength(0)
      },
    })
  })

  test("maps nested checkout paths and ignores malformed newer archives before publishing", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Nested" })
        const mid = MessageID.ascending()
        await Session.updateMessage({
          id: mid,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: mid,
          sessionID: session.id,
          type: "text",
          text: "history ready",
        })
        const base = path.join(tmp.path, "sync")
        await SessionSync.exportSession(session.id, base)
        const own = (await fs.readdir(path.join(base, "sessions")))[0]
        const dir = path.join(base, "sessions", own, session.id)
        const bundle = await Bun.file(path.join(dir, (await fs.readdir(dir))[0])).json()
        bundle.machine = "remote-host"
        bundle.project.worktree = path.join(tmp.path, "source-checkout")
        bundle.session.directory = path.join(bundle.project.worktree, "packages", "api")
        const remote = path.join(base, "sessions", "remote-host", session.id)
        await fs.mkdir(remote, { recursive: true })
        const hash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex")
        await fs.writeFile(path.join(remote, `1000-${hash}.json`), JSON.stringify(bundle))
        await fs.writeFile(path.join(remote, `9998-${"0".repeat(64)}.json`), JSON.stringify(bundle))
        await fs.writeFile(path.join(remote, `9999-${"0".repeat(64)}.json`), "{broken")
        const checkout = path.join(tmp.path, "other-checkout")
        Database.use((db) =>
          db.update(ProjectTable).set({ worktree: checkout }).where(eq(ProjectTable.id, session.projectID)).run(),
        )
        const seen: number[] = []
        const listener = (event: { payload: { type: string; properties: { info?: Session.Info } } }) => {
          if (event.payload.type !== Session.Event.Created.type || event.payload.properties.info?.id === session.id)
            return
          const id = event.payload.properties.info?.id
          if (!id) return
          seen.push(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.session_id, id)).all().length))
        }
        GlobalBus.on("event", listener)
        try {
          await SessionSync.scan(base)
        } finally {
          GlobalBus.off("event", listener)
        }
        const record = Database.use(
          (db) =>
            db
              .select()
              .from(SyncTable)
              .where(and(eq(SyncTable.machine, "remote-host"), eq(SyncTable.source_id, session.id)))
              .get()!,
        )
        expect(record).toBeDefined()
        expect(
          Database.use(
            (db) =>
              db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(record.local_id)))
                .get()?.directory,
          ),
        ).toBe(path.join(checkout, "packages", "api"))
        expect(seen).toEqual([2])
        const notice = Database.use((db) =>
          db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.session_id, SessionID.make(record.local_id)))
            .all()
            .find((msg) => msg.data.role === "assistant"),
        )
        const info = MessageV2.Assistant.parse({ ...notice?.data, id: notice?.id, sessionID: record.local_id })
        expect(info.modelID).toBe(ModelID.make("test"))
        expect(info.path.cwd).toBe(path.join(checkout, "packages", "api"))
        const updated = {
          ...bundle,
          session: { ...bundle.session, directory: path.join(bundle.project.worktree, "..", "other") },
        }
        const next = createHash("sha256").update(JSON.stringify(updated)).digest("hex")
        await fs.writeFile(path.join(remote, `1001-${next}.json`), JSON.stringify(updated))
        await SessionSync.scan(base)
        expect(
          Database.use(
            (db) =>
              db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(record.local_id)))
                .get()?.directory,
          ),
        ).toBe(checkout)
      },
    })
  })

  test("embeds readable file attachments and tolerates invalid local file URLs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Attachment" })
        const mid = MessageID.ascending()
        await Session.updateMessage({
          id: mid,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        const file = path.join(tmp.path, "image.png")
        await fs.writeFile(file, "portable image")
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: mid,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          url: pathToFileURL(file).href,
        })
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: mid,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          url: "file://%broken",
        })
        const base = path.join(tmp.path, "sync")
        await SessionSync.exportSession(session.id, base)
        const own = (await fs.readdir(path.join(base, "sessions")))[0]
        const dir = path.join(base, "sessions", own, session.id)
        const data = await Bun.file(path.join(dir, (await fs.readdir(dir))[0])).json()
        expect(
          data.messages[0].parts.some(
            (part: { url: string }) =>
              part.url === `data:image/png;base64,${Buffer.from("portable image").toString("base64")}`,
          ),
        ).toBe(true)
        expect(data.messages[0].parts.some((part: { url: string }) => part.url === "file://%broken")).toBe(true)
      },
    })
  })
})

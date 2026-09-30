import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSync } from "../../src/session/sync"
import { Active } from "../../src/session/active"
import { Database, eq } from "../../src/storage/db"
import { SyncStateTable } from "../../src/session/session.sql"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Teammate } from "../../src/teammate/teammate"
import { SyncTable } from "../../src/session/session.sql"
import { createHash } from "node:crypto"

test("only changed conversations are exported, including writes from another connection", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const session = await Session.create({ title: "Incremental history" })
      const mid = MessageID.ascending()
      const pid = PartID.ascending()
      await Session.updateMessage({
        id: mid,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: 1 },
      })
      await Session.updatePart({ id: pid, sessionID: session.id, messageID: mid, type: "text", text: "first" })
      await SessionSync.drain(base)
      expect(await SessionSync.drain(base)).toBe(0)
      const state = () =>
        Database.use((db) => db.select().from(SyncStateTable).where(eq(SyncStateTable.session_id, session.id)).get()!)
      expect(state().exported).toBe(state().version)
      const folder = path.join(base, "sessions", await Active.machine, session.id)
      const before = await fs.readdir(folder)
      using db = new SQLite(Database.Path)
      db.query("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify({ type: "text", text: "second" }), pid)
      expect(state().version).toBeGreaterThan(state().exported)
      expect(await SessionSync.drain(base)).toBe(1)
      expect(await SessionSync.drain(base)).toBe(0)
      expect(await fs.readdir(folder)).not.toEqual(before)
      db.query("DELETE FROM part WHERE id = ?").run(pid)
      expect(await SessionSync.drain(base)).toBe(1)
      await Session.setTitle({ sessionID: session.id, title: "Renamed" })
      expect(await SessionSync.drain(base)).toBe(1)
      await Session.remove(session.id)
      expect(state()).toBeUndefined()
      await SessionSync.clean(base)
      expect(await fs.stat(folder).catch(() => undefined)).toBeUndefined()
    },
  })
})

test("subagents and current or legacy teammates are excluded and old archives are removed", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const parent = await Session.create({ title: "Main conversation" })
      const child = await Session.create({ title: "Subagent", parentID: parent.id })
      const teammate = await Session.create({ title: "Teammate", permission: [Teammate.ROLE] })
      const legacy = await Session.create({
        title: "Legacy teammate",
        permission: [{ ...Teammate.ROLE, permission: "multiagent" }],
      })
      const copy = await Session.create({ title: "Old imported subagent (from another host)" })
      Database.use((db) =>
        db
          .insert(SyncTable)
          .values({
            machine: "old-host",
            source_id: child.id,
            local_id: copy.id,
            revision: `1-${"b".repeat(64)}.json`,
            baseline: "old-baseline",
          })
          .run(),
      )
      const root = path.join(base, "sessions", await Active.machine)
      await fs.mkdir(path.join(root, child.id), { recursive: true })
      await fs.writeFile(path.join(root, child.id, `1-${"a".repeat(64)}.json`), "{}")
      await SessionSync.clean(base)
      await SessionSync.drain(base)
      expect(await fs.readdir(root)).toEqual([parent.id])
      await Promise.all([Session.remove(parent.id), Session.remove(teammate.id), Session.remove(legacy.id)])
      await Session.remove(copy.id)
      Database.use((db) => db.delete(SyncTable).where(eq(SyncTable.local_id, copy.id)).run())
    },
  })
})

test("changes during an asynchronous export remain pending for the next pass", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const session = await Session.create({ title: "Before" })
      const job = SessionSync.drain(base)
      await Session.setTitle({ sessionID: session.id, title: "During" })
      await job
      expect(await SessionSync.drain(base)).toBe(1)
      expect(await SessionSync.drain(base)).toBe(0)
      await Session.remove(session.id)
    },
  })
})

test("old peers cannot import subagent or teammate archives", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const session = await Session.create({ title: "Archive fixture" })
      await SessionSync.exportSession(session.id, base)
      const source = path.join(base, "sessions", await Active.machine, session.id)
      const bundle: { session: Session.Info; [key: string]: unknown } = await Bun.file(
        path.join(source, (await fs.readdir(source))[0]),
      ).json()
      for (const [index, props] of [
        { parentID: session.id },
        { permission: [Teammate.ROLE] },
        { permission: [{ ...Teammate.ROLE, permission: "multiagent" }] },
      ].entries()) {
        const machine = `excluded-${index}`
        const data = { ...bundle, machine, session: { ...bundle.session, ...props } }
        const text = JSON.stringify(data)
        const dir = path.join(base, "sessions", machine, session.id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `1-${createHash("sha256").update(text).digest("hex")}.json`), text)
      }
      await SessionSync.scan(base)
      expect(
        Database.use((db) => db.select().from(SyncTable).where(eq(SyncTable.source_id, session.id)).all()),
      ).toEqual([])
      await Session.remove(session.id)
    },
  })
})

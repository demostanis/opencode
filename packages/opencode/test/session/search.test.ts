import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSearch } from "../../src/session/search"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database, sql } from "../../src/storage/db"
import { Database as SQLite } from "bun:sqlite"

const root = path.join(import.meta.dir, "../..")

async function user(sessionID: SessionID, text: string, time = Date.now()) {
  const message = await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: time },
    agent: "test",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  })
  const part = { id: PartID.ascending(), sessionID, messageID: message.id, type: "text" as const, text }
  await Session.updatePart(part)
  return part
}

describe("conversation search", () => {
  test("searches full history, not just the last 100 messages, and bounds results", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "An old Needle in the conversation", 1)
        for (let i = 0; i < 120; i++) await user(session.id, `Recent conversation needle ${i}`, i + 2)
        const hits = await SessionSearch.search({ sessionID: session.id, query: "NEEDLE", limit: 100 })
        expect(hits).toHaveLength(100)
        expect(hits[0].time).toBe(121)
        expect(hits[0].preview.toLowerCase()).toContain("needle")
        expect(await SessionSearch.search({ sessionID: session.id, query: "old needle" })).toMatchObject([
          { messageID: first.messageID, partID: first.id, role: "user", type: "text" },
        ])
        await Session.remove(session.id)
      },
    })
  })

  test("matches literal code, quotes, Unicode, and only the requested session", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        const part = await user(session.id, 'const FooBar = "100%_done"; CAF\u00c9 \u6771\u4eac\u99c5')
        await user(other.id, 'const FooBar = "100%_done"; CAF\u00c9 \u6771\u4eac\u99c5')
        for (const query of ["oob", '"100%_done"', "fooBAR =", "caf\u00e9", "\u6771\u4eac\u99c5"]) {
          const hits = await SessionSearch.search({ sessionID: session.id, query })
          expect(hits.map((hit) => hit.partID)).toEqual([part.id])
        }
        expect(await SessionSearch.search({ sessionID: session.id, query: "foo OR nope" })).toEqual([])
        expect(await SessionSearch.search({ sessionID: session.id, query: "foo*" })).toEqual([])
        await Session.remove(session.id)
        await Session.remove(other.id)
      },
    })
  })

  test("indexes dialogue, executed commands and read paths without internal tool details", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const part = await user(session.id, "normal prompt")
        const message = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: part.messageID,
          time: { created: 2, completed: 3 },
          agent: "test",
          mode: "test",
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test"),
          path: { cwd: root, root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const text = await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "assistant response needle",
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "reasoning",
          text: "reasoning needle",
          time: { start: 2, end: 3 },
        })
        const tool = await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "tool",
          tool: "bash",
          callID: "call",
          state: {
            status: "completed",
            input: { command: "git status", nested: { path: "src/needle.ts" } },
            title: "Show status",
            output: "tool output needle",
            metadata: {},
            time: { start: 2, end: 3 },
          },
        })
        await Session.updatePart({ ...part, id: PartID.ascending(), text: "synthetic needle", synthetic: true })
        await Session.updatePart({ ...part, id: PartID.ascending(), text: "ignored needle", ignored: true })
        const hits = await SessionSearch.search({ sessionID: session.id, query: "needle" })
        expect(hits.map((hit) => hit.partID)).toEqual([text.id])
        expect(hits.every((hit) => hit.role === "assistant")).toBe(true)
        expect(await SessionSearch.search({ sessionID: session.id, query: "git status" })).toMatchObject([
          { partID: tool.id, type: "tool", tool: "bash" },
        ])
        for (const query of ["reasoning needle", "tool output", "Show status", "src/needle.ts"]) {
          expect(await SessionSearch.search({ sessionID: session.id, query })).toEqual([])
        }
        const file = await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "tool",
          tool: "read",
          callID: "read",
          state: {
            status: "completed",
            input: { filePath: "src/reader.ts" },
            title: "Read source",
            output: "private implementation detail",
            metadata: {},
            time: { start: 2, end: 3 },
          },
        })
        expect(await SessionSearch.search({ query: "reader.ts" })).toMatchObject([{ partID: file.id, tool: "read" }])
        expect(await SessionSearch.search({ query: "private implementation" })).toEqual([])
        await Session.remove(session.id)
      },
    })
  })

  test("keeps the index current across edits, removals, and cascades", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const part = await user(session.id, "original needle")
        expect(await SessionSearch.search({ sessionID: session.id, query: "original" })).toHaveLength(1)
        Database.use((db) => db.run(sql`INSERT INTO part_search(part_search) VALUES('integrity-check')`))
        await Session.updatePart({ ...part, text: "replacement needle" })
        expect(await SessionSearch.search({ sessionID: session.id, query: "original" })).toEqual([])
        expect(await SessionSearch.search({ sessionID: session.id, query: "replacement" })).toHaveLength(1)
        await Session.updatePart({ ...part, text: "replacement needle", ignored: true })
        expect(await SessionSearch.search({ sessionID: session.id, query: "replacement" })).toEqual([])
        await Session.updatePart({ ...part, text: "replacement needle" })
        await Session.removePart({ sessionID: session.id, messageID: part.messageID, partID: part.id })
        expect(await SessionSearch.search({ sessionID: session.id, query: "needle" })).toEqual([])
        const next = await user(session.id, "new needle")
        expect(await SessionSearch.search({ sessionID: session.id, query: "needle" })).toHaveLength(1)
        await Session.removeMessage({ sessionID: session.id, messageID: next.messageID })
        expect(await SessionSearch.search({ sessionID: session.id, query: "needle" })).toEqual([])
        await user(session.id, "cascade needle")
        await Session.remove(session.id)
        expect(
          Database.use((db) =>
            db.all(
              sql`SELECT rowid FROM part_search WHERE session_id = ${session.id} AND part_search MATCH 'text : "needle"'`,
            ),
          ),
        ).toEqual([])
        Database.use((db) => db.run(sql`INSERT INTO part_search(part_search) VALUES('integrity-check')`))
      },
    })
  })

  test("searches every conversation, including unopened and reverted history", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const sessions = await Promise.all(Array.from({ length: 5 }, () => Session.create({})))
        const first = await user(sessions[0].id, "first needle")
        const second = await user(sessions[0].id, "reverted needle")
        await Session.setRevert({ sessionID: sessions[0].id, revert: { messageID: second.messageID } })
        expect(await SessionSearch.search({ sessionID: sessions[0].id, query: "needle" })).toMatchObject([
          { partID: first.id },
        ])
        for (const session of sessions.slice(1)) {
          await user(session.id, "unrelated needle")
          await SessionSearch.search({ sessionID: session.id, query: "needle" })
        }
        await Session.updatePart({ ...first, text: "updated needle" })
        expect(await SessionSearch.search({ sessionID: sessions[0].id, query: "updated" })).toMatchObject([
          { partID: first.id },
        ])
        const hits = await SessionSearch.search({ query: "needle" })
        expect(new Set(hits.map((hit) => hit.sessionID))).toEqual(new Set(sessions.map((session) => session.id)))
        expect(hits.some((hit) => hit.partID === second.id)).toBe(false)
        expect(hits.every((hit) => hit.title && hit.directory === root)).toBe(true)
        for (const session of sessions) await Session.remove(session.id)
      },
    })
  })

  test("warms without results and leaves the permanent schema untouched", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        await user(session.id, "indexed needle")
        expect(await SessionSearch.search({ sessionID: session.id, query: "" })).toEqual([])
        expect(
          Database.use((db) => db.all(sql`SELECT name FROM main.sqlite_master WHERE name LIKE 'part_search%'`)),
        ).toEqual([])
        const statement = Database.Client().$client.prepare<{ detail: string }, []>(
          `EXPLAIN QUERY PLAN SELECT rowid FROM part_search WHERE part_search MATCH 'text : "needle"'`,
        )
        const plan = statement.all()
        statement.finalize()
        expect(plan.some((row) => row.detail.includes("VIRTUAL TABLE INDEX") && row.detail.includes("M"))).toBe(true)
        await Session.remove(session.id)
      },
    })
  })

  test("invalidates cached indexes after writes from another connection", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const part = await user(session.id, "original needle")
        expect(await SessionSearch.search({ sessionID: session.id, query: "original" })).toHaveLength(1)
        using db = new SQLite(Database.Path)
        db.query("UPDATE part SET data = json_set(data, '$.text', ?) WHERE id = ?").run("external needle", part.id)
        expect(await SessionSearch.search({ sessionID: session.id, query: "original" })).toEqual([])
        expect(await SessionSearch.search({ sessionID: session.id, query: "external" })).toMatchObject([
          { partID: part.id },
        ])
        await Session.remove(session.id)
      },
    })
  })

  test("keeps a persistent cache across connections and reconciles offline edits and deletions", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({ title: "Persistent search" })
        const part = await user(session.id, "offline original needle")
        expect(await SessionSearch.search({ query: "original needle" })).toMatchObject([
          { sessionID: session.id, title: "Persistent search", partID: part.id },
        ])
        Database.close()
        using cache = new SQLite(`${Database.Path}.search-v2`, { readonly: true })
        expect(
          cache.query("SELECT part_id FROM part_search WHERE part_search MATCH ?").all('text : "original needle"'),
        ).toEqual([{ part_id: part.id }])
        expect(await SessionSearch.search({ query: "original needle" })).toHaveLength(1)
        Database.close()
        using db = new SQLite(Database.Path)
        db.query("UPDATE part SET data = json_set(data, '$.text', ?) WHERE id = ?").run(
          "offline updated needle",
          part.id,
        )
        expect(await SessionSearch.search({ query: "original needle" })).toEqual([])
        expect(await SessionSearch.search({ query: "updated needle" })).toMatchObject([{ partID: part.id }])
        Database.close()
        db.query("DELETE FROM part WHERE id = ?").run(part.id)
        expect(await SessionSearch.search({ query: "updated needle" })).toEqual([])
        await Session.remove(session.id)
      },
    })
  })

  test("includes archived sessions and exposes workspace and conversation labels", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({ title: "Archived project notes" })
        const part = await user(session.id, "archived global needle")
        await Session.setArchived({ sessionID: session.id, time: Date.now() })
        expect(await SessionSearch.search({ query: "global needle" })).toMatchObject([
          { sessionID: session.id, title: session.title, directory: root, partID: part.id },
        ])
        await Session.setTitle({ sessionID: session.id, title: "Renamed notes" })
        expect(await SessionSearch.search({ query: "global needle" })).toMatchObject([{ title: "Renamed notes" }])
        await Session.remove(session.id)
      },
    })
  })

  test("reports indexing while background batches prepare the cache", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const part = await user(session.id, "indexing needle")
        await SessionSearch.search({ query: "" })
        Database.close()
        using db = new SQLite(Database.Path)
        const statement = db.query(
          "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
        )
        db.transaction(() => {
          Array.from({ length: 400 }, (_, i) =>
            statement.run(
              PartID.ascending(),
              part.messageID,
              session.id,
              JSON.stringify({ type: "text", text: `batch indexing needle ${i}` }),
            ),
          )
        })()
        statement.finalize()
        let done = false
        let seen = false
        const job = SessionSearch.search({ query: "indexing needle" }).finally(() => {
          done = true
        })
        while (!done) {
          seen ||= SessionSearch.status().indexing
          await Bun.sleep(0)
        }
        await job
        expect(seen).toBe(true)
        expect(SessionSearch.status()).toEqual({ indexing: false })
        await Session.remove(session.id)
      },
    })
  })
})

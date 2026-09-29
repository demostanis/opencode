import z from "zod"
import { Database, sql } from "@/storage/db"
import { fn } from "@/util/fn"
import { preview } from "@/util/search"
import { Session } from "."
import { MessageID, PartID, SessionID } from "./schema"

export namespace SessionSearch {
  export const Input = z.object({
    sessionID: SessionID.zod,
    query: z
      .string()
      .trim()
      .max(256)
      .refine((text) => !text || (Array.from(text).length >= 3 && !text.includes("\0")), "Enter at least 3 characters"),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })

  export const Hit = z
    .object({
      messageID: MessageID.zod,
      partID: PartID.zod,
      role: z.enum(["user", "assistant"]),
      type: z.enum(["text", "reasoning", "tool"]),
      tool: z.string().nullable(),
      time: z.number(),
      preview: z.string(),
    })
    .meta({ ref: "SessionSearchHit" })
  export type Hit = z.infer<typeof Hit>

  const clients = new WeakMap<object, { sessions: Map<string, string>; version: number }>()

  function index(id: string) {
    const db = Database.Client()
    const cached = clients.get(db)
    const version = db.get<{ data_version: number }>(sql`PRAGMA main.data_version`)!.data_version
    const sessions = cached?.sessions ?? new Map<string, string>()
    if (!cached) {
      // Connection-local tables leave the conversation schema untouched and index only opened conversations.
      db.run(sql`CREATE TEMP TABLE part_search_session (id TEXT PRIMARY KEY, scope TEXT NOT NULL UNIQUE)`)
      db.run(sql`CREATE TEMP VIEW part_search_source AS
        SELECT part.rowid AS rowid, part.session_id, part_search_session.scope,
          CASE json_extract(data, '$.type')
            WHEN 'text' THEN json_extract(data, '$.text')
            WHEN 'reasoning' THEN json_extract(data, '$.text')
            WHEN 'tool' THEN
              coalesce(json_extract(data, '$.tool'), '') || char(10) ||
              coalesce((
                SELECT group_concat(CAST(atom AS TEXT), char(10))
                FROM json_tree(part.data, '$.state.input') WHERE atom IS NOT NULL
              ), '') || char(10) ||
              coalesce(json_extract(data, '$.state.title'), '') || char(10) ||
              coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')
          END AS text
        FROM main.part
        JOIN part_search_session ON part_search_session.id = part.session_id
        WHERE json_extract(data, '$.type') IN ('text', 'reasoning', 'tool')
          AND (json_extract(data, '$.type') != 'text' OR (
            coalesce(json_extract(data, '$.synthetic'), 0) = 0
            AND coalesce(json_extract(data, '$.ignored'), 0) = 0
          ))`)
      db.run(sql`CREATE VIRTUAL TABLE temp.part_search USING fts5(
        session_id UNINDEXED, text, scope, tokenize = 'trigram'
      )`)
      db.run(sql`CREATE TEMP TRIGGER part_search_insert AFTER INSERT ON main.part
        WHEN new.session_id IN (SELECT id FROM part_search_session) BEGIN
          INSERT INTO part_search (rowid, session_id, text, scope)
          SELECT rowid, session_id, text, scope FROM part_search_source WHERE rowid = new.rowid;
        END`)
      db.run(sql`CREATE TEMP TRIGGER part_search_delete AFTER DELETE ON main.part
        WHEN old.session_id IN (SELECT id FROM part_search_session) BEGIN
          DELETE FROM part_search WHERE rowid = old.rowid;
        END`)
      db.run(sql`CREATE TEMP TRIGGER part_search_update_before BEFORE UPDATE OF data, session_id ON main.part
        WHEN (old.data IS NOT new.data OR old.session_id IS NOT new.session_id)
          AND old.session_id IN (SELECT id FROM part_search_session) BEGIN
          DELETE FROM part_search WHERE rowid = old.rowid;
        END`)
      db.run(sql`CREATE TEMP TRIGGER part_search_update_after AFTER UPDATE OF data, session_id ON main.part
        WHEN (old.data IS NOT new.data OR old.session_id IS NOT new.session_id)
          AND new.session_id IN (SELECT id FROM part_search_session) BEGIN
          INSERT INTO part_search (rowid, session_id, text, scope)
          SELECT rowid, session_id, text, scope FROM part_search_source WHERE rowid = new.rowid;
        END`)
      clients.set(db, { sessions, version })
    }
    if (cached && cached.version !== version) {
      Database.transaction((tx) => {
        tx.run(sql`DELETE FROM part_search`)
        tx.run(sql`DELETE FROM part_search_session`)
      })
      sessions.clear()
      cached.version = version
    }
    if (sessions.has(id)) {
      const scope = sessions.get(id)!
      sessions.delete(id)
      sessions.set(id, scope)
      return scope
    }
    const oldest = sessions.size >= 4 ? sessions.keys().next().value : undefined
    // One three-character token scopes the postings without tokenizing a whole session ID.
    const scope = oldest
      ? sessions.get(oldest)!
      : Array.from({ length: 4 }, (_, i) => String(i).padStart(3, "0")).find(
          (item) => ![...sessions.values()].includes(item),
        )!
    Database.transaction((tx) => {
      if (oldest) {
        tx.run(sql`DELETE FROM part_search WHERE session_id = ${oldest}`)
        tx.run(sql`DELETE FROM part_search_session WHERE id = ${oldest}`)
      }
      tx.run(sql`INSERT INTO part_search_session (id, scope) VALUES (${id}, ${scope})`)
      tx.run(sql`INSERT INTO part_search (rowid, session_id, text, scope)
        SELECT rowid, session_id, text, scope FROM part_search_source WHERE session_id = ${id}`)
    })
    if (oldest) sessions.delete(oldest)
    sessions.set(id, scope)
    return scope
  }

  export const search = fn(Input, async (input) => {
    const session = await Session.get(input.sessionID)
    const scope = index(input.sessionID)
    if (!input.query) return []
    const quote = (text: string) => `"${text.replaceAll('"', '""')}"`
    const match = `scope : ${quote(scope)} AND text : ${quote(input.query)}`
    return Database.use((db) =>
      db.all<Omit<Hit, "preview"> & { text: string }>(sql`
        WITH hits AS MATERIALIZED (
          SELECT part.rowid AS rowid, message.time_created AS time, message.id AS messageID, part.id AS partID
          FROM part_search
          JOIN part ON part.rowid = part_search.rowid
          JOIN message ON message.id = part.message_id
          WHERE part_search MATCH ${match}
            AND part.session_id = ${input.sessionID}
            AND message.session_id = ${input.sessionID}
            ${session.revert ? sql`AND message.id < ${session.revert.messageID}` : sql``}
          ORDER BY part_search.rowid DESC
          LIMIT ${input.limit ?? 50}
        )
        SELECT
          hits.messageID,
          hits.partID,
          json_extract(message.data, '$.role') AS role,
          json_extract(part.data, '$.type') AS type,
          json_extract(part.data, '$.tool') AS tool,
          hits.time,
          part_search.text
        FROM hits
        JOIN part_search ON part_search.rowid = hits.rowid
        JOIN part ON part.rowid = hits.rowid
        JOIN message ON message.id = hits.messageID
        ORDER BY hits.time DESC, hits.messageID DESC, hits.partID
      `),
    ).flatMap((row) => {
      const text = preview(row.text, input.query)
      if (!text) return []
      return [
        {
          messageID: row.messageID,
          partID: row.partID,
          role: row.role,
          type: row.type,
          tool: row.tool,
          time: row.time,
          preview: text,
        },
      ]
    })
  })
}

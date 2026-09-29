import z from "zod"
import { Database, sql } from "@/storage/db"
import { fn } from "@/util/fn"
import { preview } from "@/util/search"
import { Session } from "."
import { MessageID, PartID, SessionID } from "./schema"

export namespace SessionSearch {
  export const Input = z.object({
    sessionID: SessionID.zod.optional(),
    query: z
      .string()
      .trim()
      .max(256)
      .refine((text) => !text || (Array.from(text).length >= 3 && !text.includes("\0")), "Enter at least 3 characters"),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })

  export const Hit = z
    .object({
      sessionID: SessionID.zod,
      title: z.string(),
      directory: z.string(),
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
  export const Status = z.object({ indexing: z.boolean() }).meta({ ref: "SessionSearchStatus" })

  const clients = new WeakMap<object, { version: number; indexing: boolean; job?: Promise<void> }>()

  export function status() {
    return { indexing: clients.get(Database.Client())?.indexing ?? false }
  }

  async function stamp() {
    const files = await Promise.all(
      [Database.Path, `${Database.Path}-wal`].map((file) =>
        Bun.file(file)
          .stat()
          .catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return
            throw err
          }),
      ),
    )
    return files.map((file) => (file ? `${file.size}:${file.mtimeMs}` : "")).join("|")
  }

  function index(): Promise<void> {
    const db = Database.Client()
    const cached = clients.get(db)
    const state = cached ?? { version: -1, indexing: false, job: undefined as Promise<void> | undefined }
    if (!cached) {
      // The rebuildable sidecar keeps search persistent without changing the conversation schema.
      db.run(sql`ATTACH DATABASE ${`${Database.Path}.search-v2`} AS conversation_search`)
      db.run(sql`PRAGMA conversation_search.journal_mode = WAL`)
      db.run(sql`PRAGMA conversation_search.synchronous = NORMAL`)
      db.run(sql`CREATE TABLE IF NOT EXISTS conversation_search.part_search_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1), stamp TEXT NOT NULL
      )`)
      db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search.part_search USING fts5(
        part_id UNINDEXED, session_id UNINDEXED, text, scope, tokenize = 'trigram'
      )`)
      db.run(sql`CREATE TEMP VIEW part_search_source AS
        SELECT part.rowid AS rowid, part.id AS part_id, part.session_id,
          substr(part.session_id, -3) AS scope,
          CASE json_extract(data, '$.type')
            WHEN 'text' THEN json_extract(data, '$.text')
            WHEN 'tool' THEN
              CASE json_extract(data, '$.tool')
                WHEN 'bash' THEN coalesce(json_extract(data, '$.state.input.command'), '')
                WHEN 'read' THEN coalesce(json_extract(data, '$.state.input.filePath'), '')
              END
          END AS text
        FROM main.part
        WHERE (json_extract(data, '$.type') = 'text' AND (
            coalesce(json_extract(data, '$.synthetic'), 0) = 0
            AND coalesce(json_extract(data, '$.ignored'), 0) = 0
          )) OR (json_extract(data, '$.type') = 'tool'
            AND json_extract(data, '$.tool') IN ('bash', 'read'))`)
      db.run(sql`CREATE TEMP TRIGGER part_search_insert AFTER INSERT ON main.part BEGIN
        DELETE FROM part_search WHERE rowid = new.rowid;
        INSERT INTO part_search (rowid, part_id, session_id, text, scope)
        SELECT rowid, part_id, session_id, text, scope FROM part_search_source WHERE rowid = new.rowid;
      END`)
      db.run(sql`CREATE TEMP TRIGGER part_search_delete AFTER DELETE ON main.part BEGIN
        DELETE FROM part_search WHERE rowid = old.rowid;
      END`)
      db.run(sql`CREATE TEMP TRIGGER part_search_update AFTER UPDATE OF data, session_id ON main.part
        WHEN old.data IS NOT new.data OR old.session_id IS NOT new.session_id BEGIN
        DELETE FROM part_search WHERE rowid = old.rowid;
        INSERT INTO part_search (rowid, part_id, session_id, text, scope)
        SELECT rowid, part_id, session_id, text, scope FROM part_search_source WHERE rowid = new.rowid;
      END`)
      clients.set(db, state)
    }
    if (state.job) return state.job
    const job = (async () => {
      while (true) {
        const version = db.get<{ data_version: number }>(sql`PRAGMA main.data_version`)!.data_version
        const before = await stamp()
        const saved = db.get<{ stamp: string }>(
          sql`SELECT stamp FROM conversation_search.part_search_meta WHERE id = 1`,
        )
        if (state.version !== version && saved?.stamp !== before) {
          state.indexing = true
          // Small batches yield between transactions so indexing never monopolizes the server event loop.
          let cursor = 0
          while (true) {
            const rows = db.all<{ rowid: number }>(sql`
            SELECT part_search.rowid
            FROM conversation_search.part_search
            LEFT JOIN part_search_source ON part_search_source.rowid = part_search.rowid
            WHERE part_search.rowid > ${cursor} AND part_search_source.rowid IS NULL
            ORDER BY part_search.rowid LIMIT 100
          `)
            if (!rows.length) break
            db.transaction((tx) => {
              rows.forEach((row) => tx.run(sql`DELETE FROM conversation_search.part_search WHERE rowid = ${row.rowid}`))
            })
            cursor = rows.at(-1)!.rowid
            await Bun.sleep(0)
          }
          cursor = 0
          while (true) {
            const rows = db.all<{ rowid: number }>(sql`
            SELECT part_search_source.rowid
            FROM part_search_source
            LEFT JOIN conversation_search.part_search ON part_search.rowid = part_search_source.rowid
            WHERE part_search_source.rowid > ${cursor} AND (
              part_search.rowid IS NULL OR part_search.part_id IS NOT part_search_source.part_id OR
              part_search.session_id IS NOT part_search_source.session_id OR part_search.text IS NOT part_search_source.text
            )
            ORDER BY part_search_source.rowid LIMIT 100
          `)
            if (!rows.length) break
            db.transaction((tx) => {
              rows.forEach((row) =>
                tx.run(sql`
              INSERT OR REPLACE INTO conversation_search.part_search (rowid, part_id, session_id, text, scope)
              SELECT rowid, part_id, session_id, text, scope FROM part_search_source WHERE rowid = ${row.rowid}
            `),
              )
            })
            cursor = rows.at(-1)!.rowid
            await Bun.sleep(0)
          }
        }
        const ending = await stamp()
        const after = db.get<{ data_version: number }>(sql`PRAGMA main.data_version`)!.data_version
        if (after !== version) {
          state.version = -1
          continue
        }
        state.version = after
        db.run(sql`INSERT INTO conversation_search.part_search_meta (id, stamp) VALUES (1, ${ending})
        ON CONFLICT(id) DO UPDATE SET stamp = excluded.stamp`)
        return
      }
    })().finally(() => {
      state.indexing = false
      state.job = undefined
    })
    state.job = job
    return job
  }

  export const search = fn(Input, async (input) => {
    if (input.sessionID) await Session.get(input.sessionID)
    await index()
    if (!input.query) return []
    const quote = (text: string) => `"${text.replaceAll('"', '""')}"`
    const match = `text : ${quote(input.query)}${input.sessionID ? ` AND scope : ${quote(input.sessionID.slice(-3))}` : ""}`
    return Database.use((db) =>
      db.all<Omit<Hit, "preview"> & { text: string }>(sql`
        WITH hits AS MATERIALIZED (
          SELECT part.rowid AS rowid, message.time_created AS time, message.id AS messageID, part.id AS partID
          FROM conversation_search.part_search
          JOIN part ON part.rowid = part_search.rowid AND part.id = part_search.part_id
          JOIN message ON message.id = part.message_id
          JOIN session ON session.id = part.session_id AND session.id = message.session_id
          WHERE part_search MATCH ${match}
            ${input.sessionID ? sql`AND session.id = ${input.sessionID}` : sql``}
            AND (session.revert IS NULL OR message.id < json_extract(session.revert, '$.messageID'))
          ORDER BY part_search.rowid DESC
          LIMIT ${input.limit ?? 50}
        )
        SELECT
          session.id AS sessionID, session.title, session.directory,
          hits.messageID, hits.partID,
          json_extract(message.data, '$.role') AS role,
          json_extract(part.data, '$.type') AS type,
          json_extract(part.data, '$.tool') AS tool,
          hits.time, part_search.text
        FROM hits
        JOIN conversation_search.part_search ON part_search.rowid = hits.rowid
        JOIN part ON part.rowid = hits.rowid
        JOIN message ON message.id = hits.messageID
        JOIN session ON session.id = message.session_id
        ORDER BY hits.time DESC, hits.messageID DESC, hits.partID
      `),
    ).flatMap((row) => {
      const text = preview(row.text, input.query)
      if (!text) return []
      return [
        {
          sessionID: row.sessionID,
          title: row.title,
          directory: row.directory,
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

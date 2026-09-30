import z from "zod"
import { Database } from "@/storage/db"
import { Database as SQLite } from "bun:sqlite"
import { fn } from "@/util/fn"
import { preview } from "@/util/search"
import { Rpc } from "@/util/rpc"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { Session } from "."
import { MessageID, PartID, SessionID } from "./schema"
import type { rpc } from "./search-worker"

declare const OPENCODE_SEARCH_WORKER_PATH: string | undefined

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

  // Queries use read-only connections; neither indexing nor cache writes can hold up the conversation database.
  export class Reader {
    private db: SQLite
    constructor(source: string, cache: string) {
      this.db = new SQLite(source, { readonly: true })
      this.db.query("ATTACH DATABASE ? AS conversation_search").run(cache)
      this.db.run("PRAGMA query_only = ON")
      this.db.run("PRAGMA busy_timeout = 1000")
    }
    search(input: z.infer<typeof Input>): Hit[] {
      if (!input.query) return []
      const quote = (text: string) => `"${text.replaceAll('"', '""')}"`
      const match = `text : ${quote(input.query)}${input.sessionID ? ` AND scope : ${quote(input.sessionID.slice(-3))}` : ""}`
      const rows = this.db
        .query<Omit<Hit, "preview"> & { text: string }, (string | number)[]>(
          `
        WITH hits AS MATERIALIZED (
          SELECT part.rowid AS rowid, message.time_created AS time, message.id AS messageID, part.id AS partID
          FROM conversation_search.part_search
          JOIN part ON part.rowid = part_search.rowid AND part.id = part_search.part_id
          JOIN message ON message.id = part.message_id
          JOIN session ON session.id = part.session_id AND session.id = message.session_id
          WHERE part_search MATCH ? ${input.sessionID ? "AND session.id = ?" : ""}
            AND (session.revert IS NULL OR message.id < json_extract(session.revert, '$.messageID'))
          ORDER BY message.time_created DESC, message.id DESC, part.id LIMIT ?
        )
        SELECT session.id AS sessionID, session.title, session.directory, hits.messageID, hits.partID,
          json_extract(message.data, '$.role') AS role, json_extract(part.data, '$.type') AS type,
          json_extract(part.data, '$.tool') AS tool, hits.time, part_search.text
        FROM hits JOIN conversation_search.part_search ON part_search.rowid = hits.rowid
        JOIN part ON part.rowid = hits.rowid JOIN message ON message.id = hits.messageID
        JOIN session ON session.id = message.session_id
        ORDER BY hits.time DESC, hits.messageID DESC, hits.partID
      `,
        )
        .all(match, ...(input.sessionID ? [input.sessionID] : []), input.limit ?? 50)
      return rows.flatMap((row) => {
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
    }
    close() {
      this.db.close()
    }
  }

  type State = { reader: Reader; sync: () => Promise<void>; client: ReturnType<typeof Rpc.client<typeof rpc>> }
  const clients = new WeakMap<object, Promise<State>>()
  let indexing = false

  export function status() {
    return { indexing }
  }

  function open() {
    const db = Database.Client()
    const current = clients.get(db)
    if (current) return current
    const job = (async () => {
      const worker = new Worker(
        typeof OPENCODE_SEARCH_WORKER_PATH !== "undefined"
          ? OPENCODE_SEARCH_WORKER_PATH
          : new URL("./search-worker.ts", import.meta.url).href,
      )
      if ("unref" in worker && typeof worker.unref === "function") worker.unref()
      const client = Rpc.client<typeof rpc>(worker)
      const off = client.on<{ indexing: boolean }>("status", (event) => {
        indexing = event.indexing
      })
      const failure = client.on<string>("failure", (error) => Log.Default.warn("search indexing failed", { error }))
      const initialized = await client.call("init", { source: Database.Path, cache: `${Database.Path}.search-v2` })
      if (!initialized.ready) await client.call("ensure", undefined)
      const reader = new Reader(Database.Path, `${Database.Path}.search-v2`)
      const ids = new Set<string>()
      let timer: Timer | undefined
      const flush = async () => {
        timer = undefined
        const pending = [...ids]
        ids.clear()
        if (pending.length) await client.call("update", pending)
      }
      const events = (event: {
        payload: { type: string; properties?: { part?: { id: string }; partID?: string } }
      }) => {
        const id =
          event.payload.type === "message.part.updated"
            ? event.payload.properties?.part?.id
            : event.payload.type === "message.part.removed"
              ? event.payload.properties?.partID
              : undefined
        if (!id) return
        ids.add(id)
        timer ??= setTimeout(() => {
          flush().catch((err: unknown) => Log.Default.warn("search update failed", { error: String(err) }))
        }, 100)
      }
      GlobalBus.on("event", events)
      Database.onclose(() => {
        clearTimeout(timer)
        GlobalBus.off("event", events)
        off()
        failure()
        worker.terminate()
        reader.close()
        indexing = false
      })
      return {
        reader,
        client,
        sync: async () => {
          clearTimeout(timer)
          await flush()
        },
      }
    })()
    clients.set(db, job)
    return job
  }

  export async function refresh() {
    const state = await open()
    await state.sync()
    await state.client.call("ensure", undefined)
  }

  export const search = fn(Input, async (input) => {
    if (input.sessionID) await Session.get(input.sessionID)
    const state = await open()
    await state.sync()
    void state.client
      .call("refresh", undefined)
      .catch((err: unknown) => Log.Default.warn("search refresh failed", { error: String(err) }))
    return state.reader.search(input)
  })
}

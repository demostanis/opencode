import { Global } from "@/global"
import { Database } from "bun:sqlite"
import { randomBytes, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"

export namespace Owner {
  const version = 1
  const Entry = z.object({
    version: z.number(),
    id: z.string(),
    pid: z.number().int().positive(),
    dir: z.string(),
    password: z.string(),
    started: z.number(),
  })
  const Row = Entry.extend({
    url: z.string().nullable(),
  })

  type Record = z.infer<typeof Entry>
  export type Info = Record & { url: string }

  function open(root: string) {
    const db = new Database(location(root), { create: true })
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(`
      CREATE TABLE IF NOT EXISTS backend (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        dir TEXT NOT NULL,
        password TEXT NOT NULL,
        started INTEGER NOT NULL,
        url TEXT
      );
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_session (
        session_id TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        started INTEGER NOT NULL,
        PRIMARY KEY (session_id, backend_id)
      );
      CREATE INDEX IF NOT EXISTS active_session_backend_id_idx ON active_session (backend_id);
      CREATE INDEX IF NOT EXISTS active_session_session_id_idx ON active_session (session_id);
    `)
    return db
  }

  function valid(value: string) {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    if (url.protocol !== "http:") return false
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  }

  async function alive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err) return err.code !== "ESRCH"
      return true
    }
  }

  async function probe(value: Info) {
    if (!valid(value.url)) return false
    return fetch(new URL("/global/health", value.url), {
      headers: headers(value),
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false)
  }

  function remove(db: Database, id: string) {
    db.transaction(() => {
      db.query("DELETE FROM active_session WHERE backend_id = ?").run(id)
      db.query("DELETE FROM backend WHERE id = ?").run(id)
    })()
  }

  export function location(root = path.join(Global.Path.state, "tui")) {
    return path.join(root, "owner.sqlite")
  }

  export function headers(value: Pick<Record, "password">) {
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${value.password}`).toString("base64")}`,
    }
  }

  export async function create(input: { dir: string; root?: string }) {
    const root = input.root ?? path.join(Global.Path.state, "tui")
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await fs.chmod(root, 0o700).catch(() => {})
    const db = open(root)
    await fs.chmod(location(root), 0o600).catch(() => {})
    const info = {
      version,
      id: randomUUID(),
      pid: process.pid,
      dir: input.dir,
      password: randomBytes(32).toString("base64url"),
      started: Date.now(),
    }
    db.query("INSERT INTO backend (id, version, pid, dir, password, started) VALUES (?, ?, ?, ?, ?, ?)").run(
      info.id,
      info.version,
      info.pid,
      info.dir,
      info.password,
      info.started,
    )
    let released = false

    return {
      info,
      async ready(url: string) {
        if (!valid(url)) throw new Error("OpenCode backend returned an invalid attachment URL")
        const result = db.query("UPDATE backend SET url = ? WHERE id = ?").run(url, info.id)
        if (result.changes !== 1) throw new Error("OpenCode backend registration changed during startup")
      },
      active(sessionID: string, directory: string, value: boolean) {
        if (released) return
        if (!value) {
          db.query("DELETE FROM active_session WHERE session_id = ? AND backend_id = ?").run(sessionID, info.id)
          return
        }
        db.query(
          "INSERT INTO active_session (session_id, backend_id, directory, started) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, backend_id) DO UPDATE SET directory = excluded.directory, started = excluded.started",
        ).run(sessionID, info.id, directory, Date.now())
      },
      async release() {
        if (released) return
        remove(db, info.id)
        released = true
        db.close()
      },
    }
  }

  export async function find(
    sessionID: string,
    input: {
      root?: string
      probe?: (info: Info) => boolean | Promise<boolean>
      alive?: (pid: number) => boolean | Promise<boolean>
    } = {},
  ) {
    const root = input.root ?? path.join(Global.Path.state, "tui")
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const db = open(root)
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = db
        .query(
          "SELECT backend.version, backend.id, backend.pid, backend.dir, backend.password, backend.started, backend.url FROM active_session JOIN backend ON backend.id = active_session.backend_id WHERE active_session.session_id = ? ORDER BY active_session.started DESC",
        )
        .all(sessionID)
      for (const row of rows) {
        const result = Row.safeParse(row)
        if (!result.success || !result.data.url) continue
        const info = { ...result.data, url: result.data.url }
        if (seen.has(info.id)) continue
        seen.add(info.id)
        const living = await (input.alive ?? alive)(info.pid)
        if (!living) {
          remove(db, info.id)
          continue
        }
        if (info.version !== version || !(await (input.probe ?? probe)(info))) continue
        const latest = db
          .query(
            "SELECT backend.url FROM active_session JOIN backend ON backend.id = active_session.backend_id WHERE active_session.session_id = ? AND active_session.backend_id = ?",
          )
          .get(sessionID, info.id) as { url: string | null } | null
        if (latest?.url === info.url) {
          db.close()
          return info
        }
      }
    }
    db.close()
    return
  }
}

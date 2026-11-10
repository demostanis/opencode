import { Global } from "@/global"
import { GlobalBus } from "@/bus/global"
import { Database, eq, and, sql } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable, MessageTable, PartTable, SyncTable, SyncStateTable } from "./session.sql"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { Active } from "./active"
import { Log } from "@/util/log"
import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Database as SQLite } from "bun:sqlite"
import { Rpc } from "@/util/rpc"
import type { rpc } from "./sync-worker"
import { Teammate } from "@/teammate/teammate"
import { SyncLease } from "./sync-lease"
import { root } from "./sync-path"

declare const OPENCODE_SYNC_WORKER_PATH: string | undefined

export namespace SessionSync {
  const log = Log.create({ service: "session-sync" })
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const location = (machine: string, id: string, dir = root) => path.join(dir, "sessions", machine, id)
  const archive = /^\d+-[a-f0-9]{64}\.json$/
  const initialized = new WeakSet<object>()

  function initialize() {
    const client = Database.Client()
    if (initialized.has(client)) return
    Database.transaction((db) => {
      db.run(sql`UPDATE session_sync_state SET version = version WHERE 0`)
      const marker = db.get(
        sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'session_sync_tree_delete'`,
      )
      // Persist the upgrade marker in the trigger itself, not in a user session or remote mapping.
      if (!marker) db.run(sql`UPDATE session_sync_state SET version = version + 1`)
      db.run(sql`CREATE TRIGGER IF NOT EXISTS session_sync_tree_delete BEFORE DELETE ON session BEGIN
        UPDATE session_sync_state SET version = version + 1 WHERE session_id IN (
          WITH RECURSIVE ancestors(id) AS (
            SELECT OLD.parent_id UNION SELECT session.parent_id FROM session JOIN ancestors ON session.id = ancestors.id
          ) SELECT id FROM ancestors WHERE id IS NOT NULL
        );
      END`)
      db.run(sql`CREATE TRIGGER IF NOT EXISTS session_sync_tree_move AFTER UPDATE OF parent_id ON session
        WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN
        UPDATE session_sync_state SET version = version + 1 WHERE session_id IN (
          WITH RECURSIVE ancestors(id) AS (
            SELECT OLD.parent_id UNION SELECT session.parent_id FROM session JOIN ancestors ON session.id = ancestors.id
          ) SELECT id FROM ancestors WHERE id IS NOT NULL
        );
      END`)
    })
    initialized.add(client)
  }

  function registry(db: Database.TxOrDb) {
    return db
      .select({
        id: SessionTable.id,
        parent_id: SessionTable.parent_id,
        project_id: SessionTable.project_id,
        permission: SessionTable.permission,
        directory: SessionTable.directory,
      })
      .from(SessionTable)
      .all()
  }

  function ancestor(id: SessionID) {
    return Database.use((db) => {
      const fields = {
        id: SessionTable.id,
        parent_id: SessionTable.parent_id,
        project_id: SessionTable.project_id,
        permission: SessionTable.permission,
      }
      const seen = new Set<string>()
      let row = db.select(fields).from(SessionTable).where(eq(SessionTable.id, id)).get()
      while (row) {
        if (Teammate.session(undefined, row.permission ?? undefined)) return null
        if (seen.has(row.id)) return
        seen.add(row.id)
        if (!row.parent_id) return row.id
        const parent = db.select(fields).from(SessionTable).where(eq(SessionTable.id, row.parent_id)).get()
        if (parent?.project_id !== row.project_id) return
        row = parent
      }
    })
  }
  function roots(rows: Pick<typeof SessionTable.$inferSelect, "id" | "parent_id" | "project_id" | "permission">[]) {
    const map = new Map(rows.map((row) => [row.id, row]))
    const result = new Map<SessionID, SessionID | null | undefined>()
    for (const row of rows) {
      const trail: SessionID[] = []
      const seen = new Set<SessionID>()
      let cursor = row
      while (!result.has(cursor.id)) {
        if (seen.has(cursor.id)) {
          result.set(cursor.id, undefined)
          break
        }
        seen.add(cursor.id)
        trail.push(cursor.id)
        if (Teammate.session(undefined, cursor.permission ?? undefined)) {
          result.set(cursor.id, null)
          break
        }
        if (!cursor.parent_id) {
          result.set(cursor.id, cursor.id)
          break
        }
        const parent = map.get(cursor.parent_id)
        if (!parent || parent.project_id !== cursor.project_id) {
          result.set(cursor.id, undefined)
          break
        }
        cursor = parent
      }
      for (const id of trail) result.set(id, result.get(cursor.id))
    }
    return result
  }

  // Namespaced task rows retain source references and a generated-part hash without changing portable tool metadata.
  const References = z.object({
    input: z.string().optional(),
    session: z.string().optional(),
    metadata: z.string().optional(),
    state: z.string().optional(),
    output: z.string().optional(),
  })
  const Task = z.object({
    root: SessionID.zod,
    refs: References,
    hash: z.string(),
    targets: z.string().optional(),
  })

  function references(part: MessageV2.Part): z.infer<typeof References> {
    if (part.type !== "tool" || part.tool !== "task") return {}
    const id = (value: unknown) => (SessionID.zod.safeParse(value).success ? (value as string) : undefined)
    return {
      input: id(part.state.input.task_id),
      session: id(part.state.input.session_id),
      metadata: id(part.metadata?.sessionId),
      state: id("metadata" in part.state ? part.state.metadata?.sessionId : undefined),
      output: id(
        part.state.status === "completed" ? /^task_id: (ses_[^\s]+)(?=\s|$)/.exec(part.state.output)?.[1] : undefined,
      ),
    }
  }

  function task(
    part: MessageV2.Part,
    resolve: (id: string) => string | undefined,
    refs = references(part),
  ): MessageV2.Part {
    if (part.type !== "tool" || part.tool !== "task") return part
    return {
      ...part,
      ...(refs.metadata ? { metadata: { ...part.metadata, sessionId: resolve(refs.metadata) } } : {}),
      state: {
        ...part.state,
        input: {
          ...part.state.input,
          ...(refs.input ? { task_id: resolve(refs.input) } : {}),
          ...(refs.session ? { session_id: resolve(refs.session) } : {}),
        },
        ...("metadata" in part.state && part.state.metadata && refs.state
          ? { metadata: { ...part.state.metadata, sessionId: resolve(refs.state) } }
          : {}),
        ...(part.state.status === "completed" && refs.output
          ? {
              output: part.state.output.replace(
                /^(task_id: )[^\s]+(?=\s|$)/,
                (_, prefix: string) => `${prefix}${resolve(refs.output!) ?? "unavailable"}`,
              ),
            }
          : {}),
      },
    }
  }

  function targets(refs: z.infer<typeof References>, resolve: (id: string) => string | undefined) {
    return digest(
      [refs.input, refs.session, refs.metadata, refs.state, refs.output].map((id) => (id ? resolve(id) : undefined)),
    )
  }

  function relink() {
    Database.transaction((db) => {
      const entries = db.select().from(SyncTable).all()
      const live = registry(db)
      const sessions = new Map(live.map((row) => [row.id, row]))
      const ancestors = roots(live)
      const mappings = new Map(
        entries
          .filter((entry) => !entry.source_id.startsWith("task:"))
          .map((entry) => [`${entry.machine}:${entry.source_id}`, entry]),
      )
      const baselines = new Map<SessionID, boolean>()
      for (const entry of entries.filter((entry) => entry.source_id.startsWith("task:"))) {
        const parsed = Task.safeParse(JSON.parse(entry.baseline))
        if (!parsed.success) continue
        const mark = parsed.data
        if (!sessions.has(mark.root)) {
          db.delete(SyncTable)
            .where(and(eq(SyncTable.machine, entry.machine), eq(SyncTable.source_id, entry.source_id)))
            .run()
          continue
        }
        const resolve = (source: string) => {
          const mapping = mappings.get(`${entry.machine}:${source}`)
          const target = mapping && sessions.get(SessionID.make(mapping.local_id))
          return target && ancestors.get(target.id) ? target.id : undefined
        }
        const signature = targets(mark.refs, resolve)
        if (signature === mark.targets) continue
        const part = db
          .select()
          .from(PartTable)
          .where(eq(PartTable.id, PartID.make(entry.local_id)))
          .get()
        if (!part) {
          db.delete(SyncTable)
            .where(and(eq(SyncTable.machine, entry.machine), eq(SyncTable.source_id, entry.source_id)))
            .run()
          continue
        }
        if (digest(part.data) !== mark.hash || ancestors.get(part.session_id) !== mark.root) continue
        const full = {
          ...part.data,
          id: part.id,
          messageID: part.message_id,
          sessionID: part.session_id,
        } as MessageV2.Part
        const mapped = task(full, resolve, mark.refs)
        const { id: _, messageID: __, sessionID: ___, ...content } = mapped
        const hash = digest(content)
        if (hash === mark.hash) {
          db.update(SyncTable)
            .set({ baseline: JSON.stringify({ ...mark, targets: signature }) })
            .where(and(eq(SyncTable.machine, entry.machine), eq(SyncTable.source_id, entry.source_id)))
            .run()
          continue
        }
        if (!baselines.has(mark.root)) {
          const current = snapshot(mark.root)
          const mapping = entries.find((row) => row.local_id === mark.root && !row.source_id.startsWith("task:"))
          baselines.set(mark.root, !!current && !!mapping && matches(current, mapping.baseline))
        }
        db.update(PartTable).set({ data: content }).where(eq(PartTable.id, part.id)).run()
        db.update(SyncTable)
          .set({ baseline: JSON.stringify({ ...mark, hash, targets: signature }) })
          .where(and(eq(SyncTable.machine, entry.machine), eq(SyncTable.source_id, entry.source_id)))
          .run()
        Database.effect(() =>
          GlobalBus.emit("event", {
            directory: sessions.get(part.session_id)!.directory,
            payload: { type: MessageV2.Event.PartUpdated.type, properties: { part: mapped } },
          }),
        )
      }
      for (const [root, clean] of baselines) {
        if (!clean) continue
        const current = snapshot(root)!
        const baseline = fingerprint(current)
        for (const node of [current, ...current.children]) {
          db.update(SyncTable).set({ baseline }).where(eq(SyncTable.local_id, node.session.id)).run()
          db.update(SyncStateTable)
            .set({ exported: sql`${SyncStateTable.version}` })
            .where(eq(SyncStateTable.session_id, node.session.id))
            .run()
        }
      }
    })
  }

  const order = (a: string, b: string) => {
    const x = BigInt(a.slice(0, a.indexOf("-")))
    const y = BigInt(b.slice(0, b.indexOf("-")))
    return x === y ? a.localeCompare(b) : x < y ? -1 : 1
  }

  async function read(file: string, expected?: number) {
    const handle = await fs.open(file, "r").catch((err) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    if (!handle) {
      log.debug("sync file pending", { file })
      return
    }
    try {
      const stat = await handle.stat()
      if (stat.size > 50_000_000 || (expected !== undefined && stat.size !== expected)) {
        log.warn("sync file size mismatch", {
          file,
          expected,
          actual: stat.size,
          limit: 50_000_000,
        })
        return
      }
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      const actual = (await handle.stat()).size
      if (offset !== bytes.length || actual !== bytes.length) {
        log.debug("sync file changed during read", {
          file,
          expected: bytes.length,
          actual,
          read: offset,
        })
        return
      }
      return bytes
    } catch (err) {
      log.warn("sync file read failed", { file, error: String(err) })
      throw err
    } finally {
      await handle.close()
    }
  }

  async function write(file: string, text: string) {
    const temp = `${file}.${randomUUID()}.tmp`
    await fs
      .writeFile(temp, text, { mode: 0o600 })
      .then(() => fs.rename(temp, file))
      .catch(async (err) => {
        await fs.rm(temp, { force: true })
        throw err
      })
  }

  async function prune(folder: string) {
    const files = (
      await fs.readdir(folder).catch((err) => {
        if (err.code === "ENOENT") return []
        throw err
      })
    )
      .filter((name) => archive.test(name))
      .sort(order)
    await Promise.all(files.slice(0, -2).map((name) => fs.rm(path.join(folder, name), { force: true })))
  }

  async function sessions() {
    const rows = Database.use(registry)
    const children = new Set(
      rows
        .filter((row) => row.parent_id || Teammate.session(undefined, row.permission ?? undefined))
        .map((row) => row.id),
    )
    const ids = new Set(rows.filter((row) => !children.has(row.id)).map((row) => row.id))
    for (const file of await fs.readdir(Global.Path.data)) {
      if (!/^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/.test(file) || path.join(Global.Path.data, file) === Database.Path)
        continue
      using db = new SQLite(path.join(Global.Path.data, file), { readonly: true })
      const fields = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(session)")
          .all()
          .map((row) => row.name),
      )
      const entries = db
        .query<{ id: string; permission: string | null; parent_id: string | null }, []>(
          `SELECT id, ${fields.has("permission") ? "permission" : "NULL AS permission"},
          ${fields.has("parent_id") ? "parent_id" : "NULL AS parent_id"} FROM session`,
        )
        .all()
      const map = new Map(entries.map((row) => [row.id, row]))
      const cache = new Map<string, boolean>()
      const excluded = (id: string) => {
        const seen = new Set<string>()
        const trail: string[] = []
        let row = map.get(id)
        while (row && !cache.has(row.id) && !seen.has(row.id)) {
          trail.push(row.id)
          seen.add(row.id)
          if (
            row.permission &&
            Teammate.session(undefined, Session.Info.shape.permission.parse(JSON.parse(row.permission)))
          ) {
            cache.set(row.id, true)
            break
          }
          row = row.parent_id ? map.get(row.parent_id) : undefined
        }
        const value = row ? (cache.get(row.id) ?? false) : false
        for (const id of trail) cache.set(id, value)
        return value
      }
      for (const row of entries) {
        if (excluded(row.id)) continue
        // Another channel must retain its legacy child archives until its own worker can bundle them.
        ids.add(SessionID.make(row.id))
      }
    }
    return ids
  }

  export async function clean(dir = root) {
    initialize()
    const folder = path.join(dir, "sessions", await Active.machine)
    const ids = await sessions()
    const folders = await fs.readdir(folder, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") return []
      throw err
    })
    for (const session of folders) {
      if (!session.isDirectory() || !SessionID.zod.safeParse(session.name).success) continue
      const target = path.join(folder, session.name)
      if (ids.has(SessionID.make(session.name))) {
        await prune(target)
        continue
      }
      const row = Database.use((db) =>
        db
          .select({ parent: SessionTable.parent_id, permission: SessionTable.permission })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(session.name)))
          .get(),
      )
      if (
        !row &&
        Database.use((db) =>
          db
            .select({ permission: SessionTable.permission })
            .from(SessionTable)
            .where(eq(SessionTable.parent_id, SessionID.make(session.name)))
            .all(),
        ).some((child) => !Teammate.session(undefined, child.permission ?? undefined))
      ) {
        await prune(target)
        continue
      }
      if (row?.parent && ancestor(SessionID.make(session.name)) !== null) {
        // Legacy archives may be the only recovery copy; cleanup must not depend on exporting a tree.
        await prune(target)
        continue
      }
      if (
        !row?.parent &&
        !Teammate.session(undefined, row?.permission ?? undefined) &&
        (await sessions()).has(SessionID.make(session.name))
      )
        continue
      await fs.rm(target, { recursive: true, force: true })
    }
  }

  function snapshot(id: SessionID) {
    return Database.transaction((db) => {
      const row = db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
      if (!row) return
      if (row.parent_id || Teammate.session(undefined, row.permission ?? undefined)) return
      const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id)).get()
      if (!project) return
      const history = (row: typeof SessionTable.$inferSelect) => {
        const id = row.id
        const messages = db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, id))
          .orderBy(MessageTable.time_created, MessageTable.id)
          .all()
        const parts = db.select().from(PartTable).where(eq(PartTable.session_id, id)).orderBy(PartTable.id).all()
        const ids = new Set(messages.map((msg) => msg.id))
        if (parts.some((part) => !ids.has(part.message_id)))
          throw new Error(`Session ${id} contains a part without its message`)
        const grouped = Map.groupBy(parts, (part) => part.message_id)
        return {
          session: Session.fromRow(row),
          messages: messages.map((msg) => ({
            info: { ...msg.data, id: msg.id, sessionID: id },
            parts: (grouped.get(msg.id) ?? []).map(
              (part) =>
                ({
                  ...part.data,
                  id: part.id,
                  messageID: msg.id,
                  sessionID: id,
                }) as MessageV2.Part,
            ),
          })),
        }
      }
      const children: ReturnType<typeof history>[] = []
      const seen = new Set([id])
      const stack = [row]
      while (stack.length) {
        const parent = stack.pop()!
        if (parent.id !== id) children.push(history(parent))
        const rows = db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, parent.id))
          .orderBy(SessionTable.id)
          .all()
        for (const child of rows.reverse()) {
          if (Teammate.session(undefined, child.permission ?? undefined)) continue
          if (seen.has(child.id) || child.project_id !== row.project_id)
            throw new Error(`Invalid subagent tree for ${id}`)
          seen.add(child.id)
          stack.push(child)
        }
      }
      return {
        version: 2 as const,
        machine: "",
        notice:
          "Conversation transferred from another host. Files, snapshots and worktree may be missing on this host.",
        ...history(row),
        project: { worktree: project.worktree, name: project.name },
        children,
      }
    })
  }

  function fingerprint(data: NonNullable<ReturnType<typeof snapshot>>) {
    // Match the logical v2 snapshot hash without allocating a tree-sized string.
    const { children, ...head } = data
    const hash = createHash("sha256").update(JSON.stringify(head).slice(0, -1)).update(',"children":[')
    for (const [index, child] of children.entries()) {
      if (index) hash.update(",")
      hash.update(JSON.stringify(child))
    }
    return hash.update("]}").digest("hex")
  }

  function matches(data: NonNullable<ReturnType<typeof snapshot>>, baseline: string) {
    if (fingerprint(data) === baseline) return true
    if (data.children.length) return false
    return (
      digest({
        version: 1,
        machine: data.machine,
        notice: data.notice,
        session: data.session,
        project: data.project,
        messages: data.messages,
      }) === baseline
    )
  }

  export async function exportSession(id: SessionID, dir = root) {
    return publish(id, dir, new Set<SessionID>())
  }

  async function publish(id: SessionID, dir: string, seen: Set<SessionID>, dependency = false) {
    initialize()
    const parent = ancestor(id)
    if (parent === null) return
    if (!parent) throw new Error(`Cannot export sync session ${id}: missing, cyclic or cross-project parent`)
    id = parent
    if (seen.has(id)) return
    seen.add(id)
    const data = snapshot(id)
    if (!data) throw new Error(`Cannot snapshot sync tree ${id}`)
    const synced = Database.use((db) => db.select().from(SyncTable).where(eq(SyncTable.local_id, id)).all())
    if (!dependency && synced.some((item) => matches(data, item.baseline))) return
    const machine = await Active.machine
    const ancestors = roots(Database.use(registry))
    const dependencies = new Set<SessionID>()
    for (const node of [data, ...data.children]) {
      for (const msg of node.messages) {
        for (const part of msg.parts) {
          for (const source of Object.values(references(part))) {
            const parent = source && ancestors.get(SessionID.make(source))
            if (parent && parent !== id) dependencies.add(parent)
          }
        }
      }
    }
    // A forwarded task uses this host's IDs, so its dependency must be available under this host too.
    for (const parent of dependencies) await publish(parent, dir, seen, true)
    const inline = (messages: typeof data.messages) =>
      Promise.all(
        messages.map(async (msg) => ({
          ...msg,
          parts: await Promise.all(
            msg.parts.map(async (part) => {
              if (part.type !== "file" || !part.url.startsWith("file://")) return part
              const { fileURLToPath } = await import("url")
              const file = (() => {
                try {
                  return fileURLToPath(part.url)
                } catch {
                  return undefined
                }
              })()
              if (!file) return part
              const stat = await fs.stat(file).catch(() => undefined)
              if (!stat || stat.size > 5_000_000) return part
              const bytes = await fs.readFile(file).catch(() => undefined)
              if (!bytes || bytes.length > 5_000_000) return part
              return { ...part, url: `data:${part.mime};base64,${bytes.toString("base64")}` }
            }),
          ),
        })),
      )
    const bundle = {
      ...data,
      machine,
      messages: await inline(data.messages),
      children: await Promise.all(
        data.children.map(async (child) => ({ ...child, messages: await inline(child.messages) })),
      ),
    }
    const folder = location(machine, id, dir)
    const nodes = [{ session: bundle.session, messages: bundle.messages }, ...bundle.children]
    const texts = nodes.map((node) => JSON.stringify(node))
    const sizes = texts.map((text) => Buffer.byteLength(text))
    const oversized = sizes.findIndex((size) => size > 50_000_000)
    if (oversized >= 0)
      throw new Error(
        `Sync node ${nodes[oversized].session.id} in tree ${id} is ${sizes[oversized]} bytes; limit is 50000000 bytes`,
      )
    // Keep small trees as v2; v3 commits its manifest only after every bounded node is written.
    const total = sizes.reduce((sum, size) => sum + size, 0)
    const packed = total <= 50_000_000 ? JSON.stringify(bundle) : undefined
    const sharded = !packed || Buffer.byteLength(packed) > 50_000_000
    const refs = texts.map((text, index) => ({
      sha: createHash("sha256").update(text).digest("hex"),
      size: sizes[index],
    }))
    const text = sharded
      ? JSON.stringify({
          version: 3,
          machine,
          notice: bundle.notice,
          project: bundle.project,
          source: id,
          nodes: refs,
        })
      : packed!
    if (Buffer.byteLength(text) > 50_000_000) throw new Error(`Sync manifest for ${id} exceeds the 50MB manifest limit`)
    await fs.mkdir(folder, { recursive: true })
    if (sharded) {
      await fs.mkdir(path.join(folder, "nodes"), { recursive: true })
      for (const [index, ref] of refs.entries()) {
        const file = path.join(folder, "nodes", `${ref.sha}.json`)
        const bytes = await read(file, ref.size)
        if (bytes && createHash("sha256").update(bytes).digest("hex") === ref.sha) continue
        await write(file, texts[index])
      }
      // Nodes are immutable recovery data. Garbage collection is deliberately deferred, including nodes of old manifests.
    }
    const hash = createHash("sha256").update(text).digest("hex")
    const latest = (await fs.readdir(folder))
      .filter((name) => archive.test(name))
      .sort(order)
      .at(-1)
    if (latest?.endsWith(`-${hash}.json`)) {
      await prune(folder)
      return
    }
    const time = Math.max(Date.now(), latest ? Number(latest.slice(0, latest.indexOf("-"))) + 1 : 0)
    const file = path.join(folder, `${time}-${hash}.json`)
    await write(file, text)
    await prune(folder)
  }

  async function importOne(file: string, machine: string, source: string, revision: string) {
    const prev = Database.use((db) =>
      db
        .select()
        .from(SyncTable)
        .where(and(eq(SyncTable.machine, machine), eq(SyncTable.source_id, source)))
        .get(),
    )
    if (prev && order(prev.revision, revision) >= 0) return true
    const History = z.object({
      session: Session.Info,
      messages: z.array(z.object({ info: MessageV2.Info, parts: z.array(MessageV2.Part) })),
    })
    const Bundle = History.extend({
      version: z.union([z.literal(1), z.literal(2)]),
      machine: z.string().min(1),
      notice: z.string(),
      project: z.object({ worktree: z.string(), name: z.string().nullable() }),
      children: z.array(History).optional(),
    })
    const match = /^(\d+)-([a-f0-9]{64})\.json$/.exec(revision)
    if (!match) return false
    const bytes = await read(file)
    if (!bytes) return false
    const raw = bytes.toString("utf8")
    let json = JSON.parse(raw) as unknown
    if (digest(json) !== match[2]) {
      log.warn("sync archive checksum mismatch", { file })
      return false
    }
    const Manifest = z.object({
      version: z.literal(3),
      machine: z.string(),
      source: SessionID.zod,
      notice: z.string(),
      project: z.object({ worktree: z.string(), name: z.string().nullable() }),
      nodes: z
        .array(
          z.object({
            sha: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().min(1).max(50_000_000),
          }),
        )
        .min(1),
    })
    if (typeof json === "object" && json !== null && "version" in json && json.version === 3) {
      const manifest = Manifest.safeParse(json)
      if (!manifest.success || manifest.data.machine !== machine || manifest.data.source !== source) return false
      const histories: z.infer<typeof History>[] = []
      for (const ref of manifest.data.nodes) {
        const node = path.join(path.dirname(file), "nodes", `${ref.sha}.json`)
        const bytes = await read(node, ref.size)
        if (!bytes) return false
        const hash = createHash("sha256").update(bytes).digest("hex")
        if (bytes.length !== ref.size || hash !== ref.sha) {
          log.warn("sync node checksum mismatch", {
            file: node,
            expected: ref.sha,
            actual: hash,
            size: bytes.length,
          })
          return false
        }
        const history = History.safeParse(JSON.parse(bytes.toString("utf8")))
        if (!history.success) {
          log.warn("invalid sync node", { file: node, error: history.error.message })
          return false
        }
        histories.push(history.data)
      }
      json = {
        version: 2,
        machine,
        notice: manifest.data.notice,
        project: manifest.data.project,
        ...histories[0],
        children: histories.slice(1),
      }
    }
    const parsed = Bundle.safeParse(json)
    if (!parsed.success) {
      log.warn("invalid sync archive", { file, error: parsed.error.message })
      return false
    }
    const data = parsed.data
    if (data.machine !== machine || data.session.id !== source) return false
    if (data.session.parentID || Teammate.session(undefined, data.session.permission)) return true
    if (data.version === 1 && data.children?.length) return false
    const nodes = [data, ...(data.children ?? [])]
    const tree = new Map(nodes.map((node) => [node.session.id, node]))
    if (tree.size !== nodes.length) return false
    const edges = Map.groupBy(nodes.slice(1), (node) => node.session.parentID)
    const queue = [data.session.id]
    for (let index = 0; index < queue.length; index++) {
      for (const node of edges.get(queue[index]) ?? []) queue.push(node.session.id)
    }
    if (queue.length !== nodes.length) return false
    const mids = new Set<string>()
    const pids = new Set<string>()
    for (const node of nodes) {
      if (node.session.projectID !== data.session.projectID || Teammate.session(undefined, node.session.permission))
        return false
      if (
        node.messages.some(
          (msg) =>
            msg.info.sessionID !== node.session.id ||
            msg.parts.some((part) => part.messageID !== msg.info.id || part.sessionID !== node.session.id),
        )
      )
        return false
      const ids = new Set(node.messages.map((msg) => msg.info.id))
      if (
        ids.size !== node.messages.length ||
        node.messages.some((msg) => msg.info.role === "assistant" && !ids.has(msg.info.parentID))
      )
        return false
      for (const msg of node.messages) {
        if (mids.has(msg.info.id)) return false
        mids.add(msg.info.id)
        for (const part of msg.parts) {
          if (pids.has(part.id)) return false
          pids.add(part.id)
        }
      }
    }
    const before = prev && snapshot(SessionID.make(prev.local_id))
    const active = before ? [before.session.id, ...before.children.map((child) => child.session.id)] : []
    const busy = (await Promise.all(active.map((id) => Active.remote(id, { machine: "" })))).some(Boolean)

    Database.transaction((db) => {
      const prev = db
        .select()
        .from(SyncTable)
        .where(and(eq(SyncTable.machine, machine), eq(SyncTable.source_id, source)))
        .get()
      if (prev && order(prev.revision, revision) >= 0) return
      const current =
        prev &&
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(prev.local_id)))
          .get()
      if (prev && !current) {
        db.update(SyncTable)
          .set({ revision })
          .where(and(eq(SyncTable.machine, machine), eq(SyncTable.source_id, source)))
          .run()
        return
      }
      if (current?.parent_id) throw new Error(`Sync root ${source} is already a child`)
      const local = current && snapshot(current.id)
      const old = local ? [local, ...local.children] : []
      const owned = new Set(old.map((node) => node.session.id))
      const changed =
        !!prev &&
        (!local ||
          !matches(local, prev.baseline) ||
          old.some((node) => Active.local(node.session.id)) ||
          busy ||
          (data.version === 1 && old.length > 1))
      const entries = db.select().from(SyncTable).where(eq(SyncTable.machine, machine)).all()
      const mappings = new Map(entries.map((entry) => [entry.source_id, entry]))
      const live = new Map(registry(db).map((row) => [row.id, row]))
      const ancestors = roots([...live.values()])
      // Source IDs are scoped to a host, and existing children must belong to this exact local tree.
      if (
        nodes.slice(1).some((node) => {
          const entry = mappings.get(node.session.id)
          const target = entry && live.get(SessionID.make(entry.local_id))
          return target && ancestors.get(target.id) && !owned.has(target.id)
        })
      )
        throw new Error(`Sync tree ${source} reuses a child from another parent`)
      const links = new Map(
        nodes.map((node) => {
          const entry = mappings.get(node.session.id)
          return [
            node.session.id,
            current && !changed && entry && owned.has(SessionID.make(entry.local_id))
              ? SessionID.make(entry.local_id)
              : SessionID.descending(),
          ]
        }),
      )
      const root = links.get(data.session.id)!
      const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, data.session.projectID)).get()
      if (!project)
        db.insert(ProjectTable)
          .values({
            id: data.session.projectID,
            worktree: data.project.worktree,
            name: data.project.name,
            sandboxes: [],
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
      const translate = (value: string) => {
        if (!project) return value
        const relative = path.relative(data.project.worktree, value)
        if (
          !path.isAbsolute(data.project.worktree) ||
          !path.isAbsolute(value) ||
          path.isAbsolute(relative) ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`)
        )
          return project.worktree
        return path.join(project.worktree, relative)
      }
      for (const node of nodes) {
        const id = links.get(node.session.id)!
        const existing = owned.has(id)
        const data = { ...node, project: parsed.data.project }
        const dir = translate(data.session.directory)
        const row = Session.toRow({
          ...data.session,
          id,
          directory: dir,
          parentID: data.session.parentID ? links.get(data.session.parentID)! : undefined,
          workspaceID: undefined,
          share: undefined,
          revert: undefined,
          permission: undefined,
          title: id === root ? `${data.session.title} (from another host)` : data.session.title,
        })
        if (existing) {
          db.delete(MessageTable).where(eq(MessageTable.session_id, id)).run()
          db.update(SessionTable).set(row).where(eq(SessionTable.id, id)).run()
        } else db.insert(SessionTable).values(row).run()
        const map = new Map(data.messages.map((msg) => [msg.info.id, MessageID.ascending()]))
        data.messages.forEach((msg) => {
          const mid = map.get(msg.info.id)!
          const info = {
            ...msg.info,
            id: mid,
            sessionID: id,
            ...(msg.info.role === "assistant" ? { parentID: map.get(msg.info.parentID)! } : {}),
            ...(msg.info.role === "assistant"
              ? { path: { cwd: translate(msg.info.path.cwd), root: translate(msg.info.path.root) } }
              : {}),
          }
          const { id: _, sessionID: __, ...value } = info
          db.insert(MessageTable)
            .values({
              id: mid,
              session_id: id,
              time_created: info.time.created,
              time_updated: info.time.created,
              data: value,
            })
            .run()
          msg.parts.forEach((part) => {
            const refs = references(part)
            const resolve = (source: string) => {
              const inside = links.get(SessionID.make(source))
              if (inside) return inside
              const entry = mappings.get(source)
              const target = entry && live.get(SessionID.make(entry.local_id))
              return target && ancestors.get(target.id) ? target.id : undefined
            }
            const mapped = task(part, resolve, refs)
            const { id: _, messageID: __, sessionID: ___, ...content } = mapped
            const pid = PartID.ascending()
            db.insert(PartTable)
              .values({
                id: pid,
                message_id: mid,
                session_id: id,
                time_created: Date.now(),
                time_updated: Date.now(),
                data: content,
              })
              .run()
            if (Object.values(refs).some(Boolean)) {
              const key = `task:${JSON.stringify([source, part.id])}`
              const baseline = JSON.stringify({
                root,
                refs,
                hash: digest(content),
                targets: targets(refs, resolve),
              })
              db.insert(SyncTable)
                .values({ machine, source_id: key, local_id: pid, revision, baseline })
                .onConflictDoUpdate({
                  target: [SyncTable.machine, SyncTable.source_id],
                  set: { local_id: pid, revision, baseline },
                })
                .run()
            }
          })
        })
        const last = id === root ? data.messages.at(-1) : undefined
        const target = last?.info.role === "assistant" ? map.get(last.info.id)! : MessageID.ascending()
        if (last?.info.role === "user") {
          const info: MessageV2.Assistant = {
            id: target,
            sessionID: id,
            role: "assistant",
            parentID: map.get(last.info.id)!,
            time: { created: Date.now(), completed: Date.now() },
            modelID: last.info.model.modelID,
            providerID: last.info.model.providerID,
            mode: "build",
            agent: last.info.agent,
            path: { cwd: dir, root: project?.worktree ?? data.project.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          const { id: _, sessionID: __, ...value } = info
          db.insert(MessageTable)
            .values({
              id: target,
              session_id: id,
              time_created: info.time.created,
              time_updated: info.time.created,
              data: value,
            })
            .run()
        }
        if (last) {
          const part: MessageV2.TextPart = {
            id: PartID.ascending(),
            messageID: target,
            sessionID: id,
            type: "text",
            text: "Conversation transferred from another host. Files, snapshots and worktree may be missing on this host.",
          }
          const { id: pid, messageID: pmid, sessionID: psid, ...content } = part
          db.insert(PartTable)
            .values({
              id: part.id,
              message_id: target,
              session_id: id,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: content,
            })
            .run()
        }
        Database.effect(() => {
          const info = Session.fromRow(row as typeof SessionTable.$inferSelect)
          GlobalBus.emit("event", {
            directory: dir,
            payload: {
              type: existing ? Session.Event.Updated.type : Session.Event.Created.type,
              properties: { info },
            },
          })
        })
      }
      if (current && !changed) {
        const retained = new Set(links.values())
        for (const node of old.filter((node) => !retained.has(node.session.id))) {
          db.delete(SessionTable).where(eq(SessionTable.id, node.session.id)).run()
          db.delete(SyncTable)
            .where(and(eq(SyncTable.machine, machine), eq(SyncTable.local_id, node.session.id)))
            .run()
          Database.effect(() =>
            GlobalBus.emit("event", {
              directory: node.session.directory,
              payload: { type: Session.Event.Deleted.type, properties: { info: node.session } },
            }),
          )
        }
      }
      for (const entry of entries.filter(
        (entry) => owned.has(SessionID.make(entry.local_id)) && !tree.has(SessionID.make(entry.source_id)),
      )) {
        db.delete(SyncTable)
          .where(and(eq(SyncTable.machine, machine), eq(SyncTable.source_id, entry.source_id)))
          .run()
      }
      const baseline = fingerprint(snapshot(root)!)
      for (const node of nodes) {
        const id = links.get(node.session.id)!
        db.insert(SyncTable)
          .values({ machine, source_id: node.session.id, local_id: id, revision, baseline })
          .onConflictDoUpdate({
            target: [SyncTable.machine, SyncTable.source_id],
            set: { local_id: id, revision, baseline },
          })
          .run()
        db.update(SyncStateTable)
          .set({ exported: sql`${SyncStateTable.version}` })
          .where(eq(SyncStateTable.session_id, id))
          .run()
      }
    })
    return true
  }

  export async function scan(dir = root) {
    initialize()
    const machine = await Active.machine
    const base = path.join(dir, "sessions")
    const hosts = await fs.readdir(base, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") return []
      throw err
    })
    for (const host of hosts.filter(
      (host) => host.isDirectory() && host.name !== machine && /^[a-zA-Z0-9-]+$/.test(host.name),
    )) {
      for (const session of await fs.readdir(path.join(base, host.name), { withFileTypes: true })) {
        if (!session.isDirectory() || !SessionID.zod.safeParse(session.name).success) continue
        const dir = path.join(base, host.name, session.name)
        const files = (await fs.readdir(dir)).filter((name) => archive.test(name)).sort(order)
        for (const name of files.reverse()) {
          const done = await importOne(path.join(dir, name), host.name, session.name, name).catch((err) => {
            log.warn("import failed", { file: name, error: String(err) })
            return false
          })
          if (done) break
        }
      }
    }
    relink()
  }

  export async function drain(dir = root, valid = () => true) {
    initialize()
    const rows = Database.use((db) =>
      db
        .select()
        .from(SyncStateTable)
        .where(sql`${SyncStateTable.version} != ${SyncStateTable.exported}`)
        .all(),
    )
    const ancestors = roots(Database.use(registry))
    const groups = Map.groupBy(rows, (row) => ancestors.get(SessionID.make(row.session_id)) ?? row.session_id)
    let count = 0
    for (const [id, group] of groups) {
      if (!valid()) break
      await exportSession(SessionID.make(id), dir)
        .then(() => {
          for (const row of group) {
            Database.use((db) =>
              db
                .update(SyncStateTable)
                .set({ exported: row.version })
                .where(and(eq(SyncStateTable.session_id, row.session_id), eq(SyncStateTable.version, row.version)))
                .run(),
            )
          }
          count++
        })
        .catch((err) => log.warn("export failed", { sessionID: id, error: String(err) }))
      await Bun.sleep(0)
    }
    return count
  }

  let worker: Worker | undefined
  let client: ReturnType<typeof Rpc.client<typeof rpc>> | undefined
  let ready: Promise<void> | undefined
  let pending: Promise<Awaited<ReturnType<typeof rpc.status>>> | undefined
  export const Status = z
    .object({
      state: z.enum(["enabled", "disabled", "unavailable"]),
      owner: z
        .boolean()
        .nullable()
        .describe("Whether this server's worker holds the sync lease; null when unknown or disabled"),
      running: z.boolean().describe("Whether this worker is executing a scheduler tick"),
      next: z
        .number()
        .nullable()
        .describe(
          "Next local timer deadline in epoch milliseconds: session sync for owners, lease check for followers, not Syncthing transfers",
        ),
      timestamp: z
        .number()
        .describe("Worker observation time in epoch milliseconds, for clock-skew-independent countdowns"),
      exported: z.number(),
    })
    .meta({ ref: "SessionSyncStatus" })

  export async function status(enabled = true): Promise<z.infer<typeof Status>> {
    const empty = { owner: null, running: false, next: null, timestamp: Date.now(), exported: 0 }
    if (!enabled) return { ...empty, state: "disabled" }
    if (!client || !ready) return { ...empty, state: "unavailable" }
    const current = client
    const request = (pending ??= ready
      .then(() => current.call("status", undefined))
      .finally(() => {
        if (pending === request) pending = undefined
      }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      request.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 2_000)
      }),
    ]).finally(() => clearTimeout(timeout))
    if (!result || client !== current) return { ...empty, state: "unavailable", timestamp: Date.now() }
    return { ...result, state: "enabled" }
  }

  export function start() {
    if (worker) return
    Database.Client()
    const owner = randomUUID()
    const lease = new SyncLease(`${Database.Path}.sync-v1`, owner)
    worker = new Worker(
      typeof OPENCODE_SYNC_WORKER_PATH !== "undefined"
        ? OPENCODE_SYNC_WORKER_PATH
        : new URL("./sync-worker.ts", import.meta.url).href,
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      },
    )
    if ("unref" in worker && typeof worker.unref === "function") worker.unref()
    client = Rpc.client<typeof rpc>(worker)
    const off = client.on<Parameters<typeof GlobalBus.emit<"event">>[1]>("event", (event) => {
      GlobalBus.emit("event", event)
    })
    client.on<string>("failure", (error) => log.warn("sync failed", { error }))
    ready = client.call("init", { source: Database.Path, owner })
    ready.catch((err) => log.warn("sync worker failed", { error: String(err) }))
    Database.onclose(() => {
      off()
      worker?.terminate()
      lease.close()
      worker = undefined
      client = undefined
      ready = undefined
      pending = undefined
    })
  }
}

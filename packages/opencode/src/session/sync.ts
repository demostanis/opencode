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

declare const OPENCODE_SYNC_WORKER_PATH: string | undefined

export namespace SessionSync {
  const log = Log.create({ service: "session-sync" })
  const root = path.join(Global.Path.home, ".local/share/opencode-sync")
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const location = (machine: string, id: string, dir = root) => path.join(dir, "sessions", machine, id)
  const archive = /^\d+-[a-f0-9]{64}\.json$/
  const order = (a: string, b: string) => {
    const x = BigInt(a.slice(0, a.indexOf("-")))
    const y = BigInt(b.slice(0, b.indexOf("-")))
    return x === y ? a.localeCompare(b) : x < y ? -1 : 1
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
    const rows = Database.use((db) => db.select().from(SessionTable).all())
    const children = new Set(
      rows
        .filter((row) => row.parent_id || Teammate.session(undefined, row.permission ?? undefined))
        .map((row) => row.id),
    )
    const copies = new Set(
      Database.use((db) => db.select().from(SyncTable).all())
        .filter((row) => children.has(SessionID.make(row.source_id)))
        .map((row) => row.local_id),
    )
    const ids = new Set(rows.filter((row) => !children.has(row.id) && !copies.has(row.id)).map((row) => row.id))
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
      for (const row of db
        .query<{ id: string; permission: string | null }, []>(
          `SELECT id, ${fields.has("permission") ? "permission" : "NULL AS permission"} FROM session
          WHERE ${fields.has("parent_id") ? "parent_id IS NULL" : "1"}`,
        )
        .all()) {
        if (
          row.permission &&
          Teammate.session(undefined, Session.Info.shape.permission.parse(JSON.parse(row.permission)))
        )
          continue
        ids.add(SessionID.make(row.id))
      }
    }
    return ids
  }

  export async function clean(dir = root) {
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
      const origins = db
        .select({ parent: SessionTable.parent_id, permission: SessionTable.permission })
        .from(SyncTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SyncTable.source_id))
        .where(eq(SyncTable.local_id, id))
        .all()
      if (origins.some((origin) => origin.parent || Teammate.session(undefined, origin.permission ?? undefined))) return
      const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id)).get()
      if (!project) return
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
        version: 1 as const,
        machine: "",
        notice:
          "Conversation transferred from another host. Files, snapshots and worktree may be missing on this host.",
        session: Session.fromRow(row),
        project: { worktree: project.worktree, name: project.name },
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
    })
  }

  export async function exportSession(id: SessionID, dir = root) {
    const data = snapshot(id)
    if (!data) return
    const synced = Database.use((db) => db.select().from(SyncTable).where(eq(SyncTable.local_id, id)).all())
    const baseline = synced.length ? digest(data) : undefined
    if (synced.some((item) => item.baseline === baseline)) return
    const machine = await Active.machine
    const bundle = {
      ...data,
      machine,
      messages: await Promise.all(
        data.messages.map(async (msg) => ({
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
      ),
    }
    const folder = location(machine, id, dir)
    const text = JSON.stringify(bundle)
    const hash = createHash("sha256").update(text).digest("hex")
    await fs.mkdir(folder, { recursive: true })
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
    const temp = `${file}.${randomUUID()}.tmp`
    await fs
      .writeFile(temp, text, { mode: 0o600 })
      .then(() => fs.rename(temp, file))
      .catch(async (err) => {
        await fs.rm(temp, { force: true })
        throw err
      })
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
    const Bundle = z.object({
      version: z.literal(1),
      machine: z.string().min(1),
      notice: z.string(),
      session: Session.Info,
      project: z.object({ worktree: z.string(), name: z.string().nullable() }),
      messages: z.array(z.object({ info: MessageV2.Info, parts: z.array(MessageV2.Part) })),
    })
    const match = /^(\d+)-([a-f0-9]{64})\.json$/.exec(revision)
    if (!match) return false
    const bytes = await fs.stat(file)
    if (bytes.size > 50_000_000) {
      log.warn("sync archive too large", { file })
      return false
    }
    const raw = await Bun.file(file).text()
    const json = JSON.parse(raw) as unknown
    if (digest(json) !== match[2]) {
      log.warn("sync archive checksum mismatch", { file })
      return false
    }
    const parsed = Bundle.safeParse(json)
    if (!parsed.success) {
      log.warn("invalid sync archive", { file, error: parsed.error.message })
      return false
    }
    const data = parsed.data
    if (data.machine !== machine || data.session.id !== source) return false
    if (data.session.parentID || Teammate.session(undefined, data.session.permission)) return true
    const origin = Database.use((db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, data.session.id)).get(),
    )
    if (origin?.parent_id || Teammate.session(undefined, origin?.permission ?? undefined)) return true
    if (
      data.messages.some(
        (msg) =>
          msg.parts.some((part) => part.messageID !== msg.info.id || part.sessionID !== source) ||
          msg.info.sessionID !== source,
      )
    )
      return false
    const ids = new Set(data.messages.map((msg) => msg.info.id))
    if (
      ids.size !== data.messages.length ||
      data.messages.some((msg) => msg.info.role === "assistant" && !ids.has(msg.info.parentID))
    )
      return false
    const parts = data.messages.flatMap((msg) => msg.parts.map((part) => part.id))
    if (new Set(parts).size !== parts.length) return false
    const busy = prev ? await Active.remote(prev.local_id, { machine: "" }) : false

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
      const local = current && snapshot(current.id)
      const changed = !!prev && ((!!local && digest(local) !== prev.baseline) || Active.local(prev.local_id) || busy)
      const id = current && !changed ? current.id : SessionID.descending()
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
      const dir = translate(data.session.directory)
      const row = Session.toRow({
        ...data.session,
        id,
        directory: dir,
        parentID: undefined,
        workspaceID: undefined,
        share: undefined,
        revert: undefined,
        permission: undefined,
        title: `${data.session.title} (from another host)`,
      })
      if (current && !changed) {
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
          const { id: _, messageID: __, sessionID: ___, ...value } = part
          db.insert(PartTable)
            .values({
              id: PartID.ascending(),
              message_id: mid,
              session_id: id,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: value,
            })
            .run()
        })
      })
      const last = data.messages.at(-1)
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
      const baseline = digest(snapshot(id))
      db.insert(SyncTable)
        .values({ machine, source_id: source, local_id: id, revision, baseline })
        .onConflictDoUpdate({
          target: [SyncTable.machine, SyncTable.source_id],
          set: { local_id: id, revision, baseline },
        })
        .run()
      db.update(SyncStateTable)
        .set({ exported: sql`${SyncStateTable.version}` })
        .where(eq(SyncStateTable.session_id, id))
        .run()
      Database.effect(() => {
        const info = Session.fromRow(row as typeof SessionTable.$inferSelect)
        GlobalBus.emit("event", {
          directory: dir,
          payload: {
            type: current && !changed ? Session.Event.Updated.type : Session.Event.Created.type,
            properties: { info },
          },
        })
      })
    })
    return true
  }

  export async function scan(dir = root) {
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
  }

  export async function drain(dir = root, valid = () => true) {
    const rows = Database.use((db) =>
      db
        .select()
        .from(SyncStateTable)
        .where(sql`${SyncStateTable.version} != ${SyncStateTable.exported}`)
        .all(),
    )
    let count = 0
    for (const row of rows) {
      if (!valid()) break
      await exportSession(SessionID.make(row.session_id), dir)
        .then(() => {
          Database.use((db) =>
            db
              .update(SyncStateTable)
              .set({ exported: row.version })
              .where(and(eq(SyncStateTable.session_id, row.session_id), eq(SyncStateTable.version, row.version)))
              .run(),
          )
          count++
        })
        .catch((err) => log.warn("export failed", { sessionID: row.session_id, error: String(err) }))
      await Bun.sleep(0)
    }
    return count
  }

  let worker: Worker | undefined
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
    const client = Rpc.client<typeof rpc>(worker)
    const off = client.on<Parameters<typeof GlobalBus.emit<"event">>[1]>("event", (event) => {
      GlobalBus.emit("event", event)
    })
    client.on<string>("failure", (error) => log.warn("sync failed", { error }))
    client
      .call("init", { source: Database.Path, owner })
      .catch((err) => log.warn("sync worker failed", { error: String(err) }))
    Database.onclose(() => {
      off()
      worker?.terminate()
      lease.close()
      worker = undefined
    })
  }
}

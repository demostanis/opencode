import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSync } from "../../src/session/sync"
import { Active } from "../../src/session/active"
import { Database, eq, and, sql } from "../../src/storage/db"
import { SessionTable, MessageTable, PartTable, SyncTable, SyncStateTable } from "../../src/session/session.sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Teammate } from "../../src/teammate/teammate"
import type { MessageV2 } from "../../src/session/message-v2"
import { GlobalBus } from "../../src/bus/global"
import { ProjectTable } from "../../src/project/project.sql"

type Content<T> = T extends unknown ? Omit<T, "id" | "sessionID" | "messageID"> : never

type Bundle = {
  version: number
  machine: string
  notice?: string
  project: { id?: string; worktree: string; name: string | null }
  session: Session.Info
  messages: MessageV2.WithParts[]
  children?: {
    session: Session.Info
    messages: MessageV2.WithParts[]
    project?: Bundle["project"]
  }[]
}

type Manifest = {
  version: number
  machine: string
  source: SessionID
  nodes: { sha: string; size: number; chunks: { sha: string; size: number }[] }[]
}

function baseline(id: SessionID, version: number) {
  return Database.use((db) => {
    const row = db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()!
    const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id)).get()!
    const history = (row: typeof SessionTable.$inferSelect) => ({
      session: Session.fromRow(row),
      messages: db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, row.id))
        .orderBy(MessageTable.time_created, MessageTable.id)
        .all()
        .map((msg) => ({
          info: { ...msg.data, id: msg.id, sessionID: row.id },
          parts: db
            .select()
            .from(PartTable)
            .where(eq(PartTable.message_id, msg.id))
            .orderBy(PartTable.id)
            .all()
            .map((part) => ({ ...part.data, id: part.id, messageID: msg.id, sessionID: row.id })),
        })),
    })
    const node = history(row)
    const head = {
      version: version === 1 ? 1 : 2,
      machine: "",
      notice: "Conversation transferred from another host. Files, snapshots and worktree may be missing on this host.",
      session: node.session,
    }
    const metadata = { worktree: project.worktree, name: project.name }
    const data =
      version === 1
        ? { ...head, project: metadata, messages: node.messages }
        : {
            ...head,
            messages: node.messages,
            project: metadata,
            children: db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.parent_id, id))
              .orderBy(SessionTable.id)
              .all()
              .map(history),
          }
    const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex")
    for (const node of [row, ...db.select().from(SessionTable).where(eq(SessionTable.parent_id, id)).all()])
      db.update(SyncTable).set({ baseline: hash }).where(eq(SyncTable.local_id, node.id)).run()
  })
}

test("legacy v1/v2/v3 logical baselines keep owned IDs on upgrade without swallowing local child changes", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      for (const version of [1, 2, 3]) {
        const root = await Session.create({ title: `Legacy v${version}` })
        const child = version === 1 ? undefined : await Session.create({ title: "Legacy child", parentID: root.id })
        await history(root, child)
        if (child) await history(child)
        await SessionSync.exportSession(root.id, base)
        const bundle = await latest(base, root.id)
        bundle.version = version === 1 ? 1 : 2
        if (version === 1) delete bundle.children
        await remote(base, bundle, 1)
        const imported = SessionID.make(mapping(root.id).local_id)
        const descendant = child && SessionID.make(mapping(child.id).local_id)
        baseline(imported, version)
        await SessionSync.exportSession(imported, base)
        expect(
          await fs.stat(path.join(base, "sessions", await Active.machine, imported)).catch(() => undefined),
        ).toBeUndefined()
        bundle.session.title = "Remote upgrade"
        if (version !== 3) await remote(base, bundle, 2)
        if (version === 3) {
          const folder = path.join(base, "sessions", "tree-host", root.id)
          await fs.mkdir(path.join(folder, "nodes"))
          const refs = []
          for (const node of [{ session: bundle.session, messages: bundle.messages }, ...bundle.children!]) {
            const text = JSON.stringify(node)
            const sha = createHash("sha256").update(text).digest("hex")
            await fs.writeFile(path.join(folder, "nodes", `${sha}.json`), text)
            refs.push({ sha, size: Buffer.byteLength(text) })
          }
          const text = JSON.stringify({
            version: 3,
            machine: "tree-host",
            source: root.id,
            notice: bundle.notice,
            project: bundle.project,
            nodes: refs,
          })
          await fs.writeFile(path.join(folder, `2-${createHash("sha256").update(text).digest("hex")}.json`), text)
          await SessionSync.scan(base)
        }
        expect(mapping(root.id).local_id).toBe(imported)
        if (child) expect(mapping(child.id).local_id).toBe(descendant!)
        baseline(imported, version)
        await Session.setTitle({ sessionID: descendant ?? imported, title: "Local changes" })
        await remote(base, bundle, 3)
        expect(mapping(root.id).local_id).not.toBe(imported)
        expect((await Session.get(descendant ?? imported)).title).toBe("Local changes")
        for (const id of [root.id, imported, SessionID.make(mapping(root.id).local_id)]) await Session.remove(id)
      }
    },
  })
})

test("v4 cross-project descendants retain projects, translate per-node paths and never steal foreign children", async () => {
  await using tmp = await tmpdir({ git: true })
  await using elsewhere = await tmpdir({ git: true })
  await using third = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Cross-project root" })
      const child = await Instance.provide({
        directory: elsewhere.path,
        fn: () => Session.create({ title: "Foreign child", parentID: root.id }),
      })
      const grand = await Instance.provide({
        directory: third.path,
        fn: () => Session.create({ title: "Foreign grandchild", parentID: child.id }),
      })
      expect(new Set([root, child, grand].map((node) => node.projectID)).size).toBe(3)
      child.directory = path.join(elsewhere.path, "nested")
      Database.use((db) => {
        db.update(SessionTable).set({ directory: child.directory }).where(eq(SessionTable.id, child.id)).run()
        for (const [index, node] of [root, child, grand].entries())
          db.update(ProjectTable)
            .set({ name: `Project ${index}` })
            .where(eq(ProjectTable.id, node.projectID))
            .run()
      })
      await history(root, child)
      await history(child, grand)
      await history(grand)
      // Exporting a foreign child must find its actual root across project boundaries.
      await SessionSync.exportSession(grand.id, base)
      const first = await manifest(base, root.id)
      expect(first.data.version).toBe(4)
      Database.use((db) => {
        db.update(ProjectTable).set({ worktree: "/receiver/child" }).where(eq(ProjectTable.id, child.projectID)).run()
        // Remove only this test's source grandchild/project to exercise project creation on receipt.
        db.delete(ProjectTable).where(eq(ProjectTable.id, grand.projectID)).run()
      })
      await deliver(base, first.data, 1, first.folder)
      const ids = [root, child, grand].map((node) => SessionID.make(mapping(node.id).local_id))
      const imported = await Promise.all(ids.map((id) => Session.get(id)))
      expect(imported.map((node) => node.projectID)).toEqual([root.projectID, child.projectID, grand.projectID])
      expect(imported.map((node) => node.directory)).toEqual([tmp.path, "/receiver/child/nested", third.path])
      expect(imported[1].parentID).toBe(ids[0])
      expect(imported[2].parentID).toBe(ids[1])
      expect(
        Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, grand.projectID)).get())
          ?.worktree,
      ).toBe(third.path)
      expect(
        Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, grand.projectID)).get())?.name,
      ).toBe("Project 2")
      for (const [index, id] of ids.entries()) {
        const messages = await Session.messages({ sessionID: id })
        const assistant = messages.find((msg) => msg.info.role === "assistant")!.info
        expect(assistant.role === "assistant" && assistant.path.cwd).toBe(imported[index].directory)
        expect(assistant.role === "assistant" && assistant.path.root).toBe(imported[index].directory)
        if (index === 2) continue
        const task = parts(id).find((part) => part.type === "tool")!
        expect(task.type === "tool" && task.state.input.task_id).toBe(ids[index + 1])
      }
      await deliver(base, first.data, 2)
      expect([root, child, grand].map((node) => mapping(node.id).local_id)).toEqual(ids)
      // Reparenting a mapped child into another source tree must still be rejected, even in v4.
      const other = SessionID.descending()
      const histories = await Promise.all(
        first.data.nodes.map(
          async (ref) =>
            JSON.parse(
              (await fs.readFile(path.join(first.folder, "nodes", `${ref.chunks[0].sha}.bin`))).toString(),
            ) as Pick<Bundle, "session" | "messages" | "project">,
        ),
      )
      histories[0].session.id = other
      histories[0].messages = []
      histories[1].session.parentID = other
      const refs = await Promise.all(
        histories.map(async (node) => {
          const text = JSON.stringify(node)
          const sha = createHash("sha256").update(text).digest("hex")
          await fs.writeFile(path.join(first.folder, "nodes", `${sha}.bin`), text)
          return {
            sha,
            size: Buffer.byteLength(text),
            chunks: [{ sha, size: Buffer.byteLength(text) }],
          }
        }),
      )
      await deliver(base, { ...first.data, source: other, nodes: refs }, 3, first.folder)
      expect(mapping(other)).toBeUndefined()
      expect(mapping(child.id).local_id).toBe(ids[1])
      await Session.setTitle({ sessionID: ids[2], title: "Local edit" })
      await deliver(base, first.data, 4)
      expect(mapping(root.id).local_id).not.toBe(ids[0])
      expect((await Session.get(ids[2])).title).toBe("Local edit")
      for (const id of [root.id, ids[0], SessionID.make(mapping(root.id).local_id)]) await Session.remove(id)
    },
  })
})

test("v4 absent receiver projects preserve sibling worktree paths across same-project and foreign descendants", async () => {
  await using tmp = await tmpdir({ git: true })
  await using elsewhere = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Absent project root" })
      const child = await Session.create({ title: "First worktree", parentID: root.id })
      const sibling = await Session.create({ title: "Second worktree", parentID: root.id })
      const foreign = await Instance.provide({
        directory: elsewhere.path,
        fn: () => Session.create({ title: "Foreign worktree", parentID: child.id }),
      })
      const grand = await Instance.provide({
        directory: elsewhere.path,
        fn: () => Session.create({ title: "Foreign sibling worktree", parentID: foreign.id }),
      })
      const nodes = [root, child, sibling, foreign, grand]
      expect(child.projectID).toBe(root.projectID)
      expect(sibling.projectID).toBe(root.projectID)
      expect(foreign.projectID).not.toBe(root.projectID)
      expect(grand.projectID).toBe(foreign.projectID)
      for (const [index, node] of nodes.entries()) {
        if (index) node.directory = `${node.directory}-worktree-${index}`
        Database.use((db) =>
          db.update(SessionTable).set({ directory: node.directory }).where(eq(SessionTable.id, node.id)).run(),
        )
        await history(node)
      }
      await SessionSync.exportSession(root.id, base)
      const source = await manifest(base, root.id)
      expect(source.data.version).toBe(4)
      Database.use((db) => {
        for (const id of [root.projectID, foreign.projectID])
          db.delete(ProjectTable).where(eq(ProjectTable.id, id)).run()
      })
      await deliver(base, source.data, 1, source.folder)
      const ids = nodes.map((node) => SessionID.make(mapping(node.id).local_id))
      for (const revision of [1, 2]) {
        if (revision === 2) await deliver(base, source.data, revision)
        expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
        expect(nodes.every((node) => mapping(node.id).revision.startsWith(`${revision}-`))).toBe(true)
        const imported = await Promise.all(ids.map((id) => Session.get(id)))
        expect(imported.map((node) => node.projectID)).toEqual(nodes.map((node) => node.projectID))
        expect(imported.map((node) => node.directory)).toEqual(nodes.map((node) => node.directory))
        expect(imported.map((node) => node.parentID)).toEqual([undefined, ids[0], ids[0], ids[1], ids[3]])
        for (const [index, id] of ids.entries()) {
          const messages = await Session.messages({ sessionID: id })
          const assistant = messages.find((msg) => msg.info.role === "assistant")!.info
          expect(assistant.role === "assistant" && assistant.path).toEqual({
            cwd: nodes[index].directory,
            root: nodes[index].directory,
          })
        }
        for (const [id, worktree] of [
          [root.projectID, tmp.path],
          [foreign.projectID, elsewhere.path],
        ] as const) {
          const rows = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).all())
          expect(rows).toHaveLength(1)
          expect(rows[0].worktree).toBe(worktree)
        }
      }
      await Session.remove(ids[0])
    },
  })
})

test("v4 shards oversized individual root and child tool afterimages with byte-exact Unicode and atomic retries", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Oversized root" })
      const child = await Session.create({ title: "Oversized child", parentID: root.id })
      const nodes = [root, child]
      const edits = await Promise.all(nodes.map((node) => history(node)))
      for (const edit of edits) {
        if (edit.state.status !== "completed") throw new Error("Expected completed edit")
        await Session.updatePart({
          ...edit,
          state: { ...edit.state, metadata: { files: [{ after: "BOUNDARY" }] } },
        })
      }
      await SessionSync.exportSession(root.id, base)
      const small = await latest(base, root.id)
      await remote(base, small, 1)
      const ids = nodes.map((node) => SessionID.make(mapping(node.id).local_id))
      const previous = mapping(root.id).revision
      const histories = [
        {
          session: small.session,
          messages: small.messages,
          project: { id: small.session.projectID, ...small.project },
        },
        ...small.children!,
      ]
      const values = histories.map((node) => {
        const text = JSON.stringify(node)
        const offset = Buffer.byteLength(text.slice(0, text.indexOf("BOUNDARY")))
        return "x".repeat(50_000_000 - offset - 1) + "\u{1f680}exact\u0000tail"
      })
      for (const [index, edit] of edits.entries()) {
        if (edit.state.status !== "completed") throw new Error("Expected completed edit")
        await Session.updatePart({
          ...edit,
          state: { ...edit.state, metadata: { files: [{ after: values[index] }] } },
        })
      }
      await SessionSync.exportSession(root.id, base)
      const large = await manifest(base, root.id)
      expect(large.data.version).toBe(4)
      expect(large.data.nodes.every((node) => node.size > 50_000_000 && node.chunks.length === 2)).toBe(true)
      for (const node of large.data.nodes) {
        for (const chunk of node.chunks) {
          expect(chunk.size).toBeLessThanOrEqual(50_000_000)
          const bytes = await fs.readFile(path.join(large.folder, "nodes", `${chunk.sha}.bin`))
          expect(bytes.length).toBe(chunk.size)
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(chunk.sha)
        }
        const first = await fs.readFile(path.join(large.folder, "nodes", `${node.chunks[0].sha}.bin`))
        expect(first.at(-1)).toBe(0xf0)
      }
      const folder = await deliver(base, large.data, 2)
      expect(mapping(root.id).revision).toBe(previous)
      await fs.cp(path.join(large.folder, "nodes"), path.join(folder, "nodes"), {
        recursive: true,
      })
      const last = large.data.nodes[1].chunks[1]
      const file = path.join(folder, "nodes", `${last.sha}.bin`)
      await fs.rm(file)
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).toBe(previous)
      const bytes = await fs.readFile(path.join(large.folder, "nodes", `${last.sha}.bin`))
      bytes[0] ^= 1
      await fs.writeFile(file, bytes)
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).toBe(previous)
      expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
      expect(parts(ids[1]).find((part) => part.type === "tool")?.state).toEqual(
        small.children![0].messages.flatMap((msg) => msg.parts).find((part) => part.type === "tool")!.state,
      )
      await fs.copyFile(path.join(large.folder, "nodes", `${last.sha}.bin`), file)
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).not.toBe(previous)
      expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
      for (const [index, id] of ids.entries()) {
        const part = parts(id).find((part) => part.type === "tool")!
        expect(part.type === "tool" && part.state.status === "completed" && part.state.metadata.files).toEqual([
          { after: values[index] },
        ])
      }
      // Whole-node digest and size remain mandatory even when all chunk digests are valid.
      const bad = structuredClone(large.data)
      bad.nodes[1].sha = "0".repeat(64)
      const revision = mapping(root.id).revision
      await deliver(base, bad, 3)
      expect(mapping(root.id).revision).toBe(revision)
      bad.nodes[1].size++
      await deliver(base, bad, 4)
      expect(mapping(root.id).revision).toBe(revision)
      await deliver(base, large.data, 5)
      expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
      await SessionSync.exportSession(ids[0], base)
      expect(
        await fs.stat(path.join(base, "sessions", await Active.machine, ids[0])).catch(() => undefined),
      ).toBeUndefined()
      await Session.remove(root.id)
      await Session.remove(ids[0])
    },
  })
}, 60_000)

async function manifest(base: string, id: SessionID) {
  const folder = path.join(base, "sessions", await Active.machine, id)
  const file = (await fs.readdir(folder))
    .filter((name) => /^\d+-/.test(name))
    .sort()
    .at(-1)!
  return { folder, data: (await Bun.file(path.join(folder, file)).json()) as Manifest }
}

async function deliver(base: string, data: Manifest, revision: number, folder?: string) {
  const dir = path.join(base, "sessions", "tree-host", data.source)
  await fs.mkdir(dir, { recursive: true })
  if (folder) await fs.cp(path.join(folder, "nodes"), path.join(dir, "nodes"), { recursive: true })
  const text = JSON.stringify({ ...data, machine: "tree-host" })
  await fs.writeFile(path.join(dir, `${revision}-${createHash("sha256").update(text).digest("hex")}.json`), text)
  await SessionSync.scan(base)
  return dir
}

async function history(session: Session.Info, child?: Session.Info) {
  const mid = MessageID.ascending()
  await Session.updateMessage({
    id: mid,
    sessionID: session.id,
    role: "user",
    agent: "build",
    time: { created: 1 },
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: mid,
    sessionID: session.id,
    type: "text",
    text: `literal ${child?.id ?? session.id}`,
  })
  const aid = MessageID.ascending()
  await Session.updateMessage({
    id: aid,
    sessionID: session.id,
    role: "assistant",
    parentID: mid,
    agent: "build",
    mode: "build",
    providerID: ProviderID.make("test"),
    modelID: ModelID.make("test"),
    time: { created: 2, completed: 3 },
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const part: MessageV2.ToolPart = {
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: aid,
    type: "tool",
    tool: child ? "task" : "edit",
    callID: "call",
    state: {
      status: "completed",
      title: "Complete",
      time: { start: 2, end: 3 },
      input: child
        ? { task_id: child.id, session_id: child.id, prompt: `keep ${child.id}` }
        : { filePath: "/source/file" },
      output: child
        ? `task_id: ${child.id} (for resuming)\n\n<task_result>original</task_result>`
        : "unchanged output\n\u0000bytes",
      metadata: child
        ? { sessionId: child.id }
        : {
            files: [{ filePath: "/source/file", before: "old", after: `exact\nbytes\u0000${session.id}` }],
          },
    },
  }
  await Session.updatePart(part)
  return part
}

async function latest(base: string, id: SessionID) {
  const dir = path.join(base, "sessions", await Active.machine, id)
  return (await Bun.file(path.join(dir, (await fs.readdir(dir)).sort().at(-1)!)).json()) as Bundle
}

async function remote(base: string, data: Bundle, revision: number, host = "tree-host") {
  const bundle = { ...data, machine: host }
  const text = JSON.stringify(bundle)
  const dir = path.join(base, "sessions", host, data.session.id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${revision}-${createHash("sha256").update(text).digest("hex")}.json`), text)
  await SessionSync.scan(base)
}

function mapping(id: SessionID, host = "tree-host") {
  return Database.use((db) =>
    db
      .select()
      .from(SyncTable)
      .where(and(eq(SyncTable.machine, host), eq(SyncTable.source_id, id)))
      .get(),
  )!
}

function parts(id: string) {
  return Database.use((db) =>
    db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, SessionID.make(id)))
      .all(),
  ).map((part) => part.data as Content<MessageV2.Part>)
}

test("root bundles preserve nested tool histories and remap only task references; updates, forks and deletions are atomic", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Root" })
      const child = await Session.create({ title: "Child", parentID: root.id })
      const grand = await Session.create({ title: "Grandchild", parentID: child.id })
      const team = await Session.create({
        title: "Teammate",
        parentID: root.id,
        permission: [Teammate.ROLE],
      })
      const hidden = await Session.create({ title: "Teammate descendant", parentID: team.id })
      const running = await history(root, child)
      await Session.updatePart({
        ...running,
        id: PartID.ascending(),
        callID: "running",
        state: {
          status: "running",
          input: { session_id: child.id },
          metadata: { sessionId: child.id },
          time: { start: 4 },
        },
      })
      await history(child, grand)
      const edit = await history(grand)
      const image = path.join(tmp.path, "child.png")
      await fs.writeFile(image, "child attachment bytes")
      await Session.updatePart({
        id: PartID.ascending(),
        sessionID: grand.id,
        messageID: edit.messageID,
        type: "file",
        mime: "image/png",
        url: pathToFileURL(image).href,
      })
      await SessionSync.drain(base)
      const bundle = await latest(base, root.id)
      expect(bundle.version).toBe(2)
      expect(bundle.children?.map((node) => node.session.id).sort()).toEqual([child.id, grand.id].sort())
      expect(JSON.stringify(bundle)).not.toContain(hidden.id)
      await remote(base, bundle, 1)
      const ids = [root, child, grand].map((node) => SessionID.make(mapping(node.id).local_id))
      expect((await Session.get(ids[1])).parentID).toBe(ids[0])
      expect((await Session.get(ids[2])).parentID).toBe(ids[1])
      const pending = parts(ids[0]).find((part) => part.type === "tool" && part.state.status === "running")
      expect(pending?.type === "tool" && pending.state.status === "running" && pending.state.metadata?.sessionId).toBe(
        ids[1],
      )
      const task = parts(ids[0]).find((part) => part.type === "tool")!
      expect(task.type === "tool" && task.state.status === "completed" && task.state.metadata.sessionId).toBe(ids[1])
      expect(task.type === "tool" && task.state.input.task_id).toBe(ids[1])
      expect(task.type === "tool" && task.state.input.session_id).toBe(ids[1])
      expect(task.type === "tool" && task.state.status === "completed" && task.state.output).toStartWith(
        `task_id: ${ids[1]} `,
      )
      expect(task.type === "tool" && task.state.input.prompt).toBe(`keep ${child.id}`)
      expect(parts(ids[0]).some((part) => part.type === "text" && part.text === `literal ${child.id}`)).toBe(true)
      expect(parts(ids[2]).find((part) => part.type === "tool")).toEqual(
        (({ id, sessionID, messageID, ...value }) => value)(edit),
      )
      expect(
        parts(ids[2]).some(
          (part) =>
            part.type === "file" &&
            part.url === `data:image/png;base64,${Buffer.from("child attachment bytes").toString("base64")}`,
        ),
      ).toBe(true)
      await SessionSync.scan(base)
      expect(mapping(root.id).local_id).toBe(ids[0])
      await SessionSync.drain(base)
      expect(await fs.readdir(path.join(base, "sessions", await Active.machine))).not.toContain(ids[0])
      await Session.setTitle({ sessionID: grand.id, title: "Child-only update" })
      expect(await SessionSync.drain(base)).toBe(1)
      await remote(base, await latest(base, root.id), 2)
      expect(mapping(grand.id).local_id).toBe(ids[2])
      expect((await Session.get(ids[2])).title).toBe("Child-only update")
      await Session.setTitle({ sessionID: ids[2], title: "Local recovery edits" })
      await Session.setTitle({ sessionID: grand.id, title: "Remote revision" })
      await SessionSync.drain(base)
      await remote(base, await latest(base, root.id), 3)
      const fork = [root, child, grand].map((node) => SessionID.make(mapping(node.id).local_id))
      expect(fork.every((id, index) => id !== ids[index])).toBe(true)
      expect((await Session.get(ids[2])).title).toBe("Local recovery edits")
      expect((await Session.get(ids[2])).parentID).toBe(ids[1])
      expect((await Session.get(fork[2])).parentID).toBe(fork[1])
      await Session.remove(grand.id)
      expect(await SessionSync.drain(base)).toBe(1)
      await remote(base, await latest(base, root.id), 4)
      expect(mapping(root.id).local_id).toBe(fork[0])
      expect(mapping(grand.id)).toBeUndefined()
      expect(await Session.get(fork[2]).catch(() => undefined)).toBeUndefined()
      expect((await Session.get(ids[2])).title).toBe("Local recovery edits")
      await Session.remove(root.id)
      await SessionSync.clean(base)
      expect(
        await fs.stat(path.join(base, "sessions", await Active.machine, root.id)).catch(() => undefined),
      ).toBeUndefined()
      for (const id of [ids[0], fork[0]]) await Session.remove(id)
    },
  })
})

test("upgrade backfills already-exported subagents once and clean retains legacy child recovery archives", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Old exported root" })
      const child = await Session.create({ title: "Previously excluded child", parentID: root.id })
      const edit = await history(child)
      Database.use((db) => {
        db.run(sql`DROP TRIGGER IF EXISTS session_sync_tree_delete`)
        db.run(sql`UPDATE session_sync_state SET exported = version`)
      })
      Database.close()
      expect(await SessionSync.drain(base)).toBeGreaterThan(0)
      expect(
        (await latest(base, root.id)).children?.[0].messages
          .flatMap((msg) => msg.parts)
          .find((part) => part.type === "tool")?.state,
      ).toEqual(edit.state)
      expect(await SessionSync.drain(base)).toBe(0)
      const dir = path.join(base, "sessions", await Active.machine, child.id)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `1-${"a".repeat(64)}.json`), "legacy child history")
      await SessionSync.clean(base)
      expect(await fs.readdir(dir)).toEqual([`1-${"a".repeat(64)}.json`])
      expect((await latest(base, root.id)).children?.[0].session.id).toBe(child.id)
      await remote(base, await latest(base, root.id), 1, "backfill-host")
      expect(parts(mapping(child.id, "backfill-host").local_id).some((part) => part.type === "tool")).toBe(true)
      await Session.remove(root.id)
      await Session.remove(SessionID.make(mapping(root.id, "backfill-host").local_id))
    },
  })
})

test("invalid trees, cross-parent reuse and stale v1 updates cannot partially overwrite descendants", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Validated root" })
      const child = await Session.create({ title: "Validated child", parentID: root.id })
      await history(child)
      await SessionSync.exportSession(root.id, base)
      const bundle = await latest(base, root.id)
      for (const [index, change] of [
        (data: Bundle) => {
          data.children!.push(data.children![0])
        },
        (data: Bundle) => {
          data.children![0].session.parentID = SessionID.descending()
        },
        (data: Bundle) => {
          data.children![0].session.parentID = child.id
        },
        (data: Bundle) => {
          data.children![0].session.projectID = "other" as typeof root.projectID
        },
        (data: Bundle) => {
          data.children![0].messages[0].info.sessionID = root.id
        },
      ].entries()) {
        const data = structuredClone(bundle)
        change(data)
        await remote(base, data, 1, `invalid-${index}`)
        expect(mapping(root.id, `invalid-${index}`)).toBeUndefined()
      }
      await remote(base, bundle, 1)
      const imported = mapping(root.id).local_id
      const descendant = mapping(child.id).local_id
      const other = structuredClone(bundle)
      other.session.id = SessionID.descending()
      other.children![0].session.parentID = other.session.id
      await remote(base, other, 2)
      expect(mapping(other.session.id)).toBeUndefined()
      expect(mapping(child.id).local_id).toBe(descendant)
      const legacy = structuredClone(bundle)
      legacy.version = 1
      delete legacy.children
      await remote(base, legacy, 3)
      expect(mapping(root.id).local_id).not.toBe(imported)
      expect((await Session.get(SessionID.make(descendant))).parentID).toBe(SessionID.make(imported))
      await Session.remove(root.id)
      for (const id of [imported, mapping(root.id).local_id]) await Session.remove(SessionID.make(id))
      await SessionSync.drain(base)
    },
  })
})

test("active children fork whole trees and identical source IDs on different hosts stay isolated", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Active tree" })
      const child = await Session.create({ title: "Active child", parentID: root.id })
      await history(root, child)
      await history(child)
      await SessionSync.drain(base)
      const bundle = await latest(base, root.id)
      await remote(base, bundle, 1)
      await remote(base, bundle, 1, "second-host")
      const first = SessionID.make(mapping(root.id).local_id)
      const second = SessionID.make(mapping(root.id, "second-host").local_id)
      const active = SessionID.make(mapping(child.id).local_id)
      expect(first).not.toBe(second)
      expect((await Session.get(SessionID.make(mapping(child.id, "second-host").local_id))).parentID).toBe(second)
      await Active.set(active, true, path.join(tmp.path, "active"))
      try {
        await remote(base, bundle, 2)
        expect(mapping(root.id).local_id).not.toBe(first)
        expect((await Session.get(active)).parentID).toBe(first)
        expect(mapping(root.id, "second-host").local_id).toBe(second)
      } finally {
        await Active.set(active, false)
      }
      const fork = SessionID.make(mapping(root.id).local_id)
      await Session.remove(fork)
      await remote(base, bundle, 3)
      expect(mapping(root.id).local_id).toBe(fork)
      expect(await Session.get(fork).catch(() => undefined)).toBeUndefined()
      for (const id of [root.id, first, second]) await Session.remove(id)
      await SessionSync.drain(base)
    },
  })
})

test("orphan histories remain pending and oversized child histories export without losing legacy recovery copies", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Missing parent" })
      const child = await Session.create({ title: "Orphan recovery", parentID: root.id })
      await history(child)
      await SessionSync.drain(base)
      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, root.id)).run())
      await Session.setTitle({ sessionID: child.id, title: "Still pending" })
      const folder = path.join(base, "sessions", await Active.machine, child.id)
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(path.join(folder, `1-${"a".repeat(64)}.json`), "recovery history")
      expect(await SessionSync.drain(base)).toBe(0)
      await SessionSync.clean(base)
      expect(await fs.readdir(folder)).toHaveLength(1)
      expect(await fs.readdir(path.join(base, "sessions", await Active.machine, root.id))).toHaveLength(1)
      const state = () =>
        Database.use((db) => db.select().from(SyncStateTable).where(eq(SyncStateTable.session_id, child.id)).get()!)
      expect(state().version).toBeGreaterThan(state().exported)
      await Session.remove(child.id)
      const large = await Session.create({ title: "Oversized tree" })
      const nested = await Session.create({ title: "Large child", parentID: large.id })
      const mid = MessageID.ascending()
      await Session.updateMessage({
        id: mid,
        sessionID: nested.id,
        role: "user",
        agent: "build",
        time: { created: 1 },
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        sessionID: nested.id,
        messageID: mid,
        type: "text",
        text: "x".repeat(50_000_000),
      })
      expect(await SessionSync.drain(base)).toBe(1)
      const pending = Database.use(
        (db) => db.select().from(SyncStateTable).where(eq(SyncStateTable.session_id, nested.id)).get()!,
      )
      expect(pending.version).toBe(pending.exported)
      expect((await manifest(base, large.id)).data.version).toBe(4)
      const legacy = path.join(base, "sessions", await Active.machine, nested.id)
      await fs.mkdir(legacy, { recursive: true })
      for (const time of [1, 2, 3])
        await fs.writeFile(path.join(legacy, `${time}-${"a".repeat(64)}.json`), "only recovery copy")
      await SessionSync.clean(base)
      expect((await fs.readdir(legacy)).sort()).toEqual([2, 3].map((time) => `${time}-${"a".repeat(64)}.json`))
      const good = await Session.create({ title: "Unrelated healthy tree" })
      await history(good)
      expect(await SessionSync.drain(base)).toBe(1)
      await remote(base, await latest(base, good.id), 1)
      expect(mapping(good.id)).toBeDefined()
      await Session.remove(SessionID.make(mapping(good.id).local_id))
      await Session.remove(good.id)
      await Session.remove(large.id)
    },
  })
}, 30_000)

test("version-one root archives still update in place without echoing unchanged imports", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Legacy root" })
      await history(root)
      await SessionSync.drain(base)
      const bundle = await latest(base, root.id)
      bundle.version = 1
      delete bundle.children
      await remote(base, bundle, 1)
      const imported = SessionID.make(mapping(root.id).local_id)
      await SessionSync.exportSession(imported, base)
      expect(await fs.readdir(path.join(base, "sessions", await Active.machine))).toEqual([root.id])
      bundle.session.title = "New legacy revision"
      await remote(base, bundle, 2)
      expect(mapping(root.id).local_id).toBe(imported)
      expect((await Session.get(imported)).title).toBe("New legacy revision (from another host)")
      await Session.remove(root.id)
      await Session.remove(imported)
      await SessionSync.drain(base)
    },
  })
})

test("large trees use bounded nodes and incomplete or corrupt delivery preserves the prior tree", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Sharded root" })
      const children = await Promise.all(
        ["First", "Second"].map((title) => Session.create({ title, parentID: root.id })),
      )
      const nodes = [root, ...children]
      const edits = await Promise.all(nodes.map((node) => history(node)))
      await SessionSync.drain(base)
      await remote(base, await latest(base, root.id), 1)
      const ids = nodes.map((node) => SessionID.make(mapping(node.id).local_id))
      const previous = mapping(root.id).revision
      for (const [index, node] of nodes.entries())
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: node.id,
          messageID: edits[index].messageID,
          type: "text",
          text: "x".repeat(20_000_000),
        })
      await SessionSync.exportSession(root.id, base)
      const own = path.join(base, "sessions", await Active.machine, root.id)
      const files = (await fs.readdir(own)).filter((name) => /^\d+-/.test(name)).sort()
      const manifest = (await Bun.file(path.join(own, files.at(-1)!)).json()) as {
        version: number
        machine: string
        nodes: { sha: string; size: number }[]
      }
      expect(manifest.version).toBe(3)
      expect(manifest.nodes).toHaveLength(3)
      expect(manifest.nodes.every((ref) => ref.size < 50_000_000)).toBe(true)
      expect(manifest.nodes.reduce((sum, ref) => sum + ref.size, 0)).toBeGreaterThan(50_000_000)
      const folder = path.join(base, "sessions", "tree-host", root.id)
      await fs.mkdir(path.join(folder, "nodes"), { recursive: true })
      const text = JSON.stringify({ ...manifest, machine: "tree-host" })
      await fs.writeFile(path.join(folder, `2-${createHash("sha256").update(text).digest("hex")}.json`), text)
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).toBe(previous)
      for (const ref of manifest.nodes.slice(0, -1))
        await fs.copyFile(path.join(own, "nodes", `${ref.sha}.json`), path.join(folder, "nodes", `${ref.sha}.json`))
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).toBe(previous)
      const last = manifest.nodes.at(-1)!
      const bytes = await fs.readFile(path.join(own, "nodes", `${last.sha}.json`))
      bytes[10] ^= 1
      await fs.writeFile(path.join(folder, "nodes", `${last.sha}.json`), bytes)
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).toBe(previous)
      expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
      expect(parts(ids[2]).some((part) => part.type === "text" && part.text.length === 20_000_000)).toBe(false)
      await fs.copyFile(path.join(own, "nodes", `${last.sha}.json`), path.join(folder, "nodes", `${last.sha}.json`))
      await SessionSync.scan(base)
      expect(mapping(root.id).revision).not.toBe(previous)
      expect(nodes.map((node) => mapping(node.id).local_id)).toEqual(ids)
      for (const id of ids)
        expect(parts(id).some((part) => part.type === "text" && part.text.length === 20_000_000)).toBe(true)
      await SessionSync.scan(base)
      await SessionSync.drain(base)
      expect(
        await fs.stat(path.join(base, "sessions", await Active.machine, ids[0])).catch(() => undefined),
      ).toBeUndefined()
      await Session.setTitle({ sessionID: root.id, title: "Third revision" })
      await SessionSync.exportSession(root.id, base)
      await Session.setTitle({ sessionID: children[0].id, title: "Fourth revision" })
      await SessionSync.exportSession(root.id, base)
      const retained = (await fs.readdir(own)).filter((name) => /^\d+-/.test(name)).sort()
      expect(retained).toHaveLength(2)
      for (const file of retained) {
        const data = (await Bun.file(path.join(own, file)).json()) as typeof manifest
        for (const ref of data.nodes)
          expect((await fs.stat(path.join(own, "nodes", `${ref.sha}.json`))).size).toBe(ref.size)
      }
      for (const ref of manifest.nodes)
        expect((await fs.stat(path.join(own, "nodes", `${ref.sha}.json`))).size).toBe(ref.size)
      await SessionSync.exportSession(root.id, base)
      expect((await fs.readdir(own)).filter((name) => /^\d+-/.test(name)).sort()).toEqual(retained)
      await Session.remove(root.id)
      await Session.remove(ids[0])
    },
  })
}, 30_000)

test("locally deleting an imported child forks the next remote tree rather than rejecting it forever", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Deletion conflict" })
      const child = await Session.create({ title: "Remote child", parentID: root.id })
      await history(root, child)
      await history(child)
      await SessionSync.drain(base)
      await remote(base, await latest(base, root.id), 1)
      const original = SessionID.make(mapping(root.id).local_id)
      const deleted = SessionID.make(mapping(child.id).local_id)
      await Session.remove(deleted)
      await Session.setTitle({ sessionID: child.id, title: "New remote child" })
      await SessionSync.exportSession(root.id, base)
      await remote(base, await latest(base, root.id), 2)
      const fork = SessionID.make(mapping(root.id).local_id)
      const replacement = SessionID.make(mapping(child.id).local_id)
      expect(fork).not.toBe(original)
      expect(replacement).not.toBe(deleted)
      expect((await Session.get(replacement)).parentID).toBe(fork)
      expect(await Session.get(deleted).catch(() => undefined)).toBeUndefined()
      expect((await Session.get(original)).id).toBe(original)
      await remote(base, await latest(base, root.id), 3)
      expect(mapping(root.id).local_id).toBe(fork)
      expect(mapping(child.id).local_id).toBe(replacement)
      const missing = SessionID.descending()
      Database.use((db) =>
        db.update(SessionTable).set({ parent_id: missing }).where(eq(SessionTable.id, replacement)).run(),
      )
      await remote(base, await latest(base, root.id), 4)
      const recovered = SessionID.make(mapping(root.id).local_id)
      expect(recovered).not.toBe(fork)
      expect(mapping(child.id).local_id).not.toBe(replacement)
      expect((await Session.get(replacement)).parentID).toBe(missing)
      expect((await Session.get(SessionID.make(mapping(child.id).local_id))).parentID).toBe(recovered)
      for (const id of [root.id, original, fork, recovered, replacement]) await Session.remove(id)
      await SessionSync.drain(base)
    },
  })
})

test("cross-root tasks resolve after out-of-order delivery without stealing children or swallowing local edits", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Owner A" })
      const child = await Session.create({ title: "Owned child", parentID: root.id })
      await using elsewhere = await tmpdir({ git: true })
      const other = await Instance.provide({
        directory: elsewhere.path,
        fn: () => Session.create({ title: "Resumer B" }),
      })
      expect(other.projectID).not.toBe(root.projectID)
      await history(root, child)
      await history(child)
      await history(other, child)
      await SessionSync.drain(base)
      await remote(base, await latest(base, other.id), 1)
      const imported = SessionID.make(mapping(other.id).local_id)
      const initial = parts(imported).find((part) => part.type === "tool")!
      expect(initial.type === "tool" && initial.state.input.task_id).toBeUndefined()
      expect(initial.type === "tool" && initial.state.status === "completed" && initial.state.output).toStartWith(
        "task_id: unavailable ",
      )
      Database.close()
      await remote(base, await latest(base, root.id), 1)
      const target = SessionID.make(mapping(child.id).local_id)
      const task = parts(imported).find((part) => part.type === "tool")!
      expect(target).not.toBe(child.id)
      expect(task.type === "tool" && task.state.input.task_id).toBe(target)
      expect(task.type === "tool" && task.state.input.session_id).toBe(target)
      expect(task.type === "tool" && task.state.status === "completed" && task.state.metadata.sessionId).toBe(target)
      expect(task.type === "tool" && task.state.status === "completed" && task.state.output).toStartWith(
        `task_id: ${target} `,
      )
      expect((await Session.get(target)).parentID).toBe(SessionID.make(mapping(root.id).local_id))
      expect(task.type === "tool" && task.state.input.prompt).toBe(`keep ${child.id}`)
      await SessionSync.scan(base)
      expect(await SessionSync.drain(base)).toBe(0)
      expect(mapping(other.id).local_id).toBe(imported)
      await remote(base, await latest(base, other.id), 1, "second-host")
      const second = SessionID.make(mapping(other.id, "second-host").local_id)
      const unresolved = parts(second).find((part) => part.type === "tool")!
      expect(unresolved.type === "tool" && unresolved.state.input.task_id).toBeUndefined()
      await remote(base, await latest(base, root.id), 1, "second-host")
      const owner = SessionID.make(mapping(root.id, "second-host").local_id)
      const distinct = SessionID.make(mapping(child.id, "second-host").local_id)
      const resolved = parts(second).find((part) => part.type === "tool")!
      expect(distinct).not.toBe(target)
      expect(resolved.type === "tool" && resolved.state.input.task_id).toBe(distinct)
      expect((await Session.get(distinct)).parentID).toBe(owner)
      expect(await SessionSync.drain(base)).toBe(0)
      const dirty = SessionID.make(mapping(root.id).local_id)
      await Session.setTitle({ sessionID: target, title: "Local changes force A fork" })
      await Session.setTitle({ sessionID: imported, title: "Keep local B title" })
      await Session.setTitle({ sessionID: child.id, title: "Remote A child update" })
      await SessionSync.exportSession(root.id, base)
      await remote(base, await latest(base, root.id), 2)
      const next = mapping(child.id).local_id
      expect(next).not.toBe(target)
      const linked = parts(imported).find((part) => part.type === "tool")!
      expect(linked.type === "tool" && linked.state.input.task_id).toBe(next)
      expect((await Session.get(imported)).title).toBe("Keep local B title")
      await remote(base, await latest(base, other.id), 2)
      expect(mapping(other.id).local_id).not.toBe(imported)
      expect((await Session.get(imported)).title).toBe("Keep local B title")
      const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.session_id, second)).all()).find(
        (part) => part.data.type === "tool",
      )!
      const manual = {
        ...row.data,
        id: row.id,
        messageID: row.message_id,
        sessionID: second,
      } as MessageV2.Part
      if (manual.type !== "tool") throw new Error("Expected task tool")
      await Session.updatePart({
        ...manual,
        state: { ...manual.state, input: { ...manual.state.input, task_id: other.id } },
      })
      await Session.setTitle({ sessionID: distinct, title: "Fork second host owner" })
      await remote(base, await latest(base, root.id), 2, "second-host")
      expect(mapping(child.id, "second-host").local_id).not.toBe(distinct)
      const preserved = parts(second).find((part) => part.type === "tool")!
      expect(preserved.type === "tool" && preserved.state.input.task_id).toBe(other.id)
      await remote(base, await latest(base, other.id), 2, "second-host")
      expect(mapping(other.id, "second-host").local_id).not.toBe(second)
      for (const id of [
        root.id,
        other.id,
        dirty,
        imported,
        second,
        owner,
        SessionID.make(mapping(root.id, "second-host").local_id),
        SessionID.make(mapping(other.id, "second-host").local_id),
        SessionID.make(mapping(root.id).local_id),
        SessionID.make(mapping(other.id).local_id),
      ])
        await Session.remove(id)
      await SessionSync.drain(base)
    },
  })
})

test("deep trees export and validate iteratively without recursion or quadratic parent walks", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Deep root" })
      const nodes = [root]
      Database.transaction((db) => {
        for (let index = 0; index < 1200; index++) {
          const session = {
            ...root,
            id: SessionID.descending(),
            parentID: nodes.at(-1)!.id,
            title: `Depth ${index}`,
          }
          db.insert(SessionTable).values(Session.toRow(session)).run()
          nodes.push(session)
        }
      })
      await history(nodes.at(-1)!)
      expect(await SessionSync.drain(base)).toBe(1)
      const bundle = await latest(base, root.id)
      expect(bundle.children).toHaveLength(1200)
      await remote(base, bundle, 1)
      const imported = nodes.map((node) => SessionID.make(mapping(node.id).local_id))
      expect((await Session.get(imported.at(-1)!)).parentID).toBe(imported.at(-2)!)
      expect(parts(imported.at(-1)!).some((part) => part.type === "tool")).toBe(true)
      expect(await SessionSync.drain(base)).toBe(0)
      const invalid = structuredClone(bundle)
      invalid.children![600].session.parentID = invalid.children!.at(-1)!.session.id
      await remote(base, invalid, 1, "deep-invalid")
      expect(mapping(root.id, "deep-invalid")).toBeUndefined()
      Database.transaction((db) => {
        for (const id of [...nodes.map((node) => node.id), ...imported])
          db.delete(SessionTable).where(eq(SessionTable.id, id)).run()
      })
    },
  })
}, 30_000)

test("edited forwarded trees publish untouched dependencies for a third host, including reference cycles", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const origin = path.join(tmp.path, "a")
      const relay = path.join(tmp.path, "b")
      const destination = path.join(tmp.path, "c")
      const root = await Session.create({ title: "A owns X" })
      const child = await Session.create({ title: "C belongs to X", parentID: root.id })
      const other = await Session.create({ title: "Y resumes C" })
      await history(root, child)
      const edit = await history(child)
      await history(other, child)
      await Session.updatePart({
        ...edit,
        id: PartID.ascending(),
        callID: "cycle",
        tool: "task",
        state: {
          status: "completed",
          title: "Resume Y",
          time: { start: 4, end: 5 },
          input: { task_id: other.id },
          metadata: { sessionId: other.id },
          output: `task_id: ${other.id} (for resuming)\ncycle result`,
        },
      })
      await SessionSync.exportSession(root.id, origin)
      await SessionSync.exportSession(other.id, origin)
      await remote(relay, await latest(origin, root.id), 1, "a-on-b")
      await remote(relay, await latest(origin, other.id), 1, "a-on-b")
      const bx = SessionID.make(mapping(root.id, "a-on-b").local_id)
      const bc = SessionID.make(mapping(child.id, "a-on-b").local_id)
      const by = SessionID.make(mapping(other.id, "a-on-b").local_id)
      const untouched = await Session.get(bx)
      const state = Database.use((db) =>
        db.select().from(SyncStateTable).where(eq(SyncStateTable.session_id, bx)).get(),
      )
      await SessionSync.exportSession(bx, relay)
      expect(
        await fs.stat(path.join(relay, "sessions", await Active.machine, bx)).catch(() => undefined),
      ).toBeUndefined()
      await Session.setTitle({ sessionID: by, title: "B edits only Y" })
      await SessionSync.exportSession(by, relay)
      const forwarded = await latest(relay, by)
      const dependency = await latest(relay, bx)
      expect(forwarded.version).toBe(2)
      expect(dependency.version).toBe(2)
      expect(dependency.children?.map((node) => node.session.id)).toEqual([bc])
      expect(await Session.get(bx)).toEqual(untouched)
      expect(
        Database.use((db) => db.select().from(SyncStateTable).where(eq(SyncStateTable.session_id, bx)).get()),
      ).toEqual(state)
      const task = forwarded.messages.flatMap((msg) => msg.parts).find((part) => part.type === "tool")!
      expect(task.type === "tool" && task.state.input.task_id).toBe(bc)
      // An independently imported A copy must not satisfy B-scoped references on C.
      await remote(destination, await latest(origin, root.id), 1, "a-on-c")
      const alternate = SessionID.make(mapping(child.id, "a-on-c").local_id)
      await remote(destination, forwarded, 1, "relay-b")
      const cy = SessionID.make(mapping(by, "relay-b").local_id)
      const pending = parts(cy).find((part) => part.type === "tool")!
      expect(pending.type === "tool" && pending.state.input.task_id).toBeUndefined()
      await remote(destination, dependency, 1, "relay-b")
      const cx = SessionID.make(mapping(bx, "relay-b").local_id)
      const cc = SessionID.make(mapping(bc, "relay-b").local_id)
      expect(cc).not.toBe(bc)
      expect(cc).not.toBe(alternate)
      expect((await Session.get(cc)).parentID).toBe(cx)
      const resumed = parts(cy).find((part) => part.type === "tool")!
      expect(resumed.type === "tool" && resumed.state.input.task_id).toBe(cc)
      expect(resumed.type === "tool" && resumed.state.input.session_id).toBe(cc)
      expect(resumed.type === "tool" && resumed.state.status === "completed" && resumed.state.metadata.sessionId).toBe(
        cc,
      )
      expect(resumed.type === "tool" && resumed.state.status === "completed" && resumed.state.output).toStartWith(
        `task_id: ${cc} `,
      )
      expect(resumed.type === "tool" && resumed.state.input.prompt).toBe(`keep ${child.id}`)
      const recovered = parts(cc).find((part) => part.type === "tool" && part.tool === "edit")!
      expect(recovered).toEqual((({ id, sessionID, messageID, ...value }) => value)(edit))
      const cycle = parts(cc).find((part) => part.type === "tool" && part.tool === "task")!
      expect(cycle.type === "tool" && cycle.state.input.task_id).toBe(cy)
      const machine = await Active.machine
      const folders = [bx, by].map((id) => path.join(relay, "sessions", machine, id))
      const before = await Promise.all(folders.map(async (folder) => (await fs.readdir(folder)).sort()))
      await SessionSync.exportSession(by, relay)
      expect(await Promise.all(folders.map(async (folder) => (await fs.readdir(folder)).sort()))).toEqual(before)
      await SessionSync.scan(destination)
      expect(mapping(by, "relay-b").local_id).toBe(cy)
      await SessionSync.exportSession(cy, destination)
      expect(
        await fs.stat(path.join(destination, "sessions", await Active.machine)).catch(() => undefined),
      ).toBeUndefined()
      for (const id of [root.id, other.id, bx, by, cx, cy, SessionID.make(mapping(root.id, "a-on-c").local_id)])
        await Session.remove(id)
    },
  })
})

test("imported descendant deletions emit post-commit events for exactly the removed child and grandchild", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = path.join(tmp.path, "sync")
      const root = await Session.create({ title: "Deletion events root" })
      const child = await Session.create({ title: "Removed child", parentID: root.id })
      const grand = await Session.create({ title: "Removed grandchild", parentID: child.id })
      const sibling = await Session.create({
        title: "Unrelated surviving sibling",
        parentID: root.id,
      })
      await history(root, child)
      await history(child, grand)
      await history(grand)
      await history(sibling)
      await SessionSync.exportSession(root.id, base)
      await remote(base, await latest(base, root.id), 1)
      const imported = SessionID.make(mapping(root.id).local_id)
      const survivor = SessionID.make(mapping(sibling.id).local_id)
      const previous = await Promise.all(
        [child, grand].map((node) => Session.get(SessionID.make(mapping(node.id).local_id))),
      )
      await Session.remove(child.id)
      await SessionSync.exportSession(root.id, base)
      const removed: { directory?: string; info: Session.Info; missing: boolean }[] = []
      const listener = (event: {
        directory?: string
        payload: { type: string; properties: { info?: Session.Info } }
      }) => {
        const info = event.payload.properties.info
        if (event.payload.type !== Session.Event.Deleted.type || !info) return
        removed.push({
          directory: event.directory,
          info,
          missing: previous.every(
            (node) =>
              !Database.use((db) =>
                db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, node.id)).get(),
              ),
          ),
        })
      }
      GlobalBus.on("event", listener)
      try {
        await remote(base, await latest(base, root.id), 2)
        expect(removed.map((event) => event.info.id).sort()).toEqual(previous.map((info) => info.id).sort())
        for (const info of previous)
          expect(removed.find((event) => event.info.id === info.id)).toEqual({
            directory: info.directory,
            info,
            missing: true,
          })
        await SessionSync.scan(base)
        expect(removed).toHaveLength(2)
        expect(mapping(root.id).local_id).toBe(imported)
        expect((await Session.get(survivor)).parentID).toBe(imported)
        expect((await Session.get(imported)).id).toBe(imported)
      } finally {
        GlobalBus.off("event", listener)
      }
      await Session.remove(root.id)
      await Session.remove(imported)
    },
  })
})

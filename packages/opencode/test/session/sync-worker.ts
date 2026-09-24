import { Database, eq, and } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSync } from "../../src/session/sync"
import { Active } from "../../src/session/active"
import { SessionTable, MessageTable, PartTable, SyncTable } from "../../src/session/session.sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"

Log.init({ print: false })
Database.Client()

type Request = { id: number; action: string; directory?: string; session?: string; text?: string; machine?: string }

async function handle(input: Request) {
  if (input.action === "identity") return { machine: await Active.machine, path: Database.Path }
  if (input.action === "project")
    return Instance.provide({ directory: input.directory!, fn: () => Instance.project.id })
  if (input.action === "seed")
    return Instance.provide({
      directory: input.directory!,
      fn: async () => {
        const session = await Session.create({ title: "Two host conversation" })
        const mid = MessageID.ascending()
        await Session.updateMessage({
          id: mid,
          sessionID: session.id,
          role: "user",
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: mid,
          type: "text",
          text: "origin history",
        })
        const aid = MessageID.ascending()
        await Session.updateMessage({
          id: aid,
          sessionID: session.id,
          role: "assistant",
          parentID: mid,
          agent: "build",
          mode: "build",
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: aid,
          type: "text",
          text: "origin answer",
        })
        await SessionSync.exportSession(session.id)
        return { id: session.id, project: session.projectID, machine: await Active.machine, path: Database.Path }
      },
    })
  if (input.action === "scan") {
    await SessionSync.scan()
    return true
  }
  if (input.action === "edit") {
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ title: input.text! })
        .where(eq(SessionTable.id, SessionID.make(input.session!)))
        .run(),
    )
    return true
  }
  if (input.action === "export") {
    await SessionSync.exportSession(SessionID.make(input.session!))
    return true
  }
  if (input.action === "inspect") {
    const sync = input.machine
      ? Database.use((db) =>
          db
            .select()
            .from(SyncTable)
            .where(and(eq(SyncTable.machine, input.machine!), eq(SyncTable.source_id, input.session!)))
            .get(),
        )
      : undefined
    const id = sync?.local_id ?? input.session!
    return Database.use((db) => {
      const row = db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(id)))
        .get()
      if (!row) return { sync, row: null }
      const messages = db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, row.id))
        .orderBy(MessageTable.time_created, MessageTable.id)
        .all()
      const parts = db.select().from(PartTable).where(eq(PartTable.session_id, row.id)).all()
      return {
        sync,
        row: { id: row.id, title: row.title, directory: row.directory, project: row.project_id },
        messages: messages.map((msg) => ({
          id: msg.id,
          role: msg.data.role,
          parent:
            msg.data.role === "assistant"
              ? MessageV2.Assistant.parse({ ...msg.data, id: msg.id, sessionID: id }).parentID
              : undefined,
        })),
        parts: parts.map((part) => ({ message: part.message_id, data: part.data })),
        path: Database.Path,
      }
    })
  }
  throw new Error(`Unknown action: ${input.action}`)
}

process.on("message", (input: Request) => {
  handle(input).then(
    (data) => process.send?.({ id: input.id, data }),
    (err) => process.send?.({ id: input.id, error: String(err) }),
  )
})

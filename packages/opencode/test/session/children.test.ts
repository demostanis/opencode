import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function tree(dirs: [string, string, string]) {
  const root = await Instance.provide({ directory: dirs[0], fn: () => Session.create({}) })
  const child = await Instance.provide({
    directory: dirs[1],
    fn: () => Session.create({ parentID: root.id }),
  })
  const grand = await Instance.provide({
    directory: dirs[2],
    fn: () => Session.create({ parentID: child.id }),
  })
  const sibling = await Instance.provide({
    directory: dirs[0],
    fn: () => Session.create({ parentID: root.id }),
  })
  const unrelated = await Instance.provide({ directory: dirs[1], fn: () => Session.create({}) })
  return { root, child, grand, sibling, unrelated }
}

describe("cross-project session children", () => {
  test("discovers the full tree from the root context without changing project ownership", async () => {
    await using root = await tmpdir({ git: true })
    await using child = await tmpdir({ git: true })
    await using grand = await tmpdir({ git: true })
    const sessions = await tree([root.path, child.path, grand.path])

    await Instance.provide({
      directory: root.path,
      fn: async () => {
        try {
          expect(new Set([sessions.root.projectID, sessions.child.projectID, sessions.grand.projectID]).size).toBe(3)
          expect(Instance.project.id).toBe(sessions.root.projectID)
          expect(await Session.children(sessions.root.id)).toEqual(
            expect.arrayContaining([sessions.child, sessions.sibling]),
          )
          expect(await Session.children(sessions.root.id)).toHaveLength(2)
          expect(await Session.children(sessions.child.id)).toEqual([sessions.grand])
          expect(await Session.children(sessions.grand.id)).toEqual([])
          expect(await Session.children(sessions.unrelated.id)).toEqual([])
          for (const session of Object.values(sessions)) {
            expect(await Session.get(session.id)).toEqual(session)
          }
          expect([...Session.list()].map((session) => session.id)).toEqual(
            expect.arrayContaining([sessions.root.id, sessions.sibling.id]),
          )
          expect([...Session.list()].map((session) => session.id)).not.toContain(sessions.child.id)
          expect([...Session.list()].map((session) => session.id)).not.toContain(sessions.grand.id)
        } finally {
          for (const session of Object.values(sessions)) await Session.remove(session.id)
        }
      },
    })
  })

  test("removes cross-project descendants and their messages without deleting unrelated sessions", async () => {
    await using root = await tmpdir({ git: true })
    await using child = await tmpdir({ git: true })
    await using grand = await tmpdir({ git: true })
    const sessions = await tree([root.path, child.path, grand.path])

    await Instance.provide({
      directory: root.path,
      fn: async () => {
        try {
          for (const session of Object.values(sessions)) {
            const id = MessageID.ascending()
            await Session.updateMessage({
              id,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            })
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: id,
              sessionID: session.id,
              type: "text",
              text: session.title,
            })
          }

          await Session.remove(sessions.root.id)

          for (const session of [sessions.root, sessions.child, sessions.grand, sessions.sibling]) {
            expect(
              Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()),
            ).toBeUndefined()
            expect(
              Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all()),
            ).toEqual([])
            expect(
              Database.use((db) => db.select().from(PartTable).where(eq(PartTable.session_id, session.id)).all()),
            ).toEqual([])
          }
          expect(await Session.get(sessions.unrelated.id)).toEqual(sessions.unrelated)
          expect(await Session.messages({ sessionID: sessions.unrelated.id })).toHaveLength(1)
          expect((await Session.messages({ sessionID: sessions.unrelated.id }))[0].parts).toHaveLength(1)
        } finally {
          for (const session of Object.values(sessions)) await Session.remove(session.id)
        }
      },
    })
  })
})

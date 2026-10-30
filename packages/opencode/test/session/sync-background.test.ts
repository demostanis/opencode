import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Active } from "../../src/session/active"
import { Rpc } from "../../src/util/rpc"
import { Database } from "../../src/storage/db"
import type { rpc } from "../../src/session/sync-worker"
import { SyncLease } from "../../src/session/sync-lease"

test("independent workers elect one owner and batch changed conversations", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Database.close()
      const session = await Session.create({ title: "Background export" })
      const dir = path.join(tmp.path, "sync")
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      const workers = [
        new Worker(new URL("../../src/session/sync-worker.ts", import.meta.url).href, { env }),
        new Worker(new URL("../../src/session/sync-worker.ts", import.meta.url).href, { env }),
      ]
      const clients = workers.map((worker) => Rpc.client<typeof rpc>(worker))
      try {
        await Promise.all(clients.map((client) => client.call("init", { dir, source: Database.Path })))
        const folder = path.join(dir, "sessions", await Active.machine, session.id)
        for (let i = 0; i < 100; i++) {
          const states = await Promise.all(clients.map((client) => client.call("status", undefined)))
          if (
            states.some((state) => state.exported > 0 && !state.running) &&
            states.every((state) => state.next !== null && state.next > state.timestamp)
          )
            break
          await Bun.sleep(100)
        }
        const states = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(states.filter((state) => state.owner)).toHaveLength(1)
        for (const state of states) {
          expect(state.next).not.toBeNull()
          expect(state.next!).toBeGreaterThan(state.timestamp)
          expect(state.next! - state.timestamp).toBeLessThanOrEqual(30_000)
        }
        expect(states.reduce((sum, state) => sum + state.exported, 0)).toBe(1)
        const files = await fs.readdir(folder)
        await Bun.sleep(5500)
        const idle = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(idle.reduce((sum, state) => sum + state.exported, 0)).toBe(1)
        expect(idle.map((state) => state.next)).toEqual(states.map((state) => state.next))
        expect(await fs.readdir(folder)).toEqual(files)
        await Session.setTitle({ sessionID: session.id, title: "Updated from the request thread" })
        await Bun.sleep(5500)
        const pending = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(pending.reduce((sum, state) => sum + state.exported, 0)).toBe(1)
        expect(await fs.readdir(folder)).toEqual(files)
        await Session.setTitle({ sessionID: session.id, title: "Latest batched update" })
        for (let i = 0; i < 350; i++) {
          const states = await Promise.all(clients.map((client) => client.call("status", undefined)))
          if (states.reduce((sum, state) => sum + state.exported, 0) === 2) break
          await Bun.sleep(100)
        }
        const archives = (await fs.readdir(folder)).sort()
        expect(archives).toHaveLength(2)
        const bundle = await Bun.file(path.join(folder, archives.at(-1)!)).json()
        expect(bundle.session.title).toBe("Latest batched update")
        const updated = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(updated.some((state, i) => state.next! > states[i].next!)).toBe(true)
        const lease = new SyncLease(`${Database.Path}.sync-v1`)
        try {
          expect(lease.claim(Date.now() + 31_000)).toBe(true)
          const lost = await Promise.all(clients.map((client) => client.call("status", undefined)))
          expect(lost.every((state) => !state.owner)).toBe(true)
        } finally {
          lease.close()
        }
      } finally {
        await Promise.all(clients.map((client) => client.call("stop", undefined)))
        workers.forEach((worker) => worker.terminate())
        await Session.remove(session.id)
      }
    },
  })
}, 60_000)

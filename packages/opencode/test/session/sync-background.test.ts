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

test("independent workers elect one owner and idle without rebuilding unchanged conversations", async () => {
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
          if (states.some((state) => state.exported > 0 && !state.running)) break
          await Bun.sleep(100)
        }
        const states = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(states.filter((state) => state.owner)).toHaveLength(1)
        expect(states.reduce((sum, state) => sum + state.exported, 0)).toBe(1)
        const files = await fs.readdir(folder)
        await Bun.sleep(5500)
        const idle = await Promise.all(clients.map((client) => client.call("status", undefined)))
        expect(idle.reduce((sum, state) => sum + state.exported, 0)).toBe(1)
        expect(await fs.readdir(folder)).toEqual(files)
        await Session.setTitle({ sessionID: session.id, title: "Updated from the request thread" })
        for (let i = 0; i < 100; i++) {
          const states = await Promise.all(clients.map((client) => client.call("status", undefined)))
          if (states.reduce((sum, state) => sum + state.exported, 0) === 2) break
          await Bun.sleep(100)
        }
        expect((await fs.readdir(folder)).length).toBe(2)
      } finally {
        await Promise.all(clients.map((client) => client.call("stop", undefined)))
        workers.forEach((worker) => worker.terminate())
        await Session.remove(session.id)
      }
    },
  })
}, 30_000)

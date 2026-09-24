import { Global } from "@/global"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"

export namespace Active {
  const ttl = 60_000
  const interval = 10_000
  const Marker = z.object({ machine: z.string(), time: z.number() })
  const token = randomUUID()
  const root = path.join(Global.Path.home, ".local/share/opencode-sync", "active-session")
  const pending = new Map<string, { timer: Timer; queue: Promise<void>; dir: string }>()
  const jobs = new Map<string, Promise<void>>()
  export const machine = (async () => {
    const file = path.join(Global.Path.state, "machine-id")
    await fs.mkdir(Global.Path.state, { recursive: true })
    const id = randomUUID()
    await fs.writeFile(file, id, { flag: "wx", mode: 0o600 }).catch((err) => {
      if (err.code !== "EEXIST") throw err
    })
    const value = (await fs.readFile(file, "utf8")).trim()
    if (!z.uuid().safeParse(value).success) throw new Error("Invalid local machine identity")
    return value
  })()

  function location(sessionID: string, id: string, dir = root) {
    return path.join(dir, `${encodeURIComponent(sessionID)}.${id}.json`)
  }

  async function write(sessionID: string, dir = root) {
    await fs.mkdir(dir, { recursive: true })
    const file = location(sessionID, token, dir)
    const temp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify({ machine: await machine, time: Date.now() }))
    await fs.rename(temp, file).catch(async (err) => {
      await fs.rm(temp, { force: true })
      throw err
    })
  }

  export function set(sessionID: string, busy: boolean, dir = root) {
    const current = pending.get(sessionID)
    if (busy && current) return
    if (!busy && !current) return
    if (!busy) {
      clearInterval(current!.timer)
      pending.delete(sessionID)
      const job = current!.queue
        .catch(() => {})
        .then(() => fs.rm(location(sessionID, token, current!.dir), { force: true }))
      jobs.set(sessionID, job)
      job.then(
        () => {
          if (jobs.get(sessionID) === job) jobs.delete(sessionID)
        },
        () => {
          if (jobs.get(sessionID) === job) jobs.delete(sessionID)
        },
      )
      return job
    }
    const state = {
      timer: undefined as unknown as Timer,
      queue: (jobs.get(sessionID) ?? Promise.resolve()).catch(() => {}),
      dir,
    }
    const tick = () => {
      state.queue = state.queue.catch(() => {}).then(() => write(sessionID, dir))
      const job = state.queue
      jobs.set(sessionID, job)
      job.then(
        () => {
          if (jobs.get(sessionID) === job) jobs.delete(sessionID)
        },
        () => {
          if (jobs.get(sessionID) === job) jobs.delete(sessionID)
        },
      )
      job.catch(() => {})
      return job
    }
    pending.set(sessionID, state)
    state.timer = setInterval(tick, interval)
    state.timer.unref?.()
    return tick()
  }

  export function local(sessionID: string) {
    return pending.has(sessionID)
  }

  export async function remote(sessionID: string, opts: { dir?: string; machine?: string; now?: number } = {}) {
    const dir = opts.dir ?? root
    const id = opts.machine ?? (await machine)
    const files = await fs.readdir(dir).catch((err) => {
      if (err.code === "ENOENT") return [] as string[]
      throw err
    })
    for (const name of files.filter(
      (name) => name.startsWith(`${encodeURIComponent(sessionID)}.`) && name.endsWith(".json"),
    )) {
      const file = path.join(dir, name)
      const text = await fs.readFile(file, "utf8").catch((err) => {
        if (err.code === "ENOENT") return undefined
        throw err
      })
      if (!text) continue
      const marker = Marker.safeParse(JSON.parse(text))
      if (!marker.success) continue
      const age = (opts.now ?? Date.now()) - marker.data.time
      if (age > ttl || age < -ttl) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      if (marker.data.machine !== id) return true
    }
    return false
  }
}

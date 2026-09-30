import { SessionSync } from "./sync"
import { SyncLease } from "./sync-lease"
import { Database } from "@/storage/db"
import { GlobalBus } from "@/bus/global"
import { Rpc } from "@/util/rpc"
import { Log } from "@/util/log"
import { Installation } from "@/installation"

await Log.init({ print: process.argv.includes("--print-logs"), dev: Installation.isLocal() })

let lease: SyncLease
let timer: Timer
let heartbeat: Timer
let job: Promise<void> | undefined
let cleaned = 0
let scanned = 0
let owner = false
let exported = 0
let dir: string | undefined
const log = Log.create({ service: "session-sync" })

function tick() {
  if (job) return job
  job = (async () => {
    owner = lease.claim()
    if (!owner) return
    if (Date.now() - cleaned > 3_600_000) {
      await SessionSync.clean(dir)
      cleaned = Date.now()
    }
    if (!lease.claim()) return
    if (Date.now() - scanned > 15_000) {
      await SessionSync.scan(dir)
      scanned = Date.now()
    }
    if (!lease.claim()) return
    const start = performance.now()
    const count = await SessionSync.drain(dir, () => lease.held())
    exported += count
    if (count) log.info("exported changes", { count, duration: Math.round(performance.now() - start) })
  })().finally(() => {
    job = undefined
  })
  return job
}

GlobalBus.on("event", (event) => Rpc.emit("event", event))

export const rpc = {
  init(input: { source: string; dir?: string; owner?: string }) {
    if (input.source !== Database.Path) throw new Error("Sync worker database does not match its parent")
    Database.Client()
    dir = input.dir
    lease = new SyncLease(`${Database.Path}.sync-v1`, input.owner)
    heartbeat = setInterval(() => {
      if (owner) owner = lease.claim()
    }, 10_000)
    timer = setInterval(() => tick().catch((err) => Rpc.emit("failure", String(err))), 5000)
    setTimeout(() => tick().catch((err) => Rpc.emit("failure", String(err))), 0)
  },
  status() {
    return { owner, exported, running: Boolean(job) }
  },
  async stop() {
    clearInterval(timer)
    clearInterval(heartbeat)
    await job?.catch(() => {})
    lease?.close()
    Database.close()
  },
}

Rpc.listen(rpc)

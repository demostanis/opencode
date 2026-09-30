import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { SyncLease } from "../../src/session/sync-lease"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"

test("only one sync owner can claim a database and renew its lease", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "lease.db")
  const a = new SyncLease(file)
  const b = new SyncLease(file)
  try {
    expect(a.claim(1000)).toBe(true)
    expect(b.claim(1000)).toBe(false)
    expect(a.claim(20_000)).toBe(true)
    expect(b.claim(35_000)).toBe(false)
    a.release()
    expect(b.claim(35_000)).toBe(true)
    a.release()
    expect(a.claim(35_000)).toBe(false)
    expect(a.claim(70_000)).toBe(true)
    expect(b.claim(70_000)).toBe(false)
  } finally {
    a.close()
    b.close()
  }
})

test("a dead owner is reclaimed without waiting for its lease expiry", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "lease.db")
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore" })
  await child.exited
  const lease = new SyncLease(file)
  using db = new SQLite(file)
  db.query("INSERT INTO lease VALUES (1, 'dead', ?, ?)").run(child.pid, Date.now() + 30_000)
  try {
    expect(lease.claim()).toBe(true)
  } finally {
    lease.close()
  }
})

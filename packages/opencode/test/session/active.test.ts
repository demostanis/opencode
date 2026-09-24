import { describe, expect, test } from "bun:test"
import { Active } from "../../src/session/active"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

describe("synced activity", () => {
  test("busy writes a marker and idle removes it, even across rapid transitions", async () => {
    await using tmp = await tmpdir()
    await Active.set("session", true, tmp.path)
    const files = await fs.readdir(tmp.path)
    expect(files.filter((file) => file.startsWith("session.") && file.endsWith(".json"))).toHaveLength(1)
    expect(await Active.remote("session", { dir: tmp.path, machine: "another-machine" })).toBe(true)
    const idle = Active.set("session", false, tmp.path)
    const busy = Active.set("session", true, tmp.path)
    await Promise.all([idle, busy])
    expect(await Active.remote("session", { dir: tmp.path, machine: "another-machine" })).toBe(true)
    await Active.set("session", false, tmp.path)
    expect(await Active.remote("session", { dir: tmp.path, machine: "another-machine" })).toBe(false)
  })

  test("only fresh markers from another machine count", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const file = path.join(dir, "session.remote.json")
    const now = Date.now()
    await fs.writeFile(file, JSON.stringify({ machine: "other", time: now }))
    expect(await Active.remote("session", { dir, machine: "local", now })).toBe(true)
    expect(await Active.remote("session", { dir, machine: "other", now })).toBe(false)
    expect(await Active.remote("unrelated", { dir, machine: "local", now })).toBe(false)
    expect(await Active.remote("session", { dir, machine: "local", now: now + 61_000 })).toBe(false)
    expect(await fs.stat(file).catch(() => undefined)).toBeUndefined()
  })

  test("missing directory and expiry do not block resuming", async () => {
    await using tmp = await tmpdir()
    expect(await Active.remote("session", { dir: path.join(tmp.path, "missing") })).toBe(false)
    await fs.writeFile(path.join(tmp.path, "session.remote.json"), JSON.stringify({ machine: "other", time: 0 }))
    expect(await Active.remote("session", { dir: tmp.path, machine: "local" })).toBe(false)
  })
})

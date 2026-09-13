import { describe, expect, test } from "bun:test"
import { Focus } from "../../../src/cli/cmd/tui/voice/focus"
import { tmpdir } from "../../fixture/fixture"

function command(code: string) {
  return [process.execPath, "-e", code, "--"]
}

function options(spy: string, query = 'console.log("42")'): Focus.Options {
  return {
    env: { ...process.env, DISPLAY: ":123", WINDOWID: "0x2a" },
    commands: { xprop: command(spy), xdotool: command(query) },
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000
  while (!check() && Date.now() < deadline) await Bun.sleep(20)
  expect(check()).toBe(true)
}

describe("voice focus", () => {
  test("strict XIDs and root properties", () => {
    for (const text of ["42", "0x2a", "0X2A", " 42\n"]) expect(Focus.xid(text)).toBe(42)
    expect(Focus.xid("0xffffffff")).toBe(4294967295)
    expect(Focus.xid("0")).toBe(0)
    for (const text of ["", "-1", "+42", "1e2", "1.0", "0x100000000", "4294967296", "42 extra", "42\n43"])
      expect(Focus.xid(text)).toBeUndefined()
    expect(Focus.property("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2a")).toBe(42)
    expect(Focus.property("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0")).toBe(0)
    for (const text of [
      "_NET_ACTIVE_WINDOW:  no such atom on any window.",
      "_NET_ACTIVE_WINDOW:  not found.",
      "OTHER(WINDOW): window id # 0x2a",
      "_NET_ACTIVE_WINDOW(CARDINAL): window id # 42",
      "_NET_ACTIVE_WINDOW(WINDOW): window id # 42, 43",
    ])
      expect(Focus.property(text)).toBeUndefined()
  })

  test("unavailable environments report false and allow terminal fallback", () => {
    for (const env of [{}, { DISPLAY: ":1", WINDOWID: "0" }, { DISPLAY: ":1", WINDOWID: "oops" }]) {
      const events: boolean[] = []
      const watcher = Focus.watch((value) => events.push(value), { env })
      expect(watcher.available).toBe(false)
      expect(events).toEqual([false])
      watcher.stop()
      watcher.stop()
    }
    const watcher = Focus.watch(() => {}, { ...options(""), commands: { xprop: [], xdotool: [] } })
    expect(watcher.available).toBe(false)
    watcher.stop()
  })

  test("root events are authoritative, numeric, chunked, and deduplicated", async () => {
    const events: boolean[] = []
    const watcher = Focus.watch(
      (value) => events.push(value),
      options(`
      process.stdout.write('_NET_ACTIVE_WINDOW(WINDOW): window id # ')
      setTimeout(() => console.log('0x2a'), 30)
      setTimeout(() => console.log('_NET_ACTIVE_WINDOW(WINDOW): window id # 42'), 80)
      setTimeout(() => console.log('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0'), 350)
      setInterval(() => {}, 1000)
    `),
    )
    try {
      expect(watcher.available).toBe(true)
      expect(events).toEqual([false])
      await until(() => events.length === 3)
      await Bun.sleep(350)
      expect(events).toEqual([false, true, false])
    } finally {
      watcher.stop()
    }
  })

  test("missing root property uses default getwindowfocus and fails closed", async () => {
    const events: boolean[] = []
    const watcher = Focus.watch(
      (value) => events.push(value),
      options(
        `
      console.log('_NET_ACTIVE_WINDOW:  no such atom on any window.')
      setInterval(() => {}, 1000)
    `,
        `if (process.argv.at(-1) !== 'getwindowfocus') process.exit(1); console.log('42')`,
      ),
    )
    try {
      await until(() => events.includes(true))
      expect(events).toEqual([false, true])
    } finally {
      watcher.stop()
    }
    for (const code of ["process.exit(1)", "console.log('42 garbage')", "setInterval(() => {}, 1000)"]) {
      const events: boolean[] = []
      const watcher = Focus.watch((value) => events.push(value), options("process.exit(1)", code))
      await Bun.sleep(1100)
      watcher.stop()
      expect(events).toEqual([false])
    }
  })

  test("spy errors recover through polling", async () => {
    const events: boolean[] = []
    const watcher = Focus.watch((value) => events.push(value), options("process.exit(1)"))
    try {
      await until(() => events.includes(true))
    } finally {
      watcher.stop()
    }
  })

  test("polling loses ownership on query failure and recovers", async () => {
    await using tmp = await tmpdir()
    const file = `${tmp.path}/focus`
    await Bun.write(file, "42")
    const events: boolean[] = []
    const watcher = Focus.watch(
      (value) => events.push(value),
      options(
        `console.log('_NET_ACTIVE_WINDOW:  not found.'); setInterval(() => {}, 1000)`,
        `const text = await Bun.file(${JSON.stringify(file)}).text(); console.log(text); process.exit(text === 'fail' ? 1 : 0)`,
      ),
    )
    try {
      await until(() => events.length === 2)
      await Bun.write(file, "fail")
      await until(() => events.length === 3)
      await Bun.write(file, "0x2a")
      await until(() => events.length === 4)
      expect(events).toEqual([false, true, false, true])
    } finally {
      watcher.stop()
    }
  })

  test("a stale query cannot override a newer property", async () => {
    const events: boolean[] = []
    const watcher = Focus.watch(
      (value) => events.push(value),
      options(
        `
      setTimeout(() => console.log('_NET_ACTIVE_WINDOW(WINDOW): window id # 0'), 400)
      setInterval(() => {}, 1000)
    `,
        `setTimeout(() => console.log('42'), 350)`,
      ),
    )
    try {
      await Bun.sleep(1000)
      expect(events).toEqual([false])
    } finally {
      watcher.stop()
    }
  })

  test("stop cancels pending subprocesses and prevents late callbacks", async () => {
    await using tmp = await tmpdir()
    const events: boolean[] = []
    const watcher = Focus.watch(
      (value) => events.push(value),
      options(
        `
      await Bun.write(${JSON.stringify(`${tmp.path}/spy`)}, String(process.pid))
      setTimeout(() => console.log('_NET_ACTIVE_WINDOW(WINDOW): window id # 42'), 1500)
      setInterval(() => {}, 1000)
    `,
        `await Bun.write(${JSON.stringify(`${tmp.path}/query`)}, String(process.pid)); setTimeout(() => console.log('42'), 500)`,
      ),
    )
    try {
      const deadline = Date.now() + 3000
      while (!(await Bun.file(`${tmp.path}/query`).exists()) && Date.now() < deadline) await Bun.sleep(20)
      const pids = await Promise.all(
        ["spy", "query"].map(async (name) => Number(await Bun.file(`${tmp.path}/${name}`).text())),
      )
      watcher.stop()
      watcher.stop()
      await until(() =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch (err) {
            return (err as NodeJS.ErrnoException).code === "ESRCH"
          }
        }),
      )
      await Bun.sleep(800)
      expect(events).toEqual([false])
    } finally {
      watcher.stop()
    }
  })
})

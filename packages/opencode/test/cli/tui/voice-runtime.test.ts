import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Voice } from "../../../src/cli/cmd/tui/voice/runtime"
import { Command, Limits, VoiceEvent } from "../../../src/cli/cmd/tui/voice/protocol"
import { tmpdir } from "../../fixture/fixture"

const secret = "voice-test-secret"

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for helper")
    await Bun.sleep(10)
  }
}

async function fixture(code: string) {
  const dir = await tmpdir()
  await Bun.write(path.join(dir.path, "helper.ts"), code)
  const events: VoiceEvent[] = []
  const start = Voice.create({
    auth: async () => new Headers({ authorization: `Bearer ${secret}` }),
    prepare: async () => ({
      cmd: [process.execPath, path.join(dir.path, "helper.ts")],
      cwd: dir.path,
      cache: dir.path,
    }),
    grace: 40,
    terminate: 80,
  })
  const controller = new AbortController()
  const handle = await start({
    event: (event) => {
      events.push(event)
    },
    signal: controller.signal,
  })
  return {
    dir: dir.path,
    events,
    handle,
    controller,
    async [Symbol.asyncDispose]() {
      await handle.stop()
      await dir[Symbol.asyncDispose]()
    },
  }
}

const helper = `
await Bun.write("pid", String(process.pid))
console.error("${secret}")
const reader = Bun.stdin.stream().getReader()
let pending = ""
while (true) {
  const part = await reader.read()
  if (part.done) break
  pending += new TextDecoder().decode(part.value)
  let end
  while ((end = pending.indexOf("\\n")) >= 0) {
    const command = JSON.parse(pending.slice(0, end))
    pending = pending.slice(end + 1)
    if (command.type === "start") {
      await Bun.write("start.json", JSON.stringify(command))
      await Bun.write("argv.json", JSON.stringify(process.argv))
      await Bun.write("env.json", JSON.stringify(process.env))
      process.stdout.write('{"type":"state","sta')
      await Bun.sleep(10)
      process.stdout.write('te":"waiting"}\\n')
    }
    if (command.type === "context" || command.type === "result")
      console.log(JSON.stringify({type:"transcript", role:"assistant", text:command.text}))
    if (command.type === "wake") console.log('{"type":"delegate","id":"job","text":"Do work"}')
    if (command.type === "stop") {
      await Bun.write("stopped", "yes")
      process.exit(0)
    }
  }
}
`

describe("voice protocol", () => {
  test("exports validated event and public command unions", () => {
    for (const state of ["starting", "waiting", "listening", "speaking", "off"])
      expect(VoiceEvent.safeParse({ type: "state", state }).success).toBe(true)
    expect(VoiceEvent.safeParse({ type: "transcript", role: "user", text: "bonjour" }).success).toBe(true)
    expect(VoiceEvent.safeParse({ type: "delegate", id: "a", text: "work" }).success).toBe(true)
    expect(VoiceEvent.safeParse({ type: "error", message: "failure" }).success).toBe(true)
    for (const type of ["stop", "mute", "wake"]) expect(Command.safeParse({ type }).success).toBe(true)
    expect(Command.safeParse({ type: "context", text: "" }).success).toBe(true)
    expect(Command.safeParse({ type: "result", id: "a", text: "", final: false }).success).toBe(true)
  })

  test("rejects credentials, unknown fields, wrong types and excessive lengths", () => {
    for (const value of [
      { type: "start", headers: { authorization: secret } },
      { type: "mute", extra: true },
      { type: "context", text: "x".repeat(Limits.text + 1) },
      { type: "result", id: "", text: "x", final: true },
      { type: "result", id: "x".repeat(Limits.id + 1), text: "x", final: true },
      { type: "result", id: "a", text: "x", final: "true" },
      { type: "result", id: "a", text: "x" },
    ])
      expect(Command.safeParse(value).success).toBe(false)
    for (const value of [
      { type: "state", state: "invalid" },
      { type: "state", state: "off", headers: {} },
      { type: "transcript", role: "system", text: "x" },
      { type: "transcript", role: "user", text: "x".repeat(Limits.text + 1) },
      { type: "delegate", id: "a", text: "" },
      { type: "error", message: "x".repeat(Limits.message + 1) },
      null,
    ])
      expect(VoiceEvent.safeParse(value).success).toBe(false)
  })
})

describe("voice runtime", () => {
  test("uses stdin credentials, streams split lines, forwards commands and stops cooperatively", async () => {
    await using ctx = await fixture(helper)
    await until(() => ctx.events.some((event) => event.type === "state" && event.state === "waiting"))
    expect(ctx.events[0]).toEqual({ type: "state", state: "starting" })
    expect((await Bun.file(path.join(ctx.dir, "start.json")).json()).headers.authorization).toBe(`Bearer ${secret}`)
    expect(await Bun.file(path.join(ctx.dir, "argv.json")).text()).not.toContain(secret)
    expect(await Bun.file(path.join(ctx.dir, "env.json")).text()).not.toContain(secret)
    ctx.handle.send({ type: "context", text: "français\ncontext" })
    ctx.handle.send({ type: "wake" })
    ctx.handle.send({ type: "result", id: "job", text: "done", final: true })
    await until(() => ctx.events.filter((event) => event.type === "transcript").length === 2)
    expect(ctx.events).toContainEqual({ type: "delegate", id: "job", text: "Do work" })
    expect(ctx.events).toContainEqual({ type: "transcript", role: "assistant", text: "français\ncontext" })
    const stop = ctx.handle.stop()
    expect(ctx.handle.stop()).toBe(stop)
    await stop
    expect(await Bun.file(path.join(ctx.dir, "stopped")).text()).toBe("yes")
    expect(ctx.events.at(-1)).toEqual({ type: "state", state: "off" })
    expect(ctx.events.filter((event) => event.type === "state" && event.state === "off")).toHaveLength(1)
    const count = ctx.events.length
    ctx.handle.send({ type: "wake" })
    expect(ctx.events).toHaveLength(count)
  })

  test.each([
    'console.log("not json")',
    'console.log(JSON.stringify({type:"state", state:"waiting", unexpected:true}))',
    `process.stdout.write("x".repeat(${Limits.line + 1}))`,
    'process.stdout.write("{partial"); process.exit(1)',
    "process.stdout.write(Buffer.from([0xff, 10]))",
    `console.log(JSON.stringify({type:"error", message:"${secret}"}))`,
    `console.error("${secret}"); process.exit(3)`,
  ])("fails closed without leaking diagnostics: %s", async (code) => {
    await using ctx = await fixture(`${code}; setInterval(() => {}, 1000)`)
    await until(() => ctx.events.some((event) => event.type === "state" && event.state === "off"))
    expect(ctx.events.some((event) => event.type === "error")).toBe(true)
    expect(JSON.stringify(ctx.events)).not.toContain(secret)
  })

  test("bounds queued input when a helper never reads stdin", async () => {
    await using ctx = await fixture("setInterval(() => {}, 1000)")
    for (let i = 0; i < 100; i++) ctx.handle.send({ type: "context", text: "x".repeat(Limits.text) })
    await ctx.handle.stop()
    expect(ctx.events.some((event) => event.type === "error" && event.message.includes("buffer"))).toBe(true)
  })

  test("abort escalates a stubborn helper and its owned child without touching unrelated processes", async () => {
    await using ctx = await fixture(`
      process.on("SIGTERM", () => {})
      const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdout:"ignore", stderr:"ignore"})
      await Bun.write("pid", String(process.pid))
      await Bun.write("child", String(child.pid))
      setInterval(() => {}, 1000)
    `)
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await until(() => Bun.file(path.join(ctx.dir, "child")).exists())
      const pid = Number(await Bun.file(path.join(ctx.dir, "pid")).text())
      const descendant = Number(await Bun.file(path.join(ctx.dir, "child")).text())
      ctx.controller.abort()
      await ctx.handle.stop()
      expect(() => process.kill(pid, 0)).toThrow()
      await until(async () => {
        const stat = await Bun.file(`/proc/${descendant}/stat`)
          .text()
          .catch(() => "")
        return !stat || stat.includes(") Z ")
      })
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
    } finally {
      unrelated.kill("SIGKILL")
      await unrelated.exited
    }
  })

  test.each(["prepare", "auth"] as const)("cancels pending %s without a late spawn or rejection", async (stage) => {
    const controller = new AbortController()
    const pending = Promise.withResolvers<never>()
    const entered = Promise.withResolvers<void>()
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => {
        if (stage === "prepare") {
          entered.resolve()
          return pending.promise
        }
        return { cmd: ["must-not-spawn"], cwd: "/tmp", cache: "/tmp" }
      },
      auth: async () => {
        entered.resolve()
        return pending.promise
      },
    })
    const task = start({
      signal: controller.signal,
      event: (event) => {
        events.push(event)
      },
    })
    await entered.promise
    controller.abort()
    const handle = await task
    await handle.stop()
    pending.reject(new Error(secret))
    await Bun.sleep(20)
    expect(events).toEqual([
      { type: "state", state: "starting" },
      { type: "state", state: "off" },
    ])
  })

  test("pre-aborted signals and throwing listeners never prepare or authenticate", async () => {
    let calls = 0
    const start = Voice.create({
      prepare: async () => {
        calls++
        throw new Error("unexpected")
      },
      auth: async () => {
        calls++
        throw new Error("unexpected")
      },
    })
    const handle = await start({ signal: AbortSignal.abort(), event: () => {} })
    await handle.stop()
    const broken = await start({
      event: () => {
        throw new Error(secret)
      },
    })
    await broken.stop()
    expect(calls).toBe(0)
  })

  test("authentication failures are actionable and sanitized", async () => {
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => ({ cmd: ["must-not-spawn"], cwd: "/tmp", cache: "/tmp" }),
      auth: async () => {
        throw new Error(secret)
      },
    })
    await (
      await start({
        event: (event) => {
          events.push(event)
        },
      })
    ).stop()
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(events).toContainEqual({ type: "error", message: expect.stringContaining("/connect openai") })
  })

  test("late OAuth success after abort cannot launch a helper", async () => {
    const pending = Promise.withResolvers<Headers>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => ({ cmd: ["must-not-spawn"], cwd: "/tmp", cache: "/tmp" }),
      auth: () => {
        entered.resolve()
        return pending.promise
      },
    })
    const task = start({
      signal: controller.signal,
      event: (event) => {
        events.push(event)
      },
    })
    await entered.promise
    controller.abort()
    const handle = await task
    pending.resolve(new Headers({ authorization: secret }))
    await handle.stop()
    await Bun.sleep(20)
    expect(events).toEqual([
      { type: "state", state: "starting" },
      { type: "state", state: "off" },
    ])
  })

  test("a rejected async listener stops a running helper", async () => {
    await using dir = await tmpdir()
    let off = false
    const start = Voice.create({
      prepare: async () => ({
        cmd: [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({type:"state",state:"waiting"})); setInterval(() => {}, 1000)',
        ],
        cwd: dir.path,
        cache: dir.path,
      }),
      auth: async () => new Headers({ authorization: secret }),
      grace: 20,
      terminate: 40,
    })
    const handle = await start({
      event: async (event) => {
        if (event.type !== "state") return
        if (event.state === "off") off = true
        if (event.state === "waiting") throw new Error(secret)
      },
    })
    try {
      await until(() => off)
    } finally {
      await handle.stop()
    }
  })

  test("Bun bundles both Python assets as text", async () => {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../../../src/cli/cmd/tui/voice/runtime.ts")],
      target: "bun",
      external: ["@/global", "@/plugin/codex", "zod"],
    })
    expect(build.success).toBe(true)
    const text = await build.outputs[0].text()
    expect(text).toContain("aiortc==1.14.0")
    expect(text).toContain("vosk-model-small-fr-0.22")
    expect(text).toContain("vosk-model-small-en-us-0.15")
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Voice } from "../../../src/cli/cmd/tui/voice/runtime"
import { Command, Limits, VoiceEvent } from "../../../src/cli/cmd/tui/voice/protocol"
import { tmpdir } from "../../fixture/fixture"

const secret = "voice-test-secret"
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for service")
    await Bun.sleep(10)
  }
}

async function fixture(
  code = "",
  auth = async () => new Headers({ authorization: secret }),
  opts: { hello?: string; ack?: string; packaged?: boolean; connect?: string } = {},
) {
  const dir = await tmpdir()
  await fs.chmod(dir.path, 0o700)
  const socket = path.join(dir.path, "voice.sock")
  await Bun.write(
    path.join(dir.path, "helper.ts"),
    `
    import net from "node:net"
    import fs from "node:fs"
    process.umask(0o177)
    await Bun.write("pid", String(process.pid))
    console.error("${secret}")
    let connections = 0
    net.createServer(client => {
      const attempt = ++connections
      fs.appendFileSync("connections", "connected\\n")
      client.on("error", () => {})
      client.on("close", () => Bun.write("closed", "yes"))
      ${opts.connect ?? ""}
      let pending = ""
      client.on("data", async data => {
        pending += data.toString()
        while (pending.includes("\\n")) {
          const end = pending.indexOf("\\n")
          const command = JSON.parse(pending.slice(0, end))
          pending = pending.slice(end + 1)
          if (command.type === "hello") {
            fs.writeFileSync("hello.json", JSON.stringify(command))
            ${opts.hello ?? 'client.write(JSON.stringify(command) + "\\n")'}
          }
          if (command.type === "start") {
            await Bun.write("start.json", JSON.stringify(command))
            await Bun.write("argv.json", JSON.stringify(process.argv))
            await Bun.write("env.json", JSON.stringify(process.env))
            ${opts.ack ?? 'client.write(\'{"type":"started"}\\n\')'}
            ${code}
            client.write('{"type":"state","sta')
            await Bun.sleep(5)
            client.write('te":"waiting"}\\n')
          }
          if (["context", "result"].includes(command.type))
            client.write(JSON.stringify({type:"transcript", role:"assistant", text:command.text}) + "\\n")
          if (["resume", "suspend"].includes(command.type))
            client.write(JSON.stringify({type:"state", state: command.type === "resume" ? "listening" : "waiting"}) + "\\n")
        }
      })
    }).listen(process.argv[process.argv.indexOf("--socket") + 1])
  `,
  )
  const prepared = {
    cmd: [process.execPath, path.join(dir.path, "helper.ts")],
    cwd: dir.path,
    cache: dir.path,
    socket,
    packaged: opts.packaged,
  }
  const start = Voice.create({ prepare: async () => prepared, auth, timeout: 1000, handshake: 100 })
  const events: VoiceEvent[] = []
  const controller = new AbortController()
  const handle = await start({
    event: (event) => {
      events.push(event)
    },
    signal: controller.signal,
  })
  return {
    dir: dir.path,
    socket,
    prepared,
    start,
    events,
    controller,
    handle,
    async [Symbol.asyncDispose]() {
      await handle.stop()
      const pid = await Bun.file(path.join(dir.path, "pid"))
        .text()
        .catch(() => "")
      if (pid) {
        try {
          process.kill(Number(pid), "SIGKILL")
        } catch {}
      }
      await dir[Symbol.asyncDispose]()
    },
  }
}

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
  test.each([
    "OAuth voice call rejected (HTTP 429)",
    "Microphone capture failed",
    "Voice failure: stage=connect error=TimeoutError",
    "Voice failure: stage=socket error=WSServerHandshakeError HTTP=503",
  ])("preserves safe helper diagnostics: %s", async (message) => {
    await using ctx = await fixture(
      `client.write(${JSON.stringify(JSON.stringify({ type: "error", message }) + "\n")}); return`,
    )
    await until(() => ctx.events.some((event) => event.type === "error"))
    expect(ctx.events).toContainEqual({ type: "error", message })
  })

  test.each([
    `Voice failure: stage=socket error=${secret}`,
    `Voice failure: stage=${secret} error=TimeoutError`,
    `Voice failure: stage=socket error=TimeoutError HTTP=503 ${secret}`,
    `OAuth voice call rejected (HTTP 429) ${secret}`,
  ])("rejects arbitrary diagnostic fields: %s", (message) => {
    expect(Voice.diagnostic(message)).not.toContain(secret)
    expect(Voice.diagnostic(message)).toContain("Voice helper failed")
  })

  test.each([false, true])("negotiates exact credential-free hello (packaged=%s)", async (packaged) => {
    await using ctx = await fixture("", undefined, { packaged })
    expect(await Bun.file(path.join(ctx.dir, "hello.json")).json()).toEqual({
      type: "hello",
      version: 1,
      mode: packaged ? "packaged" : "development",
    })
    expect(JSON.stringify(ctx.events)).not.toContain("started")
    expect(await Bun.file(path.join(ctx.dir, "argv.json")).text()).not.toContain(secret)
    expect((await Bun.file(path.join(ctx.dir, "argv.json")).json()).includes("--packaged")).toBe(packaged)
  })

  test.each([
    { type: "hello", version: 2, mode: "development" },
    { type: "hello", version: 1, mode: "packaged" },
    { type: "hello", version: "1", mode: "development" },
    { type: "hello", version: 1, mode: "development", extra: true },
    { type: "started" },
    { type: "delegate", id: "prehello", text: "Do not run" },
  ])("rejects incompatible hello without sending credentials: %j", async (value) => {
    await using ctx = await fixture("", undefined, {
      hello: `client.write(${JSON.stringify(JSON.stringify(value) + "\n")})`,
    })
    expect(ctx.events.some((e) => e.type === "error")).toBe(true)
    expect(ctx.events.some((e) => e.type === "delegate")).toBe(false)
    expect(await Bun.file(path.join(ctx.dir, "start.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
  })

  test.each([
    { type: "delegate", id: "preack", text: "Do not run" },
    { type: "state", state: "listening" },
    { type: "hello", version: 1, mode: "development" },
    { type: "started", extra: true },
  ])("rejects events or invalid acknowledgement before started: %j", async (value) => {
    await using ctx = await fixture("", undefined, {
      ack: `client.write(${JSON.stringify(JSON.stringify(value) + "\n")}); return`,
    })
    expect(ctx.events.map((e) => e.type)).toEqual(["state", "error", "state"])
    expect(ctx.events[0]).toEqual({ type: "state", state: "starting" })
    expect(ctx.events.at(-1)).toEqual({ type: "state", state: "off" })
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
  })

  test.each(["hello", "started"])("rejects duplicate %s after session acknowledgement", async (type) => {
    await using ctx = await fixture(`client.write(JSON.stringify({type:${JSON.stringify(type)}}) + "\\n"); return`)
    await until(() => ctx.events.some((e) => e.type === "error"))
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
  })

  test.each(["hello", "ack"] as const)("bounds missing %s acknowledgement", async (stage) => {
    await using ctx = await fixture("", undefined, { [stage]: "return" })
    expect(ctx.events.some((e) => e.type === "error")).toBe(true)
    expect(ctx.events.at(-1)).toEqual({ type: "state", state: "off" })
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
    if (stage === "hello") expect(await Bun.file(path.join(ctx.dir, "start.json")).exists()).toBe(false)
  })

  test("resolves delayed OAuth without opening an unauthenticated connection", async () => {
    await using ctx = await fixture()
    const pending = Promise.withResolvers<Headers>()
    const entered = Promise.withResolvers<void>()
    const start = Voice.create({
      prepare: async () => ctx.prepared,
      auth: () => {
        entered.resolve()
        return pending.promise
      },
      handshake: 100,
    })
    const task = start({ event: () => {} })
    await entered.promise
    await Bun.sleep(200)
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
    pending.resolve(new Headers({ authorization: secret }))
    const handle = await task
    try {
      expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\nconnected\n")
    } finally {
      await handle.stop()
    }
  })

  test.each(["connect", "hello", "ack"] as const)("reconnects a clean pre-session disconnect at %s", async (stage) => {
    const code = "if (attempt === 1) { client.end(); return }"
    await using ctx = await fixture("", undefined, {
      [stage]:
        code +
        (stage === "hello"
          ? '; client.write(JSON.stringify(command) + "\\n")'
          : stage === "ack"
            ? '; client.write(\'{"type":"started"}\\n\')'
            : ""),
    })
    await until(() => ctx.events.some((e) => e.type === "state" && e.state === "waiting"))
    expect(ctx.events.some((e) => e.type === "error")).toBe(false)
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\nconnected\n")
  })

  test("never reconnects after started", async () => {
    await using ctx = await fixture("client.end(); return")
    await until(() => ctx.events.some((e) => e.type === "error"))
    await Bun.sleep(100)
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe("connected\n")
  })

  test("repeated pre-session disconnects stop at the startup deadline", async () => {
    await using ctx = await fixture("", undefined, { connect: "client.end(); return" })
    expect(ctx.events.some((e) => e.type === "error")).toBe(true)
    const connections = await Bun.file(path.join(ctx.dir, "connections")).text()
    expect(connections.split("\n").length).toBeGreaterThan(2)
    await Bun.sleep(100)
    expect(await Bun.file(path.join(ctx.dir, "connections")).text()).toBe(connections)
  })

  test.each(["hello", "ack"] as const)(
    "cancels pending %s without a timeout error or killing the daemon",
    async (stage) => {
      await using ctx = await fixture("", undefined, {
        [stage]:
          'if (attempt > 1) { fs.writeFileSync("blocked", "yes"); return };' +
          (stage === "hello"
            ? 'client.write(JSON.stringify(command) + "\\n")'
            : 'client.write(\'{"type":"started"}\\n\')'),
      })
      const controller = new AbortController()
      const events: VoiceEvent[] = []
      const task = ctx.start({
        signal: controller.signal,
        event: (e) => {
          events.push(e)
        },
      })
      await until(() => Bun.file(path.join(ctx.dir, "blocked")).exists())
      controller.abort()
      await (await task).stop()
      await Bun.sleep(150)
      expect(events).toEqual([
        { type: "state", state: "starting" },
        { type: "state", state: "off" },
      ])
      process.kill(Number(await Bun.file(path.join(ctx.dir, "pid")).text()), 0)
    },
  )

  test("shares a detached service, streams split frames, keeps credentials off argv/env and disconnects only one client", async () => {
    await using ctx = await fixture()
    await until(() => ctx.events.some((e) => e.type === "state" && e.state === "waiting"))
    expect((await Bun.file(path.join(ctx.dir, "start.json")).json()).headers.authorization).toBe(secret)
    for (const name of ["argv.json", "env.json"])
      expect(await Bun.file(path.join(ctx.dir, name)).text()).not.toContain(secret)
    const events: VoiceEvent[] = []
    const second = await ctx.start({
      event: (e) => {
        events.push(e)
      },
    })
    try {
      ctx.handle.send({ type: "resume" })
      ctx.handle.send({ type: "context", text: "français\ncontext" })
      ctx.handle.send({ type: "suspend" })
      await until(() => ctx.events.some((e) => e.type === "transcript"))
      expect(ctx.events).toContainEqual({ type: "transcript", role: "assistant", text: "français\ncontext" })
      ctx.controller.abort()
      const stop = ctx.handle.stop()
      expect(ctx.handle.stop()).toBe(stop)
      await stop
      await until(() => Bun.file(path.join(ctx.dir, "closed")).exists())
      process.kill(Number(await Bun.file(path.join(ctx.dir, "pid")).text()), 0)
      second.send({ type: "result", id: "job", text: "still alive", final: true })
      await until(() => events.some((e) => e.type === "transcript"))
      expect(ctx.events.filter((e) => e.type === "state" && e.state === "off")).toHaveLength(1)
      const count = ctx.events.length
      ctx.handle.send({ type: "resume" })
      expect(ctx.events).toHaveLength(count)
    } finally {
      await second.stop()
    }
  })

  test.each([
    'client.write("not json\\n"); return',
    'client.write(JSON.stringify({type:"state",state:"waiting",extra:true}) + "\\n"); return',
    `client.write("x".repeat(${Limits.line + 1})); return`,
    'client.end("{partial"); return',
    "client.write(Buffer.from([255,10])); return",
    `client.write(JSON.stringify({type:"error",message:"${secret}"}) + "\\n"); return`,
    "process.exit(3)",
  ])("fails closed with sanitized diagnostics: %s", async (code) => {
    await using ctx = await fixture(code)
    await until(() => ctx.events.some((e) => e.type === "state" && e.state === "off"))
    expect(ctx.events.some((e) => e.type === "error")).toBe(true)
    expect(JSON.stringify(ctx.events)).not.toContain(secret)
  })

  test("bounds queued socket input and rejects invalid commands", async () => {
    await using ctx = await fixture("client.pause()")
    for (let i = 0; i < 100; i++) ctx.handle.send({ type: "context", text: "x".repeat(Limits.text) })
    expect(ctx.events.some((e) => e.type === "error" && e.message.includes("buffer"))).toBe(true)
    await using other = await fixture()
    other.handle.send({ type: "context", text: "x".repeat(Limits.text + 1) })
    expect(other.events.some((e) => e.type === "error" && e.message.includes("Invalid"))).toBe(true)
  })

  test("auth failures are actionable and sanitized", async () => {
    await using ctx = await fixture("", async () => {
      throw new Error(secret)
    })
    expect(ctx.events).toContainEqual({ type: "error", message: expect.stringContaining("/connect openai") })
    expect(JSON.stringify(ctx.events)).not.toContain(secret)
  })

  test("rejects unsafe sockets before acquiring credentials", async () => {
    await using ctx = await fixture()
    await fs.chmod(ctx.socket, 0o666)
    let calls = 0
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => ctx.prepared,
      auth: async () => {
        calls++
        return new Headers()
      },
    })
    await (
      await start({
        event: (e) => {
          events.push(e)
        },
      })
    ).stop()
    expect(calls).toBe(0)
    expect(events.some((e) => e.type === "error")).toBe(true)
    await fs.chmod(ctx.socket, 0o600)
    await fs.rename(ctx.socket, ctx.socket + ".real")
    await fs.symlink(ctx.socket + ".real", ctx.socket)
    await (await start({ event: () => {} })).stop()
    expect(calls).toBe(0)
  })

  test.each(["prepare", "auth"] as const)("cancels pending %s and ignores late OAuth", async (stage) => {
    await using ctx = await fixture()
    const pending = Promise.withResolvers<never>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => {
        if (stage === "prepare") {
          entered.resolve()
          return pending.promise
        }
        return ctx.prepared
      },
      auth: async () => {
        entered.resolve()
        return pending.promise
      },
    })
    const task = start({
      signal: controller.signal,
      event: (e) => {
        events.push(e)
      },
    })
    await entered.promise
    controller.abort()
    await (await task).stop()
    pending.reject(new Error(secret))
    await Bun.sleep(20)
    expect(events).toEqual([
      { type: "state", state: "starting" },
      { type: "state", state: "off" },
    ])
  })

  test("pre-aborted and throwing listeners do not prepare", async () => {
    let calls = 0
    const start = Voice.create({
      prepare: async () => {
        calls++
        throw Error(secret)
      },
      auth: async () => {
        calls++
        throw Error(secret)
      },
    })
    await (await start({ signal: AbortSignal.abort(), event: () => {} })).stop()
    await (
      await start({
        event: () => {
          throw Error(secret)
        },
      })
    ).stop()
    expect(calls).toBe(0)
  })

  test("late OAuth success after abort never sends credentials", async () => {
    await using ctx = await fixture()
    await until(() => Bun.file(path.join(ctx.dir, "start.json")).exists())
    await fs.unlink(path.join(ctx.dir, "start.json"))
    const pending = Promise.withResolvers<Headers>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const start = Voice.create({
      prepare: async () => ctx.prepared,
      auth: () => {
        entered.resolve()
        return pending.promise
      },
    })
    const task = start({ signal: controller.signal, event: () => {} })
    await entered.promise
    controller.abort()
    await (await task).stop()
    pending.resolve(new Headers({ authorization: secret }))
    await Bun.sleep(30)
    expect(await Bun.file(path.join(ctx.dir, "start.json")).exists()).toBe(false)
  })

  test("production requires installed voice assets, never a uv fallback", async () => {
    expect(Voice.packaged("/private/voice")).toEqual({
      cmd: ["/usr/lib/opencode-voice/bin/python", "-E", "-s", "/usr/lib/opencode-voice/daemon.py"],
      cwd: "/usr/lib/opencode-voice",
      cache: "/usr/share/opencode-voice/models",
      socket: "/private/voice/daemon-v1.sock",
      packaged: true,
    })
    const installed = await fs.access("/usr/lib/opencode-voice/daemon.py").then(
      () => true,
      () => false,
    )
    if (!installed) {
      await expect(Voice.prepare(false)).rejects.toThrow("Install opencode-voice")
      return
    }
    const prepared = await Voice.prepare(false)
    expect(prepared.cmd).toEqual([
      "/usr/lib/opencode-voice/bin/python",
      "-E",
      "-s",
      "/usr/lib/opencode-voice/daemon.py",
    ])
    expect(path.basename(prepared.socket)).toBe("daemon-v1.sock")
    expect(prepared.cache).toBe("/usr/share/opencode-voice/models")
    expect(prepared.packaged).toBe(true)
  })

  test.skipIf(!Bun.which("uv") || !Bun.which("arecord") || !Bun.which("aplay"))(
    "source development prepares a separate endpoint and bundled daemon without launching uv",
    async () => {
      await using dir = await tmpdir()
      await fs.chmod(dir.path, 0o700)
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { Voice } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../src/cli/cmd/tui/voice/runtime.ts"))}; console.log(JSON.stringify(await Voice.prepare()))`,
        ],
        {
          env: { ...process.env, XDG_CACHE_HOME: dir.path, XDG_RUNTIME_DIR: dir.path },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = await new Response(child.stdout).text()
      const errors = await new Response(child.stderr).text()
      expect(await child.exited, errors).toBe(0)
      const prepared = JSON.parse(output)
      expect(prepared.socket).toBe(path.join(dir.path, "opencode-voice", "daemon-dev-v1.sock"))
      expect(prepared.socket).not.toBe(Voice.packaged(path.dirname(prepared.socket)).socket)
      expect(prepared.cmd).toEqual([
        Bun.which("uv"),
        "--no-config",
        "run",
        "--python",
        "3.11",
        "--no-project",
        "--script",
        path.join(prepared.cwd, "daemon.py"),
      ])
      expect(await Bun.file(path.join(prepared.cwd, "daemon.py")).text()).toContain("# /// script")
      expect(await fs.lstat(prepared.socket).catch(() => undefined)).toBeUndefined()
    },
  )

  test("async listener rejection disconnects without killing service", async () => {
    await using ctx = await fixture()
    let off = false
    const handle = await ctx.start({
      event: async (e) => {
        if (e.type === "state" && e.state === "off") off = true
        if (e.type === "state" && e.state === "waiting") throw Error(secret)
      },
    })
    try {
      await until(() => off)
    } finally {
      await handle.stop()
    }
    process.kill(Number(await Bun.file(path.join(ctx.dir, "pid")).text()), 0)
  })

  test("startup retries are bounded", async () => {
    await using dir = await tmpdir()
    await fs.chmod(dir.path, 0o700)
    const events: VoiceEvent[] = []
    const start = Voice.create({
      prepare: async () => ({
        cmd: [process.execPath, "-e", "process.exit(0)"],
        cwd: dir.path,
        cache: dir.path,
        socket: path.join(dir.path, "absent"),
      }),
      auth: async () => new Headers({ authorization: secret }),
      timeout: 100,
    })
    await (
      await start({
        event: (e) => {
          events.push(e)
        },
      })
    ).stop()
    expect(events).toContainEqual({ type: "error", message: expect.stringContaining("Unable to connect") })
  })

  test("bundles all three Python assets", async () => {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../../../src/cli/cmd/tui/voice/runtime.ts")],
      target: "bun",
      external: ["@/global", "@/plugin/codex", "@/installation", "zod"],
    })
    expect(build.success).toBe(true)
    const text = await build.outputs[0].text()
    for (const value of [
      "aiortc==1.14.0",
      "vosk-model-small-fr-0.22",
      "vosk-model-small-en-us-0.15",
      "class Endpoint:",
    ])
      expect(text).toContain(value)
  })
})

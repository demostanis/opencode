import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { Installation } from "@/installation"
import { codexAuthHeaders } from "@/plugin/codex"
import bridge from "./bridge.py" with { type: "text" }
import wake from "./wake.py" with { type: "text" }
import daemon from "./daemon.py" with { type: "text" }
import { Command, Limits, VoiceEvent } from "./protocol"

export namespace Voice {
  const log = Log.create({ service: "voice" })

  export function diagnostic(message: string) {
    if (/^OAuth voice call rejected \(HTTP [1-5]\d{2}\)$/.test(message)) return message
    if (message === "Microphone capture failed") return message
    if (
      /^Voice failure: stage=(startup|models|capture|offer|call|answer|socket|connect|session) error=(TimeoutError|ClientConnectorError|ClientConnectorDNSError|ClientConnectorCertificateError|ClientConnectorSSLError|ClientOSError|ServerDisconnectedError|ServerTimeoutError|WSServerHandshakeError|ClientResponseError|ConnectionResetError|BrokenPipeError|IncompleteReadError|FileNotFoundError|PermissionError|OSError|ValueError|RuntimeError|ModuleNotFoundError|ImportError|Exception)( HTTP=[1-5]\d{2})?$/.test(
        message,
      )
    )
      return message
    return "Voice helper failed; check audio devices, installed models and OAuth, then restart voice."
  }

  export interface Options {
    event: (event: VoiceEvent) => void
    signal?: AbortSignal
  }

  export interface Handle {
    send(command: Command): void
    stop(): Promise<void>
  }

  /** Local dependencies only; create() permits isolated subprocess tests without OAuth or audio. */
  export interface Dependencies {
    auth(): Promise<Headers>
    prepare(): Promise<{ cmd: string[]; cwd: string; cache: string; socket: string; packaged?: boolean }>
    timeout?: number
    handshake?: number
  }

  async function directory(dir: string) {
    await fs.mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err
    })
    const info = await fs.lstat(dir)
    if (!info.isDirectory() || info.uid !== process.getuid!()) throw new Error("Unsafe voice cache")
    await fs.chmod(dir, 0o700)
  }

  export function packaged(dir: string) {
    return {
      cmd: ["/usr/lib/opencode-voice/bin/python", "-E", "-s", "/usr/lib/opencode-voice/daemon.py"],
      cwd: "/usr/lib/opencode-voice",
      cache: "/usr/share/opencode-voice/models",
      socket: path.join(dir, "daemon-v1.sock"),
      packaged: true,
    }
  }

  export async function prepare(local = Installation.isLocal()) {
    if (process.platform !== "linux") throw new Error("Voice requires Linux with ALSA audio utilities.")
    if (!local) {
      await Promise.all([
        fs.access("/usr/lib/opencode-voice/bin/python", constants.X_OK),
        fs.access("/usr/lib/opencode-voice/daemon.py", constants.R_OK),
        fs.access("/usr/share/opencode-voice/models", constants.R_OK),
      ]).catch(() => {
        throw new Error("Install opencode-voice to enable voice (including its packaged recognition models).")
      })
    }
    if (!Bun.which("arecord") || !Bun.which("aplay"))
      throw new Error("Install alsa-utils (arecord and aplay), and configure the ALSA pulse device to enable voice.")
    const root = path.join(Global.Path.cache, "voice")
    await directory(root)
    const runtime = process.env.XDG_RUNTIME_DIR
    const dir = runtime ? path.join(runtime, "opencode-voice") : root
    await secure(path.dirname(dir), false)
    await directory(dir)
    if (!local) return packaged(dir)
    const uv = Bun.which("uv")
    if (!uv) throw new Error("Install uv (https://docs.astral.sh/uv/) to enable voice in development.")
    const cache = path.join(root, "models")
    await directory(cache)
    const digest = new Bun.CryptoHasher("sha256")
      .update(bridge)
      .update("\0")
      .update(wake)
      .update("\0")
      .update(daemon)
      .digest("hex")
    const cwd = path.join(root, `v1-${digest}`)
    const temp = await fs.mkdtemp(path.join(root, ".scripts-"))
    try {
      await fs.chmod(temp, 0o700)
      await Promise.all(
        [
          ["bridge.py", bridge],
          ["wake.py", wake],
          ["daemon.py", daemon],
        ].map(async ([name, text]) => {
          await Bun.write(path.join(temp, name), text, { mode: 0o600 })
        }),
      )
      await fs.rename(temp, cwd).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST" && err.code !== "ENOTEMPTY") throw err
      })
      await directory(cwd)
      await Promise.all(
        [
          ["bridge.py", bridge],
          ["wake.py", wake],
          ["daemon.py", daemon],
        ].map(async ([name, text]) => {
          const file = await fs.open(path.join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const info = await file.stat()
            if (!info.isFile() || info.uid !== process.getuid!() || info.size !== Buffer.byteLength(text))
              throw new Error("Unsafe voice script")
            if ((await file.readFile("utf8")) !== text) throw new Error("Invalid voice script")
            await file.chmod(0o600)
          } finally {
            await file.close()
          }
        }),
      )
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }
    // Explicit Python and a cache cwd avoid the host project's .python-version and uv configuration.
    return {
      cmd: [uv, "--no-config", "run", "--python", "3.11", "--no-project", "--script", path.join(cwd, "daemon.py")],
      cwd,
      cache,
      socket: path.join(dir, "daemon-dev-v1.sock"),
      packaged: false,
    }
  }

  async function secure(dir: string, private_ = true) {
    if (!path.isAbsolute(dir)) throw new Error("Unsafe voice directory")
    const info = await fs.lstat(dir)
    if (
      !info.isDirectory() ||
      ![0, process.getuid!()].includes(info.uid) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && info.mode & 0o1000))
    )
      throw new Error("Unsafe voice directory")
    if (private_ && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700))
      throw new Error("Unsafe voice directory")
    if (dir !== path.dirname(dir)) await secure(path.dirname(dir), false)
  }

  async function endpoint(socket: string) {
    await secure(path.dirname(socket))
    const info = await fs.lstat(socket)
    if (!info.isSocket() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600)
      throw new Error("Unsafe voice socket")
    return info
  }

  export function create(deps: Dependencies) {
    return async function start(opts: Options): Promise<Handle> {
      const trace = crypto.randomUUID()
      const started = performance.now()
      const timing = (event: string, fields: Record<string, string | number | boolean | undefined> = {}) =>
        log.info("voice.timing", {
          trace,
          pid: process.pid,
          at: Date.now(),
          ms: Math.round(performance.now() - started),
          event,
          ...fields,
        })
      timing("startup.begin")
      let socket: net.Socket | undefined
      let closed = false
      let stopping: Promise<void> | undefined
      let writes = 0
      let failure = "Unable to prepare voice; check cache permissions and installed dependencies."
      const cancel = Promise.withResolvers<void>()
      function emit(event: VoiceEvent) {
        try {
          Promise.resolve(opts.event(event)).catch(() => void stop())
        } catch {
          void stop()
        }
      }
      function stop(): Promise<void> {
        if (stopping) return stopping
        closed = true
        cancel.resolve()
        opts.signal?.removeEventListener("abort", abort)
        // Disconnect only this client. The daemon owns its lifetime and shared models.
        socket?.destroy()
        stopping = Promise.resolve().then(() => emit({ type: "state", state: "off" }))
        return stopping
      }
      function abort() {
        void stop()
      }
      function fail(message: string) {
        if (closed) return
        log.error(message)
        emit({ type: "error", message })
        void stop()
      }
      function enqueue(line: string) {
        if (closed || !socket) return
        if (
          Buffer.byteLength(line) > Limits.line ||
          socket.writableLength + Buffer.byteLength(line) > Limits.queue ||
          writes >= Limits.commands
        )
          return fail("Voice command buffer exceeded its limit; restart voice and send smaller updates.")
        writes++
        socket.write(line, () => {
          writes--
        })
      }
      const handle: Handle = {
        send(command) {
          if (closed) return
          const parsed = Command.safeParse(command)
          if (!parsed.success) return fail("Invalid voice command; check command fields and text length.")
          if (command.type !== "context")
            timing("command." + command.type, {
              id: "id" in command ? command.id : undefined,
              final: command.type === "result" ? command.final : undefined,
            })
          if (parsed.data.type === "stop") return abort()
          enqueue(JSON.stringify(parsed.data) + "\n")
        },
        stop,
      }
      opts.signal?.addEventListener("abort", abort, { once: true })
      if (opts.signal?.aborted) {
        await stop()
        return handle
      }
      emit({ type: "state", state: "starting" })
      try {
        if (closed) return handle
        const prepared = await Promise.race([deps.prepare(), cancel.promise])
        timing("prepare.done")
        if (closed || !prepared) return handle
        failure = "Unable to connect to voice service; check opencode-voice installation and socket permissions."
        await endpoint(prepared.socket).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err
        })
        if (closed) return handle
        failure = "Voice authentication failed; run /connect openai and choose ChatGPT Pro/Plus OAuth, then retry."
        const headers = await Promise.race([deps.auth(), cancel.promise])
        timing("auth.done")
        if (closed || !headers) return handle
        if (!headers.get("authorization")) throw new Error("Missing credentials")
        failure =
          "Unable to connect to voice service; check opencode-voice installation, protocol and socket permissions."
        const hello = { type: "hello", version: 1, mode: prepared.packaged ? "packaged" : "development" }
        const deadline = Date.now() + (deps.timeout ?? 120_000)
        let launched = false
        while (!closed) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const before = await endpoint(prepared.socket)
            if (closed) return handle
            const client = net.createConnection({ path: prepared.socket })
            socket = client
            const session = Promise.withResolvers<void>()
            let phase = "connecting"
            let pending = Buffer.alloc(0)
            function reject(err: Error) {
              if (phase === "failed" || closed) return
              if (phase === "ready") {
                fail("Voice service connection or protocol failed; restart voice.")
                return
              }
              phase = "failed"
              session.reject(err)
              client.destroy()
            }
            function arm() {
              clearTimeout(timer)
              timer = setTimeout(
                () => reject(new Error("Voice handshake timeout")),
                Math.max(1, Math.min(deps.handshake ?? 5000, deadline - Date.now())),
              )
            }
            arm()
            client.on("error", reject)
            client.on("close", () =>
              reject(
                pending.length
                  ? new Error("Incomplete voice frame")
                  : Object.assign(new Error("Voice service disconnected"), { code: "ECONNRESET" }),
              ),
            )
            client.on("data", (chunk: Buffer) => {
              if (closed || phase === "failed") return
              try {
                let offset = 0
                while (offset < chunk.length && !closed && phase !== "failed") {
                  const end = chunk.indexOf(10, offset)
                  const part = chunk.subarray(offset, end < 0 ? chunk.length : end)
                  if (pending.length + part.length > Limits.line) throw new Error("Event overflow")
                  pending = Buffer.concat([pending, part])
                  if (end < 0) break
                  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending))
                  pending = Buffer.alloc(0)
                  offset = end + 1
                  if (phase === "hello") {
                    if (
                      !value ||
                      Object.keys(value).length !== 3 ||
                      value.type !== hello.type ||
                      value.version !== hello.version ||
                      value.mode !== hello.mode
                    )
                      throw new Error("Incompatible voice service")
                    phase = "starting"
                    arm()
                    enqueue(
                      JSON.stringify({
                        type: "start",
                        headers: Object.fromEntries(headers),
                        cache: prepared.cache,
                        timing: true,
                      }) + "\n",
                    )
                    continue
                  }
                  if (phase === "starting") {
                    if (!value || value.type !== "started" || Object.keys(value).length !== 1)
                      throw new Error("Expected voice started acknowledgement")
                    phase = "ready"
                    timing("handshake.done")
                    clearTimeout(timer)
                    session.resolve()
                    continue
                  }
                  if (phase !== "ready") throw new Error("Unexpected voice handshake")
                  const event = VoiceEvent.parse(value)
                  if (event.type === "timing") {
                    timing("remote." + event.event, {
                      id: event.id,
                      role: event.role,
                      source_at: event.at,
                      delivery_ms: Date.now() - event.at,
                    })
                    continue
                  }
                  timing("receive." + event.type, {
                    id: event.type === "delegate" ? event.id : undefined,
                    state: event.type === "state" ? event.state : undefined,
                    role: event.type === "transcript" ? event.role : undefined,
                  })
                  if (event.type === "error") {
                    fail(diagnostic(event.message))
                    continue
                  }
                  if (event.type === "state" && event.state === "off") {
                    void stop()
                    continue
                  }
                  emit(event)
                }
              } catch {
                reject(new Error("Invalid or unexpected voice service output"))
              }
            })
            client.once("connect", () => {
              void endpoint(prepared.socket)
                .then((after) => {
                  if (closed || phase === "failed") return
                  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Voice socket changed")
                  phase = "hello"
                  arm()
                  enqueue(JSON.stringify(hello) + "\n")
                })
                .catch(reject)
            })
            await Promise.race([session.promise, cancel.promise])
            return handle
          } catch (err) {
            socket?.destroy()
            socket = undefined
            if (closed) return handle
            const code = (err as NodeJS.ErrnoException).code ?? ""
            if (!["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) throw err
            if (Date.now() >= deadline) throw new Error("Voice startup timeout")
            // A clean pre-session disconnect can race daemon idle shutdown. Never retry an established session.
            if (!launched && ["ENOENT", "ECONNREFUSED"].includes(code)) {
              await secure(path.dirname(prepared.socket))
              if (closed) return handle
              const child = Bun.spawn(
                [
                  ...prepared.cmd,
                  "--socket",
                  prepared.socket,
                  "--cache",
                  prepared.cache,
                  ...(prepared.packaged ? ["--packaged"] : []),
                ],
                { cwd: prepared.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
              )
              child.unref()
              launched = true
            }
            await Promise.race([Bun.sleep(50), cancel.promise])
          } finally {
            clearTimeout(timer)
          }
        }
      } catch (err) {
        const message =
          failure.startsWith("Unable to prepare") &&
          err instanceof Error &&
          /^(Install uv \(|Install alsa-utils \(|Install opencode-voice |Voice requires Linux)/.test(err.message)
            ? err.message
            : failure
        fail(message)
        await stop()
      }
      return handle
    }
  }

  export const start = create({ auth: codexAuthHeaders, prepare })
}

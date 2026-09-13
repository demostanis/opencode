import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { codexAuthHeaders } from "@/plugin/codex"
import bridge from "./bridge.py" with { type: "text" }
import wake from "./wake.py" with { type: "text" }
import { Command, Limits, VoiceEvent } from "./protocol"

export namespace Voice {
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
    prepare(): Promise<{ cmd: string[]; cwd: string; cache: string }>
    grace?: number
    terminate?: number
  }

  async function directory(dir: string) {
    await fs.mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err
    })
    const info = await fs.lstat(dir)
    if (!info.isDirectory() || info.uid !== process.getuid!()) throw new Error("Unsafe voice cache")
    await fs.chmod(dir, 0o700)
  }

  async function prepare() {
    if (process.platform !== "linux") throw new Error("Voice requires Linux with ALSA audio utilities.")
    const uv = Bun.which("uv")
    if (!uv) throw new Error("Install uv (https://docs.astral.sh/uv/) to enable voice.")
    if (!Bun.which("arecord") || !Bun.which("aplay"))
      throw new Error("Install alsa-utils (arecord and aplay), and configure the ALSA pulse device to enable voice.")
    const root = path.join(Global.Path.cache, "voice")
    await directory(root)
    const cache = path.join(root, "models")
    await directory(cache)
    const digest = new Bun.CryptoHasher("sha256").update(bridge).update("\0").update(wake).digest("hex")
    const cwd = path.join(root, `v1-${digest}`)
    const temp = await fs.mkdtemp(path.join(root, ".scripts-"))
    try {
      await fs.chmod(temp, 0o700)
      await Promise.all(
        [
          ["bridge.py", bridge],
          ["wake.py", wake],
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
      cmd: [uv, "--no-config", "run", "--python", "3.11", "--no-project", "--script", path.join(cwd, "bridge.py")],
      cwd,
      cache,
    }
  }

  export function create(deps: Dependencies) {
    return async function start(opts: Options): Promise<Handle> {
      let child: ReturnType<typeof spawn> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let closed = false
      let stopping: Promise<void> | undefined
      let writing = false
      let bytes = 0
      let failure = "Unable to prepare voice; check cache permissions and installed dependencies."
      const queue: string[] = []
      const cancel = Promise.withResolvers<void>()

      function emit(event: VoiceEvent) {
        try {
          Promise.resolve(opts.event(event)).catch(() => {
            void stop()
          })
        } catch {
          // UI callbacks must not strand an audio process or reject background tasks.
          void stop()
        }
      }

      function kill(signal: NodeJS.Signals | 0) {
        if (!child) return false
        try {
          // Only this detached helper's process group, including uv and its audio children.
          process.kill(-child.pid, signal)
          return true
        } catch {
          return false
        }
      }

      async function wait(ms: number) {
        // uv can exit before Python finishes cleaning up its audio children.
        const deadline = Date.now() + ms
        while (kill(0) && Date.now() < deadline) await Bun.sleep(Math.max(1, Math.min(20, deadline - Date.now())))
      }

      function stop(): Promise<void> {
        if (stopping) return stopping
        closed = true
        cancel.resolve()
        opts.signal?.removeEventListener("abort", abort)
        queue.length = 0
        stopping = (async () => {
          if (child) {
            try {
              child.stdin.write('{"type":"stop"}\n')
            } catch {}
            await wait(deps.grace ?? 500)
            kill("SIGTERM")
            await wait(deps.terminate ?? 2_000)
            kill("SIGKILL")
            await wait(1_000)
            try {
              void Promise.resolve(child.stdin.end()).catch(() => {})
            } catch {}
            void reader?.cancel().catch(() => {})
          }
        })()
          .catch(() => {})
          .then(() => {
            emit({ type: "state", state: "off" })
          })
        return stopping
      }

      function abort() {
        void stop()
      }

      function fail(message: string) {
        if (closed) return
        emit({ type: "error", message })
        void stop()
      }

      async function flush() {
        if (writing || !child || closed) return
        writing = true
        try {
          while (queue.length && !closed) {
            const line = queue.shift()!
            child.stdin.write(line)
            await child.stdin.flush()
            bytes -= Buffer.byteLength(line)
          }
        } catch {
          fail("Voice helper input closed; restart voice.")
        } finally {
          writing = false
        }
      }

      function enqueue(line: string) {
        if (closed) return
        if (
          Buffer.byteLength(line) > Limits.line ||
          bytes + Buffer.byteLength(line) > Limits.queue ||
          queue.length >= Limits.commands
        ) {
          fail("Voice command buffer exceeded its limit; restart voice and send smaller updates.")
          return
        }
        bytes += Buffer.byteLength(line)
        queue.push(line)
        void flush()
      }

      const handle: Handle = {
        send(command) {
          if (closed) return
          const parsed = Command.safeParse(command)
          if (!parsed.success) return fail("Invalid voice command; check command fields and text length.")
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
      // First use installs pinned Python dependencies and downloads both English/French Vosk weights.
      emit({ type: "state", state: "starting" })
      try {
        if (closed) return handle
        const prepared = await Promise.race([deps.prepare(), cancel.promise])
        if (closed || !prepared) return handle
        failure = "Voice authentication failed; run /connect openai and choose ChatGPT Pro/Plus OAuth, then retry."
        const headers = await Promise.race([deps.auth(), cancel.promise])
        if (closed || !headers) return handle
        failure = "Unable to launch voice; check uv, Python 3.11, network access and cache permissions."
        if (!headers.get("authorization")) throw new Error("Missing credentials")
        child = spawn(prepared)
        enqueue(JSON.stringify({ type: "start", headers: Object.fromEntries(headers), cache: prepared.cache }) + "\n")
        const output = read(child.stdout).catch(() => fail("Invalid or oversized voice helper output; restart voice."))
        void child.exited
          .then(async () => {
            // Drain final events, but do not hang on a descendant holding stdout open.
            await Promise.race([output, Bun.sleep(100)])
            fail(
              "Voice helper exited; check audio devices, network/model downloads and your OAuth session, then restart voice.",
            )
          })
          .catch(() => fail("Voice helper process failed; restart voice."))
      } catch (err) {
        // Only preparation errors from our own dependency checks are safe to display.
        const message =
          failure.startsWith("Unable to prepare") &&
          err instanceof Error &&
          /^(Install uv \(|Install alsa-utils \(|Voice requires Linux)/.test(err.message)
            ? err.message
            : failure
        fail(message)
        await stop()
      }
      return handle

      async function read(stream: ReadableStream<Uint8Array>) {
        const source = stream.getReader()
        reader = source
        let pending = Buffer.alloc(0)
        try {
          while (!closed) {
            const chunk = await source.read()
            if (chunk.done) {
              if (pending.length) throw new Error("Incomplete event")
              return
            }
            let offset = 0
            while (offset < chunk.value.length && !closed) {
              const end = chunk.value.indexOf(10, offset)
              const part = chunk.value.subarray(offset, end < 0 ? chunk.value.length : end)
              if (pending.length + part.length > Limits.line) throw new Error("Event overflow")
              pending = Buffer.concat([pending, part])
              if (end < 0) break
              const event = VoiceEvent.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending)))
              pending = Buffer.alloc(0)
              offset = end + 1
              if (event.type === "error") {
                fail("Voice helper failed; check audio devices, model downloads and OAuth, then restart voice.")
                continue
              }
              if (event.type === "state" && event.state === "off") {
                void stop()
                continue
              }
              emit(event)
            }
          }
        } finally {
          await source.cancel().catch(() => {})
          source.releaseLock()
        }
      }
    }
  }

  function spawn(opts: { cmd: string[]; cwd: string }) {
    return Bun.spawn(opts.cmd, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true })
  }

  export const start = create({ auth: codexAuthHeaders, prepare })
}

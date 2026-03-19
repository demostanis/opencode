import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { Plugin } from "@/plugin"

export namespace Pty {
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  const encoder = new TextEncoder()

  type Socket = {
    readyState: number
    data?: unknown
    send: (data: string | Uint8Array | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON.
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited", "killed"]),
      pid: z.number(),
      exitCode: z.number().optional(),
      cursor: z.number().optional(),
      parentSessionID: z.string().optional(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    parentSessionID: z.string().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
    Output: BusEvent.define(
      "pty.output",
      z.object({ id: Identifier.schema("pty"), chunk: z.string(), cursor: z.number() }),
    ),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<unknown, Socket>
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      for (const session of sessions.values()) {
        try {
          session.process.kill()
        } catch {}
        for (const [key, ws] of session.subscribers.entries()) {
          try {
            if (ws.data === key) ws.close()
          } catch {
            // ignore
          }
        }
      }
      sessions.clear()
    },
  )

  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().get(id)?.info
  }

  export async function create(input: CreateInput) {
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred()
    const args: string[] = []
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const env = {
      ...process.env,
      ...input.env,
      ...shellEnv.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    } as Record<string, string>

    log.info("creating session", { id, cmd: command, args, cwd })
    const spawn = await pty()
    let ptyProcess: IPty
    try {
      const shellPath = await Shell.acceptable()
      const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command
      ptyProcess = spawn(shellPath, ["-c", fullCommand], {
        name: "xterm-256color",
        cwd,
        env,
      })
    } catch (e) {
      log.error("session spawn failed", { id, cmd: command, error: String(e) })
      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "exited",
        pid: -1,
        exitCode: -1,
        cursor: 0,
        parentSessionID: input.parentSessionID,
      } as const
      const session: ActiveSession = {
        info,
        process: {
          pid: -1,
          onData: () => {},
          onExit: () => {},
          kill: () => {},
          resize: () => {},
          write: () => {},
        } as unknown as IPty,
        buffer: `\r\n\x1b[90mError: Background process spawn failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`,
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
      }
      state().set(id, session)
      Bus.publish(Event.Created, { info })
      Bus.publish(Event.Exited, { id, exitCode: -1 })
      return info
    }

    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
      cursor: 0,
      parentSessionID: input.parentSessionID,
    } as const
    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: "",
      bufferCursor: 0,
      cursor: 0,
      subscribers: new Map(),
    }
    state().set(id, session)
    ptyProcess.onData((chunk) => {
      session.cursor += chunk.length
      session.info.cursor = session.cursor

      for (const [key, ws] of session.subscribers.entries()) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(key)
          continue
        }

        if (ws.data !== key) {
          session.subscribers.delete(key)
          continue
        }

        try {
          ws.send(chunk)
        } catch {
          session.subscribers.delete(key)
        }
      }

      Bus.publish(Event.Output, { id, chunk, cursor: session.cursor })

      session.buffer += chunk
      if (session.buffer.length <= BUFFER_LIMIT) return
      const excess = session.buffer.length - BUFFER_LIMIT
      session.buffer = session.buffer.slice(excess)
      session.bufferCursor += excess
    })
    ptyProcess.onExit(({ exitCode }) => {
      log.info("session exited", { id, exitCode })
      const wasKilled = session.info.status === "killed"
      if (!wasKilled) {
        session.info.status = "exited"
      }
      session.info.exitCode = exitCode

      const msg = wasKilled ? "" : `\r\n\x1b[90mProcess exited with code ${exitCode}.\x1b[0m\r\n`

      if (msg) {
        session.buffer += msg
        session.cursor += msg.length
        session.info.cursor = session.cursor

        for (const [key, ws] of session.subscribers.entries()) {
          if (ws.readyState !== 1) {
            session.subscribers.delete(key)
            continue
          }
          if (ws.data !== key) {
            session.subscribers.delete(key)
            continue
          }
          try {
            ws.send(msg)
          } catch {
            session.subscribers.delete(key)
          }
        }
        Bus.publish(Event.Output, { id, chunk: msg, cursor: session.cursor })
      }

      for (const [key, ws] of session.subscribers.entries()) {
        try {
          if (ws.data === key) ws.close()
        } catch {
          // ignore
        }
      }
      session.subscribers.clear()
      Bus.publish(Event.Exited, { id, exitCode })
    })
    Bus.publish(Event.Created, { info })
    return info
  }

  export function cleanup(parentSessionID: string) {
    for (const [id, session] of state()) {
      if (session.info.parentSessionID === parentSessionID) {
        remove(id)
      }
    }
  }

  export function read(id: string) {
    return state().get(id)?.buffer
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows)
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function kill(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("killing session", { id })
    try {
      session.process.kill()
    } catch {}
    session.info.status = "killed"

    const msg = "\r\n\x1b[90mProcess was killed.\x1b[0m\r\n"
    session.buffer += msg
    session.cursor += msg.length
    session.info.cursor = session.cursor

    for (const [key, ws] of session.subscribers.entries()) {
      if (ws.readyState !== 1) {
        session.subscribers.delete(key)
        continue
      }
      if (ws.data !== key) {
        session.subscribers.delete(key)
        continue
      }
      try {
        ws.send(msg)
      } catch {
        session.subscribers.delete(key)
      }
    }

    Bus.publish(Event.Output, { id, chunk: msg, cursor: session.cursor })
    Bus.publish(Event.Updated, { info: session.info })
  }

  export async function restart(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("restarting session", { id })

    // Kill old process if running
    if (session.info.status === "running") {
      try {
        session.process.kill()
      } catch {}
    }

    // Preserve old buffer
    const oldBuffer = session.buffer
    const oldBufferCursor = session.bufferCursor
    const oldCursor = session.cursor

    // Spawn new process
    const spawn = await pty()
    const shellPath = await Shell.acceptable()
    const fullCommand =
      session.info.args.length > 0 ? `${session.info.command} ${session.info.args.join(" ")}` : session.info.command
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    } as Record<string, string>

    if (process.platform === "win32") {
      env.LC_ALL = "C.UTF-8"
      env.LC_CTYPE = "C.UTF-8"
      env.LANG = "C.UTF-8"
    }

    let ptyProcess: IPty
    try {
      ptyProcess = spawn(shellPath, ["-c", fullCommand], {
        name: "xterm-256color",
        cwd: session.info.cwd,
        env,
      })
    } catch (e) {
      log.error("restart spawn failed", { id, error: String(e) })
      session.info.status = "exited"
      session.info.exitCode = -1
      const msg = `\r\n\x1b[90mError: Restart failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`
      session.buffer += msg
      session.cursor += msg.length
      session.info.cursor = session.cursor
      Bus.publish(Event.Output, { id, chunk: msg, cursor: session.cursor })
      Bus.publish(Event.Exited, { id, exitCode: -1 })
      return
    }

    // Update session with new process
    session.process = ptyProcess
    session.info.status = "running"
    session.info.pid = ptyProcess.pid
    session.info.exitCode = undefined

    // Append restart message to buffer
    const msg = "\r\n\x1b[90mProcess was restarted.\x1b[0m\r\n\r\n"
    session.buffer += msg
    session.cursor += msg.length
    session.info.cursor = session.cursor

    // Notify subscribers about restart message
    for (const [key, ws] of session.subscribers.entries()) {
      if (ws.readyState !== 1) {
        session.subscribers.delete(key)
        continue
      }
      if (ws.data !== key) {
        session.subscribers.delete(key)
        continue
      }
      try {
        ws.send(msg)
      } catch {
        session.subscribers.delete(key)
      }
    }

    Bus.publish(Event.Output, { id, chunk: msg, cursor: session.cursor })
    Bus.publish(Event.Updated, { info: session.info })

    // Set up new data/exit handlers
    ptyProcess.onData((chunk) => {
      session.cursor += chunk.length
      session.info.cursor = session.cursor

      for (const [key, ws] of session.subscribers.entries()) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(key)
          continue
        }
        if (ws.data !== key) {
          session.subscribers.delete(key)
          continue
        }
        try {
          ws.send(chunk)
        } catch {
          session.subscribers.delete(key)
        }
      }

      Bus.publish(Event.Output, { id, chunk, cursor: session.cursor })

      session.buffer += chunk
      if (session.buffer.length <= BUFFER_LIMIT) return
      const excess = session.buffer.length - BUFFER_LIMIT
      session.buffer = session.buffer.slice(excess)
      session.bufferCursor += excess
    })
    ptyProcess.onExit(({ exitCode }) => {
      log.info("session exited after restart", { id, exitCode })
      const wasKilled = session.info.status === "killed"
      if (!wasKilled) {
        session.info.status = "exited"
      }
      session.info.exitCode = exitCode

      const msg = wasKilled ? "" : `\r\n\x1b[90mProcess exited with code ${exitCode}.\x1b[0m\r\n`

      if (msg) {
        session.buffer += msg
        session.cursor += msg.length
        session.info.cursor = session.cursor

        for (const [key, ws] of session.subscribers.entries()) {
          if (ws.readyState !== 1) {
            session.subscribers.delete(key)
            continue
          }
          if (ws.data !== key) {
            session.subscribers.delete(key)
            continue
          }
          try {
            ws.send(msg)
          } catch {
            session.subscribers.delete(key)
          }
        }
        Bus.publish(Event.Output, { id, chunk: msg, cursor: session.cursor })
      }

      for (const [key, ws] of session.subscribers.entries()) {
        try {
          if (ws.data === key) ws.close()
        } catch {
          // ignore
        }
      }
      session.subscribers.clear()
      Bus.publish(Event.Exited, { id, exitCode })
    })
  }

  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("removing session", { id })
    try {
      session.process.kill()
    } catch {}
    for (const [key, ws] of session.subscribers.entries()) {
      try {
        if (ws.data === key) ws.close()
      } catch {
        // ignore
      }
    }
    session.subscribers.clear()
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: Socket, cursor?: number) {
    const session = state().get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })

    // Use ws.data as the unique key for this connection lifecycle.
    // If ws.data is undefined, fallback to ws object.
    const connectionKey = ws.data && typeof ws.data === "object" ? ws.data : ws

    // Optionally cleanup if the key somehow exists
    session.subscribers.delete(connectionKey)
    session.subscribers.set(connectionKey, ws)

    const cleanup = () => {
      session.subscribers.delete(connectionKey)
    }

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      return session.buffer.slice(offset)
    })()

    if (data) {
      try {
        for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
          ws.send(data.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        cleanup()
        ws.close()
        return
      }
    }

    try {
      ws.send(meta(end))
    } catch {
      cleanup()
      ws.close()
      return
    }
    return {
      onMessage: (message: string | ArrayBuffer) => {
        session.process.write(String(message))
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        cleanup()
      },
    }
  }
}

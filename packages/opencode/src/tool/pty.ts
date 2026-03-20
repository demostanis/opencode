import z from "zod"
import { Tool } from "./tool"
import { Pty } from "../pty"
import { PtyID } from "../pty/schema"
import { Instance } from "../project/instance"

export const PTYSpawnTool = Tool.define("pty_spawn", async () => {
  return {
    description:
      "Spawns a background process that continues to run even after the tool call returns. Useful for development servers, long builds, or any process you need to interact with over time. Provide a single command string; arguments should be included in the command itself.",
    parameters: z.object({
      command: z.string().describe("The shell command to execute, including any arguments"),
      cwd: z.string().describe("Working directory for the process").optional(),
      title: z.string().describe("Short title for the process (e.g. 'Dev Server')").optional(),
    }),
    async execute(params, ctx) {
      const patterns = [params.command]
      await ctx.ask({
        permission: "pty",
        patterns,
        always: patterns,
        metadata: {
          command: params.command,
          cwd: params.cwd || Instance.directory,
        },
      })

      const info = await Pty.create({
        command: params.command,
        cwd: params.cwd || Instance.directory,
        title: params.title,
        parentSessionID: ctx.sessionID,
      })

      return {
        title: `Spawned background process: ${info.title}`,
        metadata: { id: info.id, pid: info.pid, title: info.title, command: params.command },
        output: `Background process "${info.title}" spawned with ID: ${info.id} (PID: ${info.pid}).\nUse "pty_read" with this ID to see output.`,
      }
    },
  }
})

export const PTYReadTool = Tool.define("pty_read", async () => {
  return {
    description: "Reads the output of a background process.",
    parameters: z.object({
      id: z.string().describe("The ID of the background process (from 'pty_spawn')"),
    }),
    async execute(params, ctx) {
      const ptyId = params.id as PtyID
      const info = Pty.get(ptyId)
      if (!info || info.parentSessionID !== ctx.sessionID) {
        throw new Error(`Background process not found: ${params.id}`)
      }

      const { Pty: PtyInternal } = await import("../pty")
      const result = PtyInternal.read(ptyId)
      if (result === undefined) throw new Error(`Background process not found: ${params.id}`)

      return {
        title: `Read output from background process: ${info.title}`,
        metadata: { id: params.id, title: info.title },
        output: result,
      }
    },
  }
})

export const PTYWriteTool = Tool.define("pty_write", async () => {
  return {
    description:
      "Sends input (stdin) to a running background process. You can send text, newlines, and special keys. Use \\n or \\r for Enter. For special keys, use: {UP}, {DOWN}, {LEFT}, {RIGHT}, {ENTER}, {ESC}, {TAB}, {BACKSPACE}.",
    parameters: z.object({
      id: z.string().describe("The ID of the background process"),
      input: z
        .string()
        .describe("The text or keys to send. Newlines are sent as \\r. Special keys like {UP} are supported."),
    }),
    async execute(params, ctx) {
      const ptyId = params.id as PtyID
      const info = Pty.get(ptyId)
      if (!info || info.parentSessionID !== ctx.sessionID) {
        throw new Error(`Background process not found: ${params.id}`)
      }

      let raw = params.input
      const KEY_MAP: Record<string, string> = {
        "{UP}": "\x1b[A",
        "{DOWN}": "\x1b[B",
        "{RIGHT}": "\x1b[C",
        "{LEFT}": "\x1b[D",
        "{ENTER}": "\r",
        "{ESC}": "\x1b",
        "{TAB}": "\t",
        "{BACKSPACE}": "\x7f",
      }

      for (const [key, val] of Object.entries(KEY_MAP)) {
        raw = raw.replaceAll(key, val)
      }

      // Translate \n to \r as most TUIs expect CR for Enter
      raw = raw.replace(/\n/g, "\r")

      Pty.write(ptyId, raw)

      return {
        title: `Sent input to background process: ${info.title}`,
        metadata: { id: params.id, title: info.title, input: params.input },
        output: `Successfully sent input to background process "${info.title}".`,
      }
    },
  }
})

export const PTYKillTool = Tool.define("pty_kill", async () => {
  return {
    description: "Terminates a background process.",
    parameters: z.object({
      id: z.string().describe("The ID of the background process"),
    }),
    async execute(params, ctx) {
      const ptyId = params.id as PtyID
      const info = Pty.get(ptyId)
      if (!info || info.parentSessionID !== ctx.sessionID) {
        throw new Error(`Background process not found: ${params.id}`)
      }

      await Pty.kill(ptyId)

      return {
        title: `Killed background process: ${info.title}`,
        metadata: { id: params.id, title: info.title },
        output: `Successfully requested termination for background process "${info.title}"`,
      }
    },
  }
})

export const PTYListTool = Tool.define("pty_list", async () => {
  return {
    description: "Lists all active background processes and their statuses.",
    parameters: z.object({}),
    async execute(params, ctx) {
      const processes = Pty.list(ctx.sessionID)
      const output =
        processes.length === 0
          ? "No background processes running in this session."
          : processes.map((p) => `[${p.id}] ${p.status}: ${p.title} (PID: ${p.pid})`).join("\n")

      return {
        title: "List background processes",
        metadata: { processes },
        output,
      }
    },
  }
})

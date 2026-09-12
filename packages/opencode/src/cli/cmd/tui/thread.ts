import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/config/tui"
import { Instance } from "@/project/instance"
import { Owner } from "./owner"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    request.signal.throwIfAborted()
    const id = crypto.randomUUID()
    const pending = client.call("fetch", {
      id,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    const abort = () => void client.call("abort", { id }).catch(() => {})
    request.signal.addEventListener("abort", abort, { once: true })
    const result = await pending.finally(() => request.signal.removeEventListener("abort", abort))
    request.signal.throwIfAborted()
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
    setWorkspace: (workspaceID) => {
      void client.call("setWorkspace", { workspaceID })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("none", {
        type: "boolean",
        describe: "set auto-accept to none",
      })
      .option("edit", {
        type: "boolean",
        describe: "set auto-accept to edit",
      })
      .option("yolo", {
        type: "boolean",
        describe: "set auto-accept to yolo",
      })
      .option("autoreject", {
        type: "boolean",
        describe: "set auto-accept to autoreject",
      })
      .option("autoaccept", {
        type: "string",
        describe: "set auto-accept mode",
        choices: ["none", "edit", "yolo", "autoreject"] as const,
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    let owner: Awaited<ReturnType<typeof Owner.create>> | undefined
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const next = args.project
        ? Filesystem.resolve(path.isAbsolute(args.project) ? args.project : path.join(root, args.project))
        : Filesystem.resolve(process.cwd())
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      const prompt = await input(args.prompt)
      const config = await Instance.provide({
        directory: cwd,
        fn: () => TuiConfig.get(),
      })
      const network = await resolveNetworkOptions(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"
      const opts = {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        fork: args.fork,
        autoaccept: (() => {
          if (args.none) return "none" as const
          if (args.edit) return "edit" as const
          if (args.yolo) return "yolo" as const
          if (args.autoreject) return "autoreject" as const
          if (args.autoaccept) return args.autoaccept
          return undefined
        })(),
      }
      const file = await target()
      const current = await Owner.create({ dir: cwd })
      owner = current
      const worker = new Worker(file, {
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      })
      worker.onerror = (e) => {
        Log.Default.error(e)
        owner?.release().catch(() => {})
      }

      const client = Rpc.client<typeof rpc>(worker)
      const off = client.on<{
        directory: string
        payload: {
          type: string
          properties?: {
            sessionID?: string
            status?: { type: string }
          }
        }
      }>("global.event", (event) => {
        if (event.payload.type !== "session.status") return
        const sessionID = event.payload.properties?.sessionID
        const status = event.payload.properties?.status
        if (!sessionID || !status) return
        current.active(sessionID, event.directory, status.type !== "idle")
      })
      const error = (e: unknown) => {
        Log.Default.error(e)
      }
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        off()
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        worker.terminate()
      }

      try {
        const shared = await client.call("share", { password: current.info.password })
        await current.ready(shared.url)
        const transport = external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined,
              events: undefined,
            }
          : {
              url: "http://opencode.internal",
              fetch: createWorkerFetch(client),
              events: createEventSource(client),
            }

        setTimeout(() => {
          client.call("checkUpgrade", { directory: cwd }).catch(() => {})
        }, 1000).unref?.()

        await tui({
          url: transport.url,
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          owner: { ...current.info, url: shared.url },
          args: opts,
        })
      } finally {
        await stop()
      }
    } finally {
      await owner?.release()
      unguard?.()
    }
    process.exit(0)
  },
})

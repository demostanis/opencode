import { cmd } from "../cmd"
import { UI } from "@/cli/ui"
import { tui } from "./app"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/config/tui"
import { Instance } from "@/project/instance"
import { existsSync } from "fs"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
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
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
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
    const unguard = win32InstallCtrlCGuard()
    try {
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      const directory = (() => {
        if (!args.dir) return undefined
        try {
          process.chdir(args.dir)
          return process.cwd()
        } catch {
          // If the directory doesn't exist locally (remote attach), pass it through.
          return args.dir
        }
      })()
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const config = await Instance.provide({
        directory: directory && existsSync(directory) ? directory : process.cwd(),
        fn: () => TuiConfig.get(),
      })
      await tui({
        url: args.url,
        config,
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
          autoaccept: (() => {
            if (args.none) return "none"
            if (args.edit) return "edit"
            if (args.yolo) return "yolo"
            if (args.autoreject) return "autoreject"
            if (args.autoaccept) return args.autoaccept as any
            return undefined
          })(),
        },
        directory,
        headers,
      })
    } finally {
      unguard?.()
    }
  },
})

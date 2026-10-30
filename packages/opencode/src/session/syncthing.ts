import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Process } from "@/util/process"
import { root } from "./sync-path"

export namespace Syncthing {
  export const Status = z
    .object({
      state: z.enum(["disabled", "enabled", "syncing", "error", "unavailable"]),
      detail: z.string().optional(),
      disconnected: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .meta({ ref: "SyncthingStatus" })
  export type Status = z.infer<typeof Status>

  const Folder = z.object({
    id: z.string(),
    path: z.string(),
    paused: z.boolean(),
    devices: z.array(z.object({ deviceID: z.string() })),
  })
  const Config = z.object({
    folders: z.array(Folder),
    devices: z.array(z.object({ deviceID: z.string(), name: z.string(), paused: z.boolean() })),
    gui: z.object({ address: z.string(), apiKey: z.string(), useTLS: z.boolean() }),
  })
  const Model = z.object({
    state: z.string(),
    error: z.string().optional(),
    pullErrors: z.number(),
    needTotalItems: z.number(),
    needBytes: z.number(),
  })
  const Completion = z.object({
    needItems: z.number(),
    needDeletes: z.number(),
    needBytes: z.number(),
    remoteState: z.string(),
  })
  const Connections = z.object({
    connections: z.record(z.string(), z.object({ connected: z.boolean(), paused: z.boolean().optional() })),
  })

  export function aggregate(input: {
    folder: z.infer<typeof Folder>
    devices: z.infer<typeof Config>["devices"]
    self: string
    connections: z.infer<typeof Connections>["connections"]
    model: z.infer<typeof Model>
    completion: Record<string, z.infer<typeof Completion>>
  }): Status {
    const peers = input.folder.devices
      .filter((item) => item.deviceID !== input.self)
      .map((item) => ({
        id: item.deviceID,
        name: input.devices.find((device) => device.deviceID === item.deviceID)?.name || item.deviceID.slice(0, 7),
      }))
    const disconnected = peers.filter((peer) => !input.connections[peer.id]?.connected)
    const result = (state: Status["state"], detail?: string): Status => ({ state, detail, disconnected })
    if (input.folder.paused) return result("error", "Sync folder paused")
    if (input.model.state === "error" || input.model.error || input.model.pullErrors > 0)
      return result("error", "Sync folder errors")
    if (disconnected.length) return result("error", "Shared peers disconnected")
    if (
      peers.some(
        (peer) =>
          input.connections[peer.id]?.paused ||
          input.devices.find((device) => device.deviceID === peer.id)?.paused ||
          ["paused", "notSharing"].includes(input.completion[peer.id]?.remoteState),
      )
    )
      return result("error", "Peer paused or not sharing")
    if (
      input.model.needTotalItems > 0 ||
      input.model.needBytes > 0 ||
      ["syncing", "sync-preparing", "sync-waiting", "scanning", "scan-waiting"].includes(input.model.state) ||
      peers.some((peer) => {
        const value = input.completion[peer.id]
        return value && (value.needItems > 0 || value.needDeletes > 0 || value.needBytes > 0)
      })
    )
      return result("syncing")
    if (input.model.state !== "idle" || peers.some((peer) => input.completion[peer.id]?.remoteState !== "valid"))
      return result("unavailable", "Waiting for folder status")
    return result("enabled")
  }

  type Options = {
    enabled?: boolean
    root?: string
    home?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  }

  // Resolve symlinks before comparing boundaries: a parent folder may contain the export root.
  export async function folder(folders: z.infer<typeof Folder>[], target: string, home: string) {
    const resolve = (value: string) => fs.realpath(value).catch(() => path.resolve(value))
    const dir = await resolve(target)
    const matches = await Promise.all(
      folders.map(async (item) => {
        const expanded = item.path === "~" ? home : item.path.replace(/^~[/\\]/, `${home}${path.sep}`)
        if (!path.isAbsolute(expanded)) return
        const base = await resolve(expanded)
        const relative = path.relative(base, dir)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
        return { item, base }
      }),
    )
    return matches.filter((item) => item !== undefined).sort((a, b) => b.base.length - a.base.length)[0]?.item
  }

  export function read(opts: Options = {}): Promise<Status> {
    return inspect(opts).catch(() => ({ state: "error", detail: "Syncthing unavailable", disconnected: [] }))
  }

  async function inspect(opts: Options): Promise<Status> {
    const disabled: Status = { state: "disabled", disconnected: [] }
    if (opts.enabled === false) return disabled
    const home = opts.home ?? Global.Path.home
    const env = opts.env ?? process.env
    const dirs =
      env.STCONFDIR || env.STHOMEDIR
        ? [env.STCONFDIR || env.STHOMEDIR!]
        : [
            path.join(env.XDG_STATE_HOME || path.join(home, ".local/state"), "syncthing"),
            path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "syncthing"),
          ]
    const configs = await Promise.all(
      dirs.map(async (dir) => ((await Bun.file(path.join(dir, "config.xml")).exists()) ? dir : undefined)),
    )
    const dir = configs.find((item) => item !== undefined)
    if (!dir) return disabled
    const signal = AbortSignal.timeout(opts.timeout ?? 5_000)
    // The CLI reads credentials itself. Never log its output or propagate its errors to clients.
    const dump = await Process.run(["syncthing", "cli", `--home=${dir}`, "config", "dump-json"], {
      env: { ...env, STCONFDIR: undefined, STDATADIR: undefined, STHOMEDIR: undefined },
      abort: signal,
      kill: "SIGKILL",
    })
    const config = Config.parse(JSON.parse(dump.stdout.toString()))
    const selected = await folder(config.folders, opts.root ?? root, home)
    if (!selected) return disabled
    const address = env.STGUIADDRESS || config.gui.address
    const url = new URL(address.includes("://") ? address : `${config.gui.useTLS ? "https" : "http"}://${address}`)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported GUI address")
    if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "localhost"
    const get = async (route: string, query?: Record<string, string>) => {
      const target = new URL(`rest/${route}`, `${url.href.replace(/\/$/, "")}/`)
      target.search = new URLSearchParams(query).toString()
      const response = await fetch(target, {
        signal,
        redirect: "error",
        headers: { "X-API-Key": env.STGUIAPIKEY || config.gui.apiKey },
      })
      if (!response.ok) throw new Error("Syncthing request failed")
      return response.json()
    }
    const [system, connections, model] = await Promise.all([
      get("system/status").then((value) => z.object({ myID: z.string().min(1) }).parse(value)),
      get("system/connections").then((value) => Connections.parse(value)),
      get("db/status", { folder: selected.id }).then((value) => Model.parse(value)),
    ])
    const completion = await Promise.all(
      selected.devices
        .filter((item) => item.deviceID !== system.myID && connections.connections[item.deviceID]?.connected)
        .map(
          async (item) =>
            [
              item.deviceID,
              Completion.parse(await get("db/completion", { folder: selected.id, device: item.deviceID })),
            ] as const,
        ),
    )
    const status = aggregate({
      folder: selected,
      devices: config.devices,
      self: system.myID,
      connections: connections.connections,
      model,
      completion: Object.fromEntries(completion),
    })
    const base = selected.path === "~" ? home : selected.path.replace(/^~[/\\]/, `${home}${path.sep}`)
    if (!(await fs.stat(base).catch(() => undefined))?.isDirectory())
      return { ...status, state: "error", detail: "Sync folder missing" }
    return status
  }

  export function reader(opts: Options = {}) {
    let pending: Promise<Status> | undefined
    let time = 0
    return () => {
      if (pending && Date.now() - time < 10_000) return pending
      time = Date.now()
      pending = read(opts)
      return pending
    }
  }
}

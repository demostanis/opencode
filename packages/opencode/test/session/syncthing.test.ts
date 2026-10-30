import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Syncthing } from "../../src/session/syncthing"
import { tmpdir } from "../fixture/fixture"
import { Process } from "../../src/util/process"

const self = "DOVII4U-SQEEESM-VZ2CVTC-CJM4YN5-QNV7DCU-5U3ASRL-YVFG6TH-W5DV5AA"
const peer = "UYGDMA4-TPHOFO5-2VQYDCC-7CWX7XW-INZINQT-LE4B42N-4JUZTSM-IWCSXA4"
const fixture = () => ({
  folder: { id: "exports", path: "/exports", paused: false, devices: [{ deviceID: self }, { deviceID: peer }] },
  devices: [
    { deviceID: self, name: "local", paused: false },
    { deviceID: peer, name: "laptop", paused: false },
  ],
  self,
  connections: { [peer]: { connected: true, paused: false } },
  model: { state: "idle", pullErrors: 0, needTotalItems: 0, needBytes: 0, error: "" },
  completion: { [peer]: { remoteState: "valid", needItems: 0, needDeletes: 0, needBytes: 0 } },
})

describe("Syncthing aggregation", () => {
  test("idle connected peers are enabled", () => {
    expect(Syncthing.aggregate(fixture())).toEqual({ state: "enabled", disconnected: [], detail: undefined })
  })

  test.each(["needTotalItems", "needBytes"] as const)("local %s is syncing", (field) => {
    const input = fixture()
    input.model[field] = 1
    expect(Syncthing.aggregate(input).state).toBe("syncing")
  })

  test.each(["needItems", "needDeletes", "needBytes"] as const)("remote %s is syncing", (field) => {
    const input = fixture()
    input.completion[peer][field] = 1
    expect(Syncthing.aggregate(input).state).toBe("syncing")
  })

  test.each(["syncing", "sync-preparing", "sync-waiting", "scanning", "scan-waiting"])(
    "active folder %s is syncing",
    (state) => {
      const input = fixture()
      input.model.state = state
      expect(Syncthing.aggregate(input).state).toBe("syncing")
    },
  )

  test("only disconnected shared peers are listed, excluding self", () => {
    const input = fixture()
    input.connections[peer].connected = false
    input.model.needTotalItems = 1
    const status = Syncthing.aggregate(input)
    expect(status.state).toBe("error")
    expect(status.disconnected).toEqual([{ id: peer, name: "laptop" }])
  })

  test("missing connection is disconnected with ID fallback", () => {
    const input = fixture()
    Reflect.deleteProperty(input.connections, peer)
    input.devices = []
    expect(Syncthing.aggregate(input).disconnected).toEqual([{ id: peer, name: peer.slice(0, 7) }])
  })

  test("unrelated disconnected devices do not affect the export folder", () => {
    const input: Parameters<typeof Syncthing.aggregate>[0] = fixture()
    input.connections.other = { connected: false }
    input.devices.push({ deviceID: "other", name: "unrelated", paused: true })
    expect(Syncthing.aggregate(input).state).toBe("enabled")
    input.devices[1].paused = true
    expect(Syncthing.aggregate(input).state).toBe("error")
  })

  test.each(["paused", "pullErrors", "error", "state"])("folder %s is an error", (field) => {
    const input = fixture()
    if (field === "paused") input.folder.paused = true
    if (field === "pullErrors") input.model.pullErrors = 1
    if (field === "error") input.model.error = "folder marker missing"
    if (field === "state") input.model.state = "error"
    expect(Syncthing.aggregate(input).state).toBe("error")
  })

  test.each(["paused", "notSharing"])("remote %s is an error", (state) => {
    const input = fixture()
    input.completion[peer].remoteState = state
    expect(Syncthing.aggregate(input).state).toBe("error")
  })

  test("unknown remote index or folder state is not healthy", () => {
    const input = fixture()
    input.completion[peer].remoteState = "unknown"
    expect(Syncthing.aggregate(input).state).toBe("unavailable")
    input.completion[peer].remoteState = "valid"
    input.model.state = "unknown"
    expect(Syncthing.aggregate(input).state).toBe("unavailable")
  })
})

test("folder selection uses the nearest containing path, boundaries, home expansion and symlinks", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, "sync")
  await fs.mkdir(dir)
  await fs.symlink(dir, path.join(tmp.path, "link"))
  const folders = [
    { ...fixture().folder, id: "unrelated", path: `${dir}-other` },
    { ...fixture().folder, id: "parent", path: tmp.path },
    { ...fixture().folder, id: "matching", path: "~/link" },
  ]
  expect((await Syncthing.folder(folders, path.join(dir, "exports"), tmp.path))?.id).toBe("matching")
  expect(await Syncthing.folder(folders.slice(0, 1), dir, tmp.path)).toBeUndefined()
})

test("session sync off and absent Syncthing config are disabled without invoking the CLI", async () => {
  await using tmp = await tmpdir()
  const env = { PATH: "", STCONFDIR: tmp.path }
  expect((await Syncthing.read({ env })).state).toBe("disabled")
  await Bun.write(path.join(tmp.path, "config.xml"), "<configuration/>")
  expect((await Syncthing.read({ enabled: false, env })).state).toBe("disabled")
})

describe.skipIf(!Bun.which("syncthing"))("Syncthing CLI and REST integration", () => {
  async function setup() {
    const tmp = await tmpdir()
    const input = fixture()
    input.folder.path = tmp.path
    const requests: string[] = []
    const state = { folders: [input.folder], fail: "", malformed: false, delay: "" }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        const route = url.pathname.replace("/rest/system/config", "/rest/config")
        requests.push(route + url.search)
        if (request.headers.get("x-api-key") !== "private-key") return new Response(null, { status: 403 })
        if (route === state.delay) await Bun.sleep(500)
        if (route === state.fail) return new Response("private-key", { status: 500 })
        if (route === "/rest/config")
          return Response.json({
            folders: state.folders,
            devices: input.devices,
            gui: { address: `127.0.0.1:${server.port}`, apiKey: "private-key", useTLS: false },
          })
        if (url.pathname === "/rest/system/status")
          return Response.json({
            myID: self,
            connectionServiceStatus: { "relay://[::1]": { error: "IPv6 unavailable" } },
          })
        if (url.pathname === "/rest/system/connections") return Response.json({ connections: input.connections })
        if (url.searchParams.get("folder") !== "exports") return new Response(null, { status: 400 })
        if (url.pathname === "/rest/db/status") return Response.json(state.malformed ? {} : input.model)
        if (url.pathname === "/rest/db/completion") {
          expect(url.searchParams.get("device")).toBe(peer)
          return Response.json(input.completion[peer])
        }
        return new Response(null, { status: 404 })
      },
    })
    await Bun.write(
      path.join(tmp.path, "config.xml"),
      `<configuration version="37"><gui enabled="true" tls="false"><address>127.0.0.1:${server.port}</address><apikey>private-key</apikey></gui></configuration>`,
    )
    const opts = {
      root: tmp.path,
      env: {
        ...process.env,
        STCONFDIR: tmp.path,
        STHOMEDIR: undefined,
        STGUIADDRESS: `http://127.0.0.1:${server.port}`,
        STGUIAPIKEY: "private-key",
      },
    }
    return {
      input,
      requests,
      state,
      opts,
      async [Symbol.asyncDispose]() {
        await server.stop(true)
        await tmp[Symbol.asyncDispose]()
      },
    }
  }

  test("healthy direct connection ignores relay warnings and queries only the export folder", async () => {
    await using ctx = await setup()
    ctx.state.folders.push({ ...ctx.input.folder, id: "other", path: "/unrelated", paused: true })
    const status = await Syncthing.read(ctx.opts)
    expect(status).toEqual({ state: "enabled", disconnected: [], detail: undefined })
    expect(ctx.requests).toContain(`/rest/db/completion?folder=exports&device=${peer}`)
    expect(JSON.stringify(status)).not.toContain("private-key")
  })

  test("no matching configured folder is disabled", async () => {
    await using ctx = await setup()
    ctx.state.folders = [{ ...ctx.input.folder, path: "/unrelated" }]
    expect((await Syncthing.read(ctx.opts)).state).toBe("disabled")
    expect(ctx.requests.length).toBeGreaterThan(0)
    expect(ctx.requests.every((route) => route === "/rest/config")).toBe(true)
  })

  test("remote backlog and disconnected peers reach the server status", async () => {
    await using ctx = await setup()
    ctx.input.completion[peer].needItems = 1
    expect((await Syncthing.read(ctx.opts)).state).toBe("syncing")
    ctx.input.connections[peer].connected = false
    const status = await Syncthing.read(ctx.opts)
    expect(status.state).toBe("error")
    expect(status.disconnected).toEqual([{ id: peer, name: "laptop" }])
  })

  test.each(["/rest/config", "/rest/db/status", "/rest/db/completion", "/rest/system/connections"])(
    "%s failure is sanitized",
    async (route) => {
      await using ctx = await setup()
      ctx.state.fail = route
      expect(await Syncthing.read(ctx.opts)).toEqual({
        state: "error",
        detail: "Syncthing unavailable",
        disconnected: [],
      })
    },
  )

  test("malformed responses cannot become healthy", async () => {
    await using ctx = await setup()
    ctx.state.malformed = true
    expect((await Syncthing.read(ctx.opts)).state).toBe("error")
  })

  test("configured daemon failure and stalled requests are bounded", async () => {
    await using ctx = await setup()
    const address = ctx.opts.env.STGUIADDRESS
    ctx.opts.env.STGUIADDRESS = "http://127.0.0.1:1"
    expect((await Syncthing.read({ ...ctx.opts, timeout: 100 })).state).toBe("error")
    ctx.opts.env.STGUIADDRESS = address
    const start = performance.now()
    ctx.state.delay = "/rest/config"
    expect((await Syncthing.read({ ...ctx.opts, timeout: 50 })).state).toBe("error")
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test("stalled REST calls time out after configuration is loaded", async () => {
    await using ctx = await setup()
    ctx.state.delay = "/rest/db/status"
    const start = performance.now()
    expect((await Syncthing.read({ ...ctx.opts, timeout: 150 })).state).toBe("error")
    expect(ctx.requests).toContain("/rest/db/status?folder=exports")
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test.each(["XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const)(
    "CLI reads credentials from %s without returning them",
    async (field) => {
      await using ctx = await setup()
      const state = path.join(ctx.opts.root, "state")
      await fs.mkdir(path.join(state, "syncthing"), { recursive: true })
      await Process.run(["syncthing", "generate", `--home=${path.join(state, "syncthing")}`], {
        env: { ...ctx.opts.env, STCONFDIR: undefined, STDATADIR: undefined, STHOMEDIR: undefined },
        abort: AbortSignal.timeout(5_000),
        kill: "SIGKILL",
      })
      await fs.rename(path.join(ctx.opts.root, "config.xml"), path.join(state, "syncthing", "config.xml"))
      const status = await Syncthing.read({
        ...ctx.opts,
        env: {
          ...ctx.opts.env,
          STCONFDIR: undefined,
          STGUIADDRESS: undefined,
          STGUIAPIKEY: undefined,
          XDG_STATE_HOME: path.join(ctx.opts.root, "absent"),
          XDG_CONFIG_HOME: path.join(ctx.opts.root, "absent"),
          [field]: state,
        },
      })
      expect(status.state).toBe("enabled")
      expect(JSON.stringify(status)).not.toContain("private-key")
    },
  )

  test("paused, missing and erroring export folders are errors", async () => {
    await using ctx = await setup()
    ctx.input.folder.paused = true
    expect((await Syncthing.read(ctx.opts)).detail).toBe("Sync folder paused")
    ctx.input.folder.paused = false
    ctx.input.model.pullErrors = 1
    expect((await Syncthing.read(ctx.opts)).detail).toBe("Sync folder errors")
    ctx.input.model.pullErrors = 0
    ctx.input.folder.path = path.join(ctx.opts.root, "missing")
    expect((await Syncthing.read({ ...ctx.opts, root: ctx.input.folder.path })).detail).toBe("Sync folder missing")
  })

  test("reader coalesces concurrent polls", async () => {
    await using ctx = await setup()
    const read = Syncthing.reader(ctx.opts)
    const first = read()
    expect(read()).toBe(first)
    expect((await first).state).toBe("enabled")
    expect(read()).toBe(first)
    expect(ctx.requests.filter((route) => route === "/rest/db/status?folder=exports")).toHaveLength(1)
  })
})

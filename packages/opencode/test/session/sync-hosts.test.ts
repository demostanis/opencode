import { test, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

type Reply = { id: number; data?: unknown; error?: string }
type Request = { action: string; directory?: string; session?: string; text?: string; machine?: string }
type View = {
  sync?: { local_id: string }
  row: { id: string; title: string; directory: string; project: string } | null
  messages?: { id: string; role: string; parent?: string }[]
  parts?: { message: string; data: { type: string; text?: string; synthetic?: boolean } }[]
  path?: string
}

test("two independent hosts exchange revisions without overwriting divergent histories", async () => {
  await using tmp = await tmpdir({ git: true })
  const source = tmp.path
  const target = path.join(tmp.path, "target-checkout")
  await $`git clone --quiet ${source} ${target}`.quiet()
  await Promise.all([
    fs.mkdir(path.join(source, "packages/api"), { recursive: true }),
    fs.mkdir(path.join(target, "packages/api"), { recursive: true }),
  ])
  const shared = path.join(tmp.path, "syncthing")
  await fs.mkdir(shared)

  const host = async (name: string) => {
    const home = path.join(tmp.path, name)
    await fs.mkdir(path.join(home, ".local/share"), { recursive: true })
    await fs.symlink(shared, path.join(home, ".local/share/opencode-sync"))
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "sync-worker.ts")], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      },
      stdout: "ignore",
      stderr: "inherit",
      ipc(message) {
        const reply = message as Reply
        const task = pending.get(reply.id)
        if (!task) return
        pending.delete(reply.id)
        if (reply.error) task.reject(new Error(reply.error))
        else task.resolve(reply.data)
      },
    })
    let id = 0
    return {
      ask<T>(input: Request) {
        return new Promise<T>((resolve, reject) => {
          const key = ++id
          pending.set(key, { resolve: (value) => resolve(value as T), reject })
          child.send({ ...input, id: key })
        })
      },
      async stop() {
        child.kill()
        await child.exited
      },
    }
  }

  const a = await host("host-a")
  const b = await host("host-b")
  try {
    const origin = await a.ask<{ id: string; project: string; machine: string; path: string }>({
      action: "seed",
      directory: path.join(source, "packages/api"),
    })
    expect(await b.ask<string>({ action: "project", directory: path.join(target, "packages/api") })).toBe(
      origin.project,
    )
    await b.ask({ action: "scan" })
    const first = await b.ask<View>({ action: "inspect", session: origin.id, machine: origin.machine })
    expect(first.path).not.toBe(origin.path)
    expect(await fs.stat(first.path!)).toBeDefined()
    expect(await fs.stat(origin.path)).toBeDefined()
    expect(first.row?.id).not.toBe(origin.id)
    expect(first.row?.directory).toBe(path.join(target, "packages/api"))
    expect(first.row?.project).toBe(origin.project)
    expect(first.messages?.map((msg) => msg.role)).toEqual(["user", "assistant"])
    expect(first.messages?.[1].parent).toBe(first.messages?.[0].id)
    expect(first.parts?.map((part) => part.data.text)).toContain("origin history")
    expect(first.parts?.map((part) => part.data.text)).toContain("origin answer")
    expect(first.parts?.every((part) => first.messages?.some((msg) => msg.id === part.message))).toBe(true)
    expect(
      first.parts?.some(
        (part) => part.data.text?.includes("Conversation transferred from another host") && !part.data.synthetic,
      ),
    ).toBe(true)
    await b.ask({ action: "scan" })
    expect((await b.ask<View>({ action: "inspect", session: origin.id, machine: origin.machine })).sync?.local_id).toBe(
      first.row?.id,
    )
    await b.ask({ action: "export", session: first.row!.id })
    const destination = await b.ask<{ machine: string; path: string }>({ action: "identity" })
    expect(destination.machine).not.toBe(origin.machine)
    expect(
      await fs.stat(path.join(shared, "sessions", destination.machine, first.row!.id)).catch(() => undefined),
    ).toBeUndefined()

    await a.ask({ action: "edit", session: origin.id, text: "Source revision two" })
    await a.ask({ action: "export", session: origin.id })
    await b.ask({ action: "scan" })
    const second = await b.ask<View>({ action: "inspect", session: origin.id, machine: origin.machine })
    expect(second.row?.id).toBe(first.row?.id)
    expect(second.row?.title).toContain("Source revision two")

    await b.ask({ action: "edit", session: second.row!.id, text: "Destination local edit" })
    await a.ask({ action: "edit", session: origin.id, text: "Source revision three" })
    await a.ask({ action: "export", session: origin.id })
    await b.ask({ action: "scan" })
    const branch = await b.ask<View>({ action: "inspect", session: origin.id, machine: origin.machine })
    const edited = await b.ask<View>({ action: "inspect", session: second.row!.id })
    const original = await a.ask<View>({ action: "inspect", session: origin.id })
    expect(branch.row?.id).not.toBe(second.row?.id)
    expect(branch.row?.title).toContain("Source revision three")
    expect(branch.parts?.some((part) => part.data.text === "origin answer")).toBe(true)
    expect(branch.parts?.every((part) => branch.messages?.some((msg) => msg.id === part.message))).toBe(true)
    expect(edited.row?.title).toBe("Destination local edit")
    expect(edited.parts?.some((part) => part.data.text === "origin answer")).toBe(true)
    expect(original.row?.id).toBe(origin.id)
    expect(original.row?.title).toBe("Source revision three")
    expect(original.parts?.some((part) => part.data.text?.includes("transferred from another host"))).toBe(false)
  } finally {
    await Promise.all([a.stop(), b.stop()])
  }
})

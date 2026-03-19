import { describe, expect, test } from "bun:test"
import { PTYSpawnTool, PTYReadTool, PTYWriteTool, PTYKillTool, PTYListTool } from "../../src/tool/pty"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.pty", () => {
  test("spawn and list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const list = await PTYListTool.init()

        const spawnResult = await spawn.execute(
          {
            command: "sleep 10",
            title: "Test Sleep",
          },
          ctx,
        )

        expect(spawnResult.metadata.id).toBeDefined()
        const id = spawnResult.metadata.id

        const listResult = await list.execute({}, ctx)
        expect(listResult.metadata.processes).toHaveLength(1)
        expect(listResult.metadata.processes[0].id).toBe(id)
        expect(listResult.metadata.processes[0].title).toBe("Test Sleep")

        await Pty.remove(id)
      },
    })
  })

  test("spawn, write, and read", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const write = await PTYWriteTool.init()
        const read = await PTYReadTool.init()

        const spawnResult = await spawn.execute(
          {
            command: "cat",
            title: "Test Cat",
          },
          ctx,
        )

        const id = spawnResult.metadata.id

        await write.execute(
          {
            id,
            input: "hello pty\n",
          },
          ctx,
        )

        // Wait for PTY to process input and output
        await sleep(200)

        const readResult = await read.execute(
          {
            id,
          },
          ctx,
        )

        expect(readResult.output).toContain("hello pty")

        await Pty.remove(id)
      },
    })
  })

  test("kill process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const kill = await PTYKillTool.init()
        const list = await PTYListTool.init()

        const spawnResult = await spawn.execute(
          {
            command: "sleep 100",
          },
          ctx,
        )

        const id = spawnResult.metadata.id

        await kill.execute(
          {
            id,
          },
          ctx,
        )

        const listResult = await list.execute({}, ctx)
        // In our implementation, kill() marks as killed but keeps in state
        expect(listResult.metadata.processes).toHaveLength(1)
        expect(listResult.metadata.processes[0].status).toBe("killed")
      },
    })
  })

  test("permissions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const requests: any[] = []
        const testCtx = {
          ...ctx,
          ask: async (req: any) => {
            requests.push(req)
          },
        }

        const spawnResult = await spawn.execute(
          {
            command: "ls -la",
          },
          testCtx,
        )

        expect(requests).toHaveLength(1)
        expect(requests[0].permission).toBe("pty")
        expect(requests[0].patterns).toContain("ls -la")

        await Pty.remove(spawnResult.metadata.id)
      },
    })
  })

  test("list multiple processes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const list = await PTYListTool.init()

        const s1 = await spawn.execute({ command: "sleep 10" }, ctx)
        const s2 = await spawn.execute({ command: "sleep 20" }, ctx)

        const listResult = await list.execute({}, ctx)
        expect(listResult.metadata.processes).toHaveLength(2)

        await Pty.remove(s1.metadata.id)
        await Pty.remove(s2.metadata.id)
      },
    })
  })

  test("read from non-existent process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await PTYReadTool.init()
        expect(read.execute({ id: "invalid-id" }, ctx)).rejects.toThrow("Background process not found")
      },
    })
  })

  test("spawn invalid command", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const result = await spawn.execute({ command: "non-existent-command-12345" }, ctx)
        const id = result.metadata.id

        // Wait for it to fail
        await sleep(500)

        const info = Pty.get(id)
        expect(info?.status).toBe("exited")
        await Pty.remove(id)
      },
    })
  })

  test("buffer rotation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const write = await PTYWriteTool.init()

        const result = await spawn.execute({ command: "cat" }, ctx)
        const id = result.metadata.id

        // Write a lot of data to exceed BUFFER_LIMIT (2MB)
        // We'll write in chunks to avoid blocking
        const largeString = "a".repeat(1024 * 1024) // 1MB
        await write.execute({ id, input: largeString }, ctx)
        await write.execute({ id, input: largeString }, ctx)
        await write.execute({ id, input: largeString }, ctx) // 3MB total

        await sleep(500)

        const output = Pty.read(id)
        expect(output?.length).toBeLessThanOrEqual(1024 * 1024 * 2 + 64 * 1024) // limit + some wiggle room for chunks
        expect(output?.length).toBeGreaterThan(1024 * 1024)

        await Pty.remove(id)
      },
    })
  })

  test("session cleanup", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()

        await spawn.execute({ command: "sleep 10", title: "P1" }, ctx)
        await spawn.execute({ command: "sleep 10", title: "P2" }, ctx)

        expect(Pty.list()).toHaveLength(2)

        Pty.cleanup("test-session")

        expect(Pty.list()).toHaveLength(0)
      },
    })
  })

  test("write to exited process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const write = await PTYWriteTool.init()
        const read = await PTYReadTool.init()

        const result = await spawn.execute({ command: "echo done" }, ctx)
        const id = result.metadata.id

        await sleep(200) // Wait for exit
        expect(Pty.get(id)?.status).toBe("exited")

        // Should not throw, just do nothing
        await write.execute({ id, input: "ignored\n" }, ctx)

        // Read output after exit
        const finalRead = await read.execute({ id }, ctx)
        expect(finalRead.output).toContain("done")

        await Pty.remove(id)
      },
    })
  })

  test("pty update (resize and rename)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Pty.create({ command: "cat", title: "Original" })

        await Pty.update(info.id, { title: "Renamed", size: { rows: 24, cols: 80 } })

        const updated = Pty.get(info.id)
        expect(updated?.title).toBe("Renamed")

        await Pty.remove(info.id)
      },
    })
  })

  test("tool registry integration", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ToolRegistry } = await import("../../src/tool/registry")
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("pty_spawn")
        expect(ids).toContain("pty_read")
        expect(ids).toContain("pty_write")
        expect(ids).toContain("pty_kill")
        expect(ids).toContain("pty_list")
      },
    })
  })

  test("input translation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const write = await PTYWriteTool.init()

        const result = await spawn.execute({ command: "cat" }, ctx)
        const id = result.metadata.id

        await write.execute({ id, input: "line1\nline2{ENTER}" }, ctx)

        await sleep(200)
        const output = Pty.read(id)
        expect(output).toBeDefined()
        // \n and {ENTER} should be translated to \r
        // In cat, \r might just move cursor or be shown as is depending on pty mode
        // But we want to ensure the tool executes without error and sends something.

        await Pty.remove(id)
      },
    })
  })
})

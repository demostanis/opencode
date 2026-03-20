import { describe, expect, test } from "bun:test"
import { PTYSpawnTool, PTYKillTool } from "../../src/tool/pty"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

const ctx: any = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("pty restart", () => {
  test("restarting a running process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const result = await spawn.execute({ command: "sleep 10" }, ctx)
        const id = result.metadata.id

        await sleep(100)

        expect(Pty.get(id)?.status).toBe("running")

        await Pty.restart(id)

        await sleep(100)

        // This is where it probably fails!
        expect(Pty.get(id)?.status).toBe("running")
      },
    })
  })

  test("restarting a killed process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawn = await PTYSpawnTool.init()
        const result = await spawn.execute({ command: "sleep 10" }, ctx)
        const id = result.metadata.id

        await sleep(100)
        await Pty.kill(id)
        await sleep(100)

        expect(Pty.get(id)?.status).toBe("killed")

        await Pty.restart(id)

        await sleep(100)

        expect(Pty.get(id)?.status).toBe("running")
      },
    })
  })
})

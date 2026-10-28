import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { CompactTool } from "../../src/tool/compact"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

describe("tool.compact", () => {
  test("is built in with no arguments and explicit-user-only guidance", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).toContain("compact")
        const tool = await CompactTool.init()
        expect(Object.keys(tool.parameters.shape)).toEqual([])
        expect(tool.parameters.parse({})).toEqual({})
        expect(tool.description).toContain("ONLY when the user explicitly asks")
        expect(tool.description).toContain("Never call it proactively")
        expect(tool.description).toContain("without other tools in parallel")
        expect(tool.description).toContain("do not compact again for the same request")
      },
    })
  })

  test("rejects an already cancelled execution", async () => {
    const tool = await CompactTool.init()
    const error = new Error("Compaction cancelled")
    await expect(
      tool.execute(
        {},
        {
          sessionID: SessionID.make("ses_test-session"),
          messageID: MessageID.make("test-message"),
          agent: "test",
          abort: AbortSignal.abort(error),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      ),
    ).rejects.toBe(error)
  })
})

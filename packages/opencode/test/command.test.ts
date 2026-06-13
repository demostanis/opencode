import { test, expect } from "bun:test"
import { Command } from "../src/command"
import { Instance } from "../src/project/instance"
import { tmpdir } from "./fixture/fixture"

test("security command invokes hidden security agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cmd = await Command.get("security")
      const names = (await Command.list()).map((x) => x.name)

      expect(names).toContain("security")
      expect(cmd).toBeDefined()
      expect(cmd?.agent).toBe("security")
      expect(cmd?.subtask).toBe(true)
      expect(await cmd?.template).toContain("$ARGUMENTS")
    },
  })
})

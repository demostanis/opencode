import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"
import { MultiAgent } from "../../src/agent/multi-agent"

describe("session.system", () => {
  test("multi-agent prompt describes root collaboration", () => {
    const [usage, mode] = SystemPrompt.multiagent()

    expect(usage).toContain("You are `/root`, the primary agent")
    expect(usage).toContain("spawn_agent")
    expect(usage).toContain("wait_agent")
    expect(usage).toContain("All agents share the same directory")
    expect(usage).toContain("There are 4 available concurrency slots")
    expect(mode).toContain("Proactive multi-agent delegation is active")
    expect(mode).toContain("no matter if you are root or subagent")
  })

  test("multi-agent prompt describes delegated agents", () => {
    const [usage, mode] = SystemPrompt.multiagent(true)

    expect(usage).toContain("You are an agent in a team of agents")
    expect(usage).toContain("available to your parent agent through the collaboration tools")
    expect(usage).not.toContain("You are `/root`")
    expect(mode).toContain("Proactive multi-agent delegation is active")
  })

  test("multi-agent marker identifies delegated sessions", () => {
    expect(MultiAgent.subagent(`instructions\n${MultiAgent.SUBAGENT}`)).toBe(true)
    expect(MultiAgent.subagent(undefined, [MultiAgent.ROLE])).toBe(true)
    expect(MultiAgent.subagent("instructions")).toBe(false)
  })

  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"
import { Teammate } from "../../src/teammate/teammate"

describe("session.system", () => {
  test("Teammate prompt describes root collaboration", () => {
    const [usage, mode] = SystemPrompt.teammate()

    expect(usage).toContain("You are `/root`, the coordinator of a team of Teammates")
    expect(usage).toContain("Every Teammate runs the Build Agent")
    expect(usage).toContain("spawn_teammate")
    expect(usage).toContain("wait_teammate")
    expect(usage).toContain("All Teammates share the same directory")
    expect(usage).toContain("one Teammate can own the frontend, another the backend")
    expect(usage).toContain("Use ordinary `task` subagents for bounded supporting work")
    expect(usage).toContain("share dependencies, interfaces, decisions, progress, conflicts")
    expect(Teammate.MAX).toBe(10)
    expect(usage).toContain("There are 11 available concurrency slots")
    expect(mode).toContain("Proactive Teammate collaboration is active")
    expect(mode).toContain("Favor a few broad, complementary assignments over recursive decomposition")
    expect(mode).toContain("Never pass an assigned workstream wholesale to another Teammate")
  })

  test("Teammate prompt requires members to own their workstreams", () => {
    const [usage, mode] = SystemPrompt.teammate(true)

    expect(usage).toContain("You are a Teammate running the Build Agent in a collaborative team")
    expect(usage).toContain("Own and complete the distinct workstream assigned to you")
    expect(usage).toContain("Do not pass your assigned workstream")
    expect(usage).toContain("Use ordinary `task` subagents for bounded exploration")
    expect(usage).not.toContain("You are `/root`")
    expect(mode).toContain("Proactive Teammate collaboration is active")
  })

  test("Teammate marker identifies team sessions", () => {
    expect(Teammate.session(`instructions\n${Teammate.MARKER}`)).toBe(true)
    expect(Teammate.session(undefined, [Teammate.ROLE])).toBe(true)
    expect(Teammate.session("instructions\n<multi_agent_subagent>")).toBe(true)
    expect(Teammate.session(undefined, [{ permission: "multiagent", pattern: "*" }])).toBe(true)
    expect(Teammate.session("instructions")).toBe(false)
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

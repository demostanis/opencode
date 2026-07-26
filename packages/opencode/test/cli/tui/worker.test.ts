import { describe, expect, test } from "bun:test"
import { parse, rename, writable } from "../../../src/cli/cmd/tui/routes/session/worker"

describe("session worker", () => {
  test("parses multi-agent and subagent titles", () => {
    expect(parse("Research child (@build agent)")).toEqual({
      agent: "build",
      type: "agent",
      title: "Research child",
    })
    expect(parse("Research child (@general subagent)")).toEqual({
      agent: "general",
      type: "subagent",
      title: "Research child",
    })
    expect(parse("Research child (@code review agent)")).toEqual({
      agent: "code review",
      type: "agent",
      title: "Research child",
    })
    expect(parse("Research child (@code (review) agent)")).toEqual({
      agent: "code (review)",
      type: "agent",
      title: "Research child",
    })
    expect(parse("Renamed child")).toEqual({
      agent: undefined,
      type: "subagent",
      title: "Renamed child",
    })
  })

  test("only roots and multi-agent children are writable", () => {
    expect(writable()).toBe(false)
    expect(writable({ title: "Root" })).toBe(true)
    expect(writable({ parentID: "root", title: "Research (@build agent)" })).toBe(true)
    expect(writable({ parentID: "root", title: "Research (@general subagent)" })).toBe(false)
    expect(writable({ parentID: "root", title: "Renamed child" })).toBe(false)
  })

  test("preserves child type when renaming", () => {
    expect(rename({ title: "Root" }, "Renamed root")).toBe("Renamed root")
    expect(rename({ parentID: "root", title: "Research (@build agent)" }, "Renamed")).toBe("Renamed (@build agent)")
    expect(rename({ parentID: "root", title: "Research (@general subagent)" }, "Renamed (@build agent)")).toBe(
      "Renamed (@build agent) (@general subagent)",
    )
    expect(rename({ parentID: "root", title: "Legacy child" }, "Renamed (@build agent)")).toBe("Renamed")
  })
})

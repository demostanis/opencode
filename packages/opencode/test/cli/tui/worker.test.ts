import { describe, expect, test } from "bun:test"
import { parse, rename, writable } from "../../../src/cli/cmd/tui/routes/session/worker"

describe("session worker", () => {
  test("parses Teammate and subagent titles", () => {
    expect(parse("Research child (@build teammate)")).toEqual({
      agent: "build",
      type: "teammate",
      title: "Research child",
    })
    expect(parse("Research child (@general subagent)")).toEqual({
      agent: "general",
      type: "subagent",
      title: "Research child",
    })
    expect(parse("Research child (@code review teammate)")).toEqual({
      agent: "code review",
      type: "teammate",
      title: "Research child",
    })
    expect(parse("Research child (@code (review) teammate)")).toEqual({
      agent: "code (review)",
      type: "teammate",
      title: "Research child",
    })
    expect(parse("Research child (@build agent)")).toEqual({
      agent: "build",
      type: "teammate",
      title: "Research child",
    })
    expect(parse("Renamed child")).toEqual({
      agent: undefined,
      type: "subagent",
      title: "Renamed child",
    })
  })

  test("only roots and Teammate children are writable", () => {
    expect(writable()).toBe(false)
    expect(writable({ title: "Root" })).toBe(true)
    expect(writable({ parentID: "root", title: "Research (@build teammate)" })).toBe(true)
    expect(writable({ parentID: "root", title: "Research (@build agent)" })).toBe(true)
    expect(writable({ parentID: "root", title: "Research (@general subagent)" })).toBe(false)
    expect(writable({ parentID: "root", title: "Renamed child" })).toBe(false)
  })

  test("preserves child type when renaming", () => {
    expect(rename({ title: "Root" }, "Renamed root")).toBe("Renamed root")
    expect(rename({ parentID: "root", title: "Research (@build teammate)" }, "Renamed")).toBe(
      "Renamed (@build teammate)",
    )
    expect(rename({ parentID: "root", title: "Research (@build agent)" }, "Renamed")).toBe("Renamed (@build teammate)")
    expect(rename({ parentID: "root", title: "Research (@general subagent)" }, "Renamed (@build teammate)")).toBe(
      "Renamed (@build teammate) (@general subagent)",
    )
    expect(rename({ parentID: "root", title: "Legacy child" }, "Renamed (@build teammate)")).toBe("Renamed")
  })
})

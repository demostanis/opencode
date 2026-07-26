import { describe, expect, test } from "bun:test"
import { hydrate } from "../../../src/cli/cmd/tui/component/prompt/session"

describe("prompt session", () => {
  const agents = ["build", "browser"]
  const main = { agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } }
  const subagent = { agent: "browser", model: { providerID: "openai", modelID: "gpt-5.6-luna" } }

  test("does not hydrate child sessions", () => {
    const root = hydrate({ session: { id: "root" }, msg: main, agents })

    expect(root).toEqual({ id: "root", msg: main })
    expect(hydrate({ session: { id: "child", parentID: "root" }, id: root?.id, msg: subagent, agents })).toBeUndefined()
    expect(hydrate({ session: { id: "root" }, id: root?.id, msg: main, agents })).toBeUndefined()
  })

  test("hydrates another root session", () => {
    expect(hydrate({ session: { id: "next" }, id: "root", msg: main, agents })).toEqual({
      id: "next",
      msg: main,
    })
  })

  test("waits for primary agents", () => {
    expect(hydrate({ session: { id: "root" }, msg: main, agents: [] })).toBeUndefined()
    expect(hydrate({ session: { id: "root" }, msg: main, agents })).toEqual({ id: "root", msg: main })
  })
})

import { describe, expect, test } from "bun:test"
import { hydrate } from "../../../src/cli/cmd/tui/component/prompt/session"
import { Variant } from "../../../src/cli/cmd/tui/util/variant"

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

describe("prompt variants", () => {
  const variants = {
    medium: {},
    max: {},
    ultra: {},
  }

  test("keeps Ultra out of thinking variants", () => {
    expect(Variant.list(variants)).toEqual(["medium", "max"])
    expect(Variant.supports(variants, Variant.ULTRA)).toBe(true)
  })

  test("labels Ultra as a mode", () => {
    expect(Variant.label(Variant.ULTRA)).toBe("Ultra")
    expect(Variant.label("max")).toBe("max")
  })

  test("requires model support for Ultra", () => {
    expect(Variant.supports(variants, Variant.ULTRA)).toBe(true)
    expect(Variant.supports({ medium: {}, max: {} }, Variant.ULTRA)).toBe(false)
    expect(Variant.supports(undefined, Variant.ULTRA)).toBe(false)
  })

  test("requires agent permission for Ultra", () => {
    expect(Variant.available({ ultra_mode_allowed: true })).toBe(true)
    expect(Variant.available({ ultra_mode_allowed: false })).toBe(false)
    expect(Variant.available(undefined)).toBe(false)
  })

  test("migrates Ultra out of persisted thinking variants", () => {
    expect(
      Variant.load(
        { "openai/gpt-5.6-sol": "ultra", "openai/gpt-5.6-terra": "medium" },
        { "openai/gpt-5.6-terra": false },
      ),
    ).toEqual({
      variant: { "openai/gpt-5.6-sol": undefined, "openai/gpt-5.6-terra": "medium" },
      ultra: { "openai/gpt-5.6-sol": true, "openai/gpt-5.6-terra": false },
    })
  })

  test("cycles thinking variants independently", () => {
    expect(Variant.next(["medium", "max"], undefined)).toBe("medium")
    expect(Variant.next(["medium", "max"], "medium")).toBe("max")
    expect(Variant.next(["medium", "max"], "max")).toBeUndefined()
  })

  test("moves the Ultra gradient across letters and frames", () => {
    expect(Variant.gradient(0, 0)).toBeLessThan(0.05)
    expect(Variant.gradient(0, 4)).toBeLessThan(0.001)
    expect(Variant.gradient((Variant.FRAMES - 1) / 4, 0)).toBe(1)
    expect(Variant.gradient((Variant.FRAMES - 1) / 2, 0)).toBeLessThan(0.05)
    expect(Variant.gradient((Variant.FRAMES - 1) / 2, 2)).toBe(1)
    expect(Variant.gradient((Variant.FRAMES - 1) / 2, 4)).toBeLessThan(0.05)
    expect(Variant.gradient(((Variant.FRAMES - 1) * 3) / 4, 4)).toBe(1)
    expect(Variant.gradient(Variant.FRAMES - 1, 0)).toBeLessThan(0.001)
    expect(Variant.gradient(Variant.FRAMES - 1, 4)).toBeLessThan(0.05)
  })
})

import { expect, test } from "bun:test"
import { highlight, preview } from "../../src/util/search"

test("highlights literal, case-insensitive matches while preserving text", () => {
  expect(highlight("one NEEDLE, two needle", "needle")).toEqual([
    { text: "one ", match: false },
    { text: "NEEDLE", match: true },
    { text: ", two ", match: false },
    { text: "needle", match: true },
  ])
})

test("does not interpret code or search operators as regular expressions", () => {
  const text = 'call(foo.bar[0]) + "100%_done"'
  for (const query of ["foo.bar[0]", "(foo", '"100%_done"', "+"]) {
    const spans = highlight(text, query)
    expect(spans.map((span) => span.text).join("")).toBe(text)
    expect(spans.filter((span) => span.match).map((span) => span.text)).toEqual([query])
  }
  expect(highlight(text, "foo.*")).toEqual([{ text, match: false }])
})

test("handles Unicode and empty queries", () => {
  expect(highlight("CAF\u00c9 \u6771\u4eac\u99c5", "caf\u00e9")).toEqual([
    { text: "CAF\u00c9", match: true },
    { text: " \u6771\u4eac\u99c5", match: false },
  ])
  expect(highlight("text", "")).toEqual([{ text: "text", match: false }])
  expect(highlight("", "needle")).toEqual([{ text: "", match: false }])
})

test("keeps match previews bounded and centers distant matches", () => {
  const text = "prefix ".repeat(1000) + "THE NEEDLE" + " suffix".repeat(1000)
  const result = preview(text, "the needle")!
  expect(result).toContain("THE NEEDLE")
  expect(result.startsWith("...")).toBe(true)
  expect(result.endsWith("...")).toBe(true)
  expect(result.length).toBeLessThanOrEqual(60)
  expect(preview(text, "not found")).toBeUndefined()
  expect(preview(text, "")).toBeUndefined()
})

import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { padding } from "../../../src/cli/cmd/tui/routes/session/panel"

const content =
  'whats the "search correctness logic" and teh "browser\u2019s promise serialization, live-call audio scheduling, and mail wake-up signals in memory\u2014they serve different purposes."'

for (const nested of [true, false]) {
  test(`session panels reserve one right-hand cell (nested=${nested})`, async () => {
    const view = await createTestRenderer({ width: 76, height: 20 })
    const panel = new BoxRenderable(view.renderer, { ...padding, border: nested ? false : ["left"], flexShrink: 0 })
    const outer = nested ? new BoxRenderable(view.renderer, { border: ["left"] }) : panel
    const text = new TextRenderable(view.renderer, { content })
    view.renderer.root.add(outer)
    if (nested) outer.add(panel)
    panel.add(text)
    try {
      for (const width of [74, 76, 32, 100, 74]) {
        view.resize(width, 20)
        for (const value of [content, "x".repeat(width - 4), "x".repeat(width - 3)]) {
          text.content = value
          await view.renderOnce()
          expect(outer.width).toBe(width)
          expect(text.width).toBe(width - 4)
          expect(text.x + text.width).toBe(panel.x + panel.width - 1)
          const rows = view
            .captureCharFrame()
            .split("\n")
            .filter((row) => row.length)
          expect(rows.every((row) => row[width - 1] === " ")).toBe(true)
          expect(
            rows
              .map((row) => row.slice(1).trim())
              .join("")
              .replace(/\s/g, ""),
          ).toBe(value.replace(/\s/g, ""))
          if (value.startsWith("x")) {
            expect(text.height).toBe(value.length === width - 4 ? 1 : 2)
            expect(rows[text.y][width - 2]).toBe("x")
          }
        }
      }
    } finally {
      view.renderer.destroy()
    }
  })
}

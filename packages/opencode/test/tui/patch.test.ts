import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { patchFileID } from "../../src/cli/cmd/tui/routes/session/patch"

test("repeated patch paths leave no blocks or layout behind on session switches", async () => {
  const fixture = await createTestRenderer({ width: 80, height: 24 })
  const renderer = fixture.renderer
  const content = new BoxRenderable(renderer, { flexDirection: "column" })
  renderer.root.add(content)
  const files = [
    { filePath: "/robot-docs/observability.md", type: "delete" },
    { filePath: "/robot-docs/observability.md", type: "add" },
    { filePath: "/robot-docs/operations.md", type: "delete" },
    { filePath: "/robot-docs/operations.md", type: "add" },
  ]
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const blocks = files.map((file, index) => {
        const block = new BoxRenderable(renderer, { id: patchFileID("prt_patch", index), height: 3 })
        block.add(new TextRenderable(renderer, { content: `${file.type} ${file.filePath}` }))
        content.add(block)
        return block
      })
      await fixture.renderOnce()
      expect(new Set(blocks.map((block) => block.id)).size).toBe(files.length)
      expect(blocks.every((block) => block.id.startsWith("tool-prt_patch-"))).toBe(true)
      for (const block of blocks) {
        content.remove(block.id)
        block.destroyRecursively()
      }
      const prompt = new TextRenderable(renderer, { content: "Child session prompt" })
      content.add(prompt)
      await fixture.renderOnce()
      expect(content.getChildren()).toEqual([prompt])
      expect(prompt.y).toBe(content.y)
      expect(fixture.captureCharFrame()).not.toContain("robot-docs")
      content.remove(prompt.id)
      prompt.destroyRecursively()
    }
  } finally {
    renderer.destroy()
  }
})

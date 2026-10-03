import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Clipboard } from "../../src/cli/cmd/tui/util/clipboard"
import { Selection } from "../../src/cli/cmd/tui/util/selection"
import { Process } from "../../src/util/process"

// Run only against an explicitly selected nested X server, not the desktop.
test.skipIf(process.env.OPENCODE_TEST_X11 !== "1")("mouse copy owns both X selections", async () => {
  const value = "OpenCode mouse copy"
  await Clipboard.copy("primary sentinel", true)
  await Clipboard.copy("explicit clipboard copy")
  expect((await Process.text(["xclip", "-selection", "primary", "-out"])).text).toBe("primary sentinel")

  const fixture = await createTestRenderer({ width: 40, height: 4 })
  const renderer = fixture.renderer
  const text = new TextRenderable(renderer, {
    content: value,
    onMouseUp: (event) => event.stopPropagation(),
  })
  renderer.root.add(text)
  const copied = new Promise<void>((resolve, reject) => {
    renderer.on("selection", () => Selection.copy(renderer, { show: () => resolve(), error: reject }))
  })
  try {
    await fixture.renderOnce()
    await fixture.mockMouse.drag(0, 0, value.length, 0)
    await copied
    expect(renderer.getSelection()).toBeNull()
    for (const selection of ["clipboard", "primary"]) {
      expect((await Process.text(["xclip", "-selection", selection, "-out"])).text).toBe(value)
    }
  } finally {
    renderer.destroy()
  }
}, 10000)

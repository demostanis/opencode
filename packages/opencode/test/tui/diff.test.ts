import { expect, spyOn, test } from "bun:test"
import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

function patch(count = 250) {
  const short = 'export const feedback = "short"'
  const long = 'export const feedback = "' + "accessible feedback ".repeat(count) + '"'
  return `--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-${short}\n-${long}\n+${long}\n+${short}\n`
}

async function setup(wrap: "word" | "char" | "none", view: "split" | "unified" = "split", count = 250) {
  const scene = await createTestRenderer({ width: 160, height: 48 })
  const outer = new BoxRenderable(scene.renderer, {
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 2,
    flexGrow: 1,
  })
  scene.renderer.root.add(outer)
  const scroll = new ScrollBoxRenderable(scene.renderer, {
    stickyScroll: true,
    stickyStart: "bottom",
    flexGrow: 1,
    viewportOptions: { paddingRight: 1 },
    verticalScrollbarOptions: { paddingLeft: 1 },
  })
  outer.add(scroll)
  const tool = new BoxRenderable(scene.renderer, {
    paddingTop: 1,
    paddingBottom: 1,
    marginTop: 1,
    gap: 1,
    flexShrink: 0,
    border: ["left"],
    paddingLeft: 2,
  })
  scroll.add(tool)
  tool.add(new TextRenderable(scene.renderer, { content: "TOOL HEADER" }))
  const inner = new BoxRenderable(scene.renderer, { paddingLeft: 1 })
  tool.add(inner)
  const style = SyntaxStyle.create()
  const diff = new DiffRenderable(scene.renderer, {
    diff: patch(count),
    syntaxStyle: style,
    view,
    width: "100%",
    wrapMode: wrap,
  })
  inner.add(diff)
  scroll.add(new TextRenderable(scene.renderer, { content: "ASSISTANT FOOTER", marginTop: 1, flexShrink: 0 }))
  const builds = spyOn(diff as unknown as { buildView(): void }, "buildView")
  const codes = () =>
    diff
      .getChildren()
      .flatMap((side) => side.getChildren())
      .filter((node) => node instanceof CodeRenderable)
  return {
    ...scene,
    diff,
    builds,
    codes,
    gutters: () =>
      codes().flatMap((node) =>
        node
          .parent!.getChildren()
          .filter((child) => child !== node)
          .map((child) => child.width),
      ),
    async frames() {
      for (let i = 0; i < 8; i++) await scene.renderOnce()
    },
    check() {
      const nodes = codes()
      expect(nodes).toHaveLength(view === "split" ? 2 : 1)
      if (view === "split") expect(nodes[0].virtualLineCount).toBe(nodes[1].virtualLineCount)
      expect(diff.height).toBe(Math.max(...nodes.map((node) => node.virtualLineCount)))
      const rows = scene.captureCharFrame().split("\n")
      const footer = rows.findIndex((row) => row.includes("ASSISTANT FOOTER"))
      expect(footer).toBeGreaterThan(0)
      const last = rows.slice(0, footer).findLastIndex((row) => row.replace(/[\s\u2502\u2503\u2588\u2584\u2580]/g, ""))
      expect(footer - last - 1).toBe(2)
    },
    [Symbol.dispose]() {
      builds.mockRestore()
      scene.renderer.destroy()
      style.destroy()
    },
  }
}

test("split word wrapping realigns after initial gutter growth", async () => {
  using scene = await setup("word")
  await scene.frames()
  scene.check()
  expect(scene.gutters()).toEqual([7, 7])
  const count = scene.builds.mock.calls.length
  for (let i = 0; i < 5; i++) {
    await scene.renderOnce()
    scene.check()
    expect(scene.builds).toHaveBeenCalledTimes(count)
  }
})

test("split word wrapping realigns after content and width changes", async () => {
  using scene = await setup("word", "split", 1)
  await scene.frames()
  scene.check()
  expect(scene.gutters()).toEqual([5, 5])
  scene.diff.diff = patch()
  await scene.frames()
  scene.check()
  expect(scene.diff.width).toBe(149)
  expect(scene.gutters()).toEqual([7, 7])
  for (const width of [129, 182, 149]) {
    scene.resize(width + 11, 48)
    await scene.frames()
    scene.check()
    expect(scene.gutters()).toEqual([7, 7])
  }
  const count = scene.builds.mock.calls.length
  scene.resize(160, 52)
  await scene.frames()
  scene.check()
  expect(scene.builds).toHaveBeenCalledTimes(count)
})

test("split char wrapping rebuilds on code width changes then settles", async () => {
  using scene = await setup("char")
  await scene.frames()
  expect(scene.codes()[0].virtualLineCount).toBe(scene.codes()[1].virtualLineCount)
  const count = scene.builds.mock.calls.length
  scene.diff.showLineNumbers = false
  await scene.frames()
  expect(scene.diff.width).toBe(149)
  expect(scene.builds.mock.calls.length).toBeGreaterThan(count)
  expect(scene.codes()[0].virtualLineCount).toBe(scene.codes()[1].virtualLineCount)
  const settled = scene.builds.mock.calls.length
  await scene.frames()
  expect(scene.builds).toHaveBeenCalledTimes(settled)
})

test("split width listeners detach from cached code nodes on unified teardown", async () => {
  using scene = await setup("word")
  await scene.frames()
  const nodes = scene.codes()
  using side = {
    node: nodes[1].parent!,
    [Symbol.dispose]() {
      this.node.destroyRecursively()
    },
  }
  const diff = scene.diff as unknown as {
    resizes: Map<CodeRenderable, () => void>
    requestRebuild(): void
    pendingRebuild: boolean
  }
  expect(diff.resizes.size).toBe(2)
  const handlers = [...diff.resizes]
  for (const [code, handler] of handlers) expect(code.listeners("line-info-change")).toContain(handler)
  scene.diff.view = "unified"
  await scene.frames()
  expect(scene.codes()).toEqual([nodes[0]])
  expect(scene.diff.getChildren()).not.toContain(side.node)
  diff.requestRebuild()
  expect(diff.pendingRebuild).toBe(true)
  scene.diff.destroyRecursively()
  expect(diff.resizes.size).toBe(0)
  using requests = spyOn(diff, "requestRebuild")
  const count = scene.builds.mock.calls.length
  for (const [code, handler] of handlers) {
    expect(code.listeners("line-info-change")).not.toContain(handler)
    code.emit("line-info-change")
  }
  await Promise.resolve()
  expect(requests).not.toHaveBeenCalled()
  expect(diff.pendingRebuild).toBe(false)
  expect(scene.builds).toHaveBeenCalledTimes(count)
})

for (const [wrap, view] of [
  ["none", "split"],
  ["word", "unified"],
] as const) {
  test(`${view} ${wrap} control stays stable`, async () => {
    using scene = await setup(wrap, view)
    await scene.frames()
    scene.check()
    const count = scene.builds.mock.calls.length
    scene.resize(140, 52)
    await scene.frames()
    scene.check()
    expect(scene.builds).toHaveBeenCalledTimes(count)
  })
}

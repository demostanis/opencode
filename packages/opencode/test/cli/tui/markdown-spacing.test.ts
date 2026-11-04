import { expect, test } from "bun:test"
import { CodeRenderable, MarkdownRenderable, SyntaxStyle, TreeSitterClient } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { hyperlinks, Markdown } from "../../../src/cli/cmd/tui/util/links"
import { tmpdir } from "../../fixture/fixture"

const content =
  "I meant **rules that keep search results accurate**, versus **small mechanisms that coordinate things happening right now**. Calling them all \u201cqueues\u201d makes them sound more similar than they are.\n\n" +
  "## Search correctness logic\n\n" +
  "These are the guarantees we must preserve when replacing the search queue:"

for (const streaming of [false, true]) {
  test(`linked markdown preserves heading spacing (streaming=${streaming})`, async () => {
    await using tmp = await tmpdir()
    const client = new TreeSitterClient({ dataPath: tmp.path })
    const syntax = SyntaxStyle.fromStyles({ "markup.heading": { bold: true } })
    const view = await createTestRenderer({ width: 76, height: 18 })
    const markdown = new Markdown(view.renderer, { syntaxStyle: syntax, treeSitterClient: client, streaming })
    view.renderer.root.add(markdown)
    try {
      if (streaming) {
        for (let i = 1; i < content.length; i += 13) {
          markdown.content = content.slice(0, i)
          await view.renderOnce()
        }
      }
      markdown.content = content
      for (let i = 0; i < 100 && !view.captureCharFrame().includes("Search correctness logic"); i++) {
        await view.renderOnce()
        await Bun.sleep(10)
      }
      const rows = view
        .captureCharFrame()
        .split("\n")
        .map((row) => row.trimEnd())
      expect(rows.slice(2, 7)).toEqual([
        "them sound more similar than they are.",
        "",
        "Search correctness logic",
        "",
        "These are the guarantees we must preserve when replacing the search queue:",
      ])
      expect(markdown._blockStates).toHaveLength(1)
      markdown.streaming = false
      markdown.conceal = false
      await view.renderOnce()
      markdown.conceal = true
      markdown.refreshStyles()
      await view.renderOnce()
      expect(markdown._blockStates).toHaveLength(1)
    } finally {
      view.renderer.destroy()
      await client.destroy()
      syntax.destroy()
    }
  })
}

test("markdown chunk hooks apply to existing and future prose, not fenced code", async () => {
  await using tmp = await tmpdir()
  const client = new TreeSitterClient({ dataPath: tmp.path })
  const syntax = SyntaxStyle.fromStyles({})
  const view = await createTestRenderer({ width: 76, height: 18 })
  const markdown = new MarkdownRenderable(view.renderer, {
    content: "Intro\n\n```text\n[1](https://example.com)\n```\n\n## Heading\n\nBody",
    syntaxStyle: syntax,
    treeSitterClient: client,
  })
  try {
    const prose = () => markdown._blockStates.filter((state) => state.token.type !== "code")
    const code = markdown._blockStates.find((state) => state.token.type === "code")!.renderable as CodeRenderable
    const original = (prose()[0].renderable as CodeRenderable).onChunks
    markdown.onChunks = hyperlinks
    expect(markdown.onChunks).toBe(hyperlinks)
    expect(prose().every((state) => (state.renderable as CodeRenderable).onChunks === hyperlinks)).toBe(true)
    expect(code.onChunks).toBeUndefined()
    markdown.content += "\n\n> Quoted\n\nMore"
    markdown.refreshStyles()
    expect(prose().every((state) => (state.renderable as CodeRenderable).onChunks === hyperlinks)).toBe(true)
    markdown.onChunks = undefined
    expect(prose().every((state) => (state.renderable as CodeRenderable).onChunks === original)).toBe(true)
    expect(code.onChunks).toBeUndefined()
  } finally {
    markdown.destroyRecursively()
    view.renderer.destroy()
    await client.destroy()
    syntax.destroy()
  }
})

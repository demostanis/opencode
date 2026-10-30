import { expect, test } from "bun:test"
import {
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TreeSitterClient,
  treeSitterToTextChunks,
  type TextChunk,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { citations } from "../../../src/cli/cmd/tui/routes/session/citations"
import { tmpdir } from "../../fixture/fixture"
import { hyperlinks, linked } from "../../../src/cli/cmd/tui/util/links"

test("citation Markdown attaches real hyperlink data in both standard renderers", async () => {
  const href = "https://www.iana.org/domains/reserved"
  const existing = "https://example.com/source"
  const content = citations(
    `Source <cite|turn0search0>. Unknown <cite|turn9search9>. Existing [site](${existing}). Code \`<cite|turn0search0>\`.`,
    new Map([["turn0search0", href]]),
  )
  await using tmp = await tmpdir()
  const client = new TreeSitterClient({ dataPath: tmp.path })
  const syntax = SyntaxStyle.fromStyles({ "markup.link.label": { underline: true }, "markup.link.url": { dim: true } })
  const view = await createTestRenderer({ width: 100, height: 10 })
  const markdown = new MarkdownRenderable(view.renderer, {
    content,
    syntaxStyle: syntax,
    treeSitterClient: client,
    renderNode: linked,
  })
  const native: TextChunk[] = []
  markdown._blockStates.forEach((block) => {
    if (!(block.renderable instanceof CodeRenderable)) return
    const callback = block.renderable.onChunks
    block.renderable.onChunks = async (chunks, context) => {
      const result = await callback?.(chunks, context)
      if (result) native.push(...result)
      return result
    }
  })
  try {
    const result = await client.highlightOnce(content, "markdown")
    expect(result.error).toBeUndefined()
    expect(result.highlights?.length).toBeGreaterThan(0)
    if (!result.highlights) throw new Error("Missing Markdown highlights")
    const chunks = hyperlinks(treeSitterToTextChunks(content, result.highlights, syntax), {
      content,
      highlights: result.highlights,
      syntaxStyle: syntax,
      filetype: "markdown",
    })
    expect(chunks.filter((chunk) => chunk.link).map((chunk) => chunk.link?.url)).toContain(href)
    expect(chunks.find((chunk) => chunk.text === "turn0search0")?.link?.url).toBe(href)
    expect(chunks.find((chunk) => chunk.text === "site")?.link?.url).toBe(existing)
    expect(chunks.some((chunk) => chunk.text.includes("<cite|turn0search0>") && !chunk.link)).toBe(true)
    expect(chunks.filter((chunk) => chunk.text.includes("turn9search9")).every((chunk) => !chunk.link)).toBe(true)
    view.renderer.root.add(markdown)
    await view.renderOnce()
    for (let i = 0; i < 100 && !view.captureCharFrame().includes("turn0search0"); i++) {
      await Bun.sleep(10)
      await view.renderOnce()
    }
    const tokens = markdown._parseState?.tokens.flatMap((token) => ("tokens" in token ? (token.tokens ?? []) : []))
    expect(tokens?.flatMap((token) => (token.type === "link" && "href" in token ? [token.href] : []))).toEqual([
      href,
      existing,
    ])
    expect(view.captureCharFrame()).toContain("turn0search0")
    expect(view.captureCharFrame()).toContain("turn9search9")
    expect(native.some((chunk) => chunk.link?.url === href)).toBe(true)
    expect(native.find((chunk) => chunk.text === "turn0search0")?.link?.url).toBe(href)
    expect(native.find((chunk) => chunk.text === "site")?.link?.url).toBe(existing)
    expect(native.some((chunk) => chunk.text.includes("<cite|turn0search0>") && !chunk.link)).toBe(true)
    expect(native.some((chunk) => chunk.text.includes("turn9search9"))).toBe(true)
    expect(native.filter((chunk) => chunk.text.includes("turn9search9")).every((chunk) => !chunk.link)).toBe(true)
  } finally {
    view.renderer.destroy()
    await client.destroy()
    syntax.destroy()
  }
})

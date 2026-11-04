import {
  MarkdownRenderable,
  detectLinks,
  type ChunkRenderContext,
  type MarkdownOptions,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"

export function hyperlinks(chunks: TextChunk[], context: ChunkRenderContext) {
  const labels = new Set(
    context.highlights
      .filter(([start, end, group]) => group === "markup.link.label" && /^\d+$/.test(context.content.slice(start, end)))
      .map(([start]) => start),
  )
  let offset = 0
  chunks.forEach((chunk) => {
    if (!chunk.text.trim()) return
    const index = context.content.indexOf(chunk.text, offset)
    if (index < 0) return
    offset = index + chunk.text.length
    // Brackets keep numeric labels readable and let OpenTUI link single-digit labels.
    if (labels.has(index) && /^\d+$/.test(chunk.text)) chunk.text = `[${chunk.text}]`
  })
  return detectLinks(chunks, {
    content: context.content,
    // OpenTUI's backwards label lookup stops at conceal highlights between a label and URL.
    highlights: context.highlights.filter((highlight) => highlight[2] !== "conceal"),
  })
}

export class Markdown extends MarkdownRenderable {
  constructor(ctx: RenderContext, opts: MarkdownOptions) {
    super(ctx, { ...opts, onChunks: hyperlinks })
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    linked: typeof Markdown
  }
}

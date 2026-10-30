import {
  CodeRenderable,
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

export const linked: NonNullable<MarkdownOptions["renderNode"]> = (_, context) => {
  const node = context.defaultRender()
  if (node instanceof CodeRenderable && node.onChunks) node.onChunks = hyperlinks
  return node
}

export class Markdown extends MarkdownRenderable {
  constructor(ctx: RenderContext, opts: MarkdownOptions) {
    // Solid assigns props after construction; OpenTUI has no renderNode setter.
    super(ctx, { ...opts, renderNode: linked })
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    linked: typeof Markdown
  }
}

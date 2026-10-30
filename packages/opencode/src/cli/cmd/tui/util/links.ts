import {
  CodeRenderable,
  detectLinks,
  type ChunkRenderContext,
  type MarkdownOptions,
  type TextChunk,
} from "@opentui/core"

export function hyperlinks(chunks: TextChunk[], context: ChunkRenderContext) {
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

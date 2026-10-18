function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function websearch(input: Record<string, unknown>, metadata: Record<string, unknown>, status: string) {
  const native = record(metadata.native)
  const action = record(native.action)
  const query = text(action.query) ?? text(input.query)
  const url = text(action.url)
  const pattern = text(action.pattern)
  const terminal = status === "completed" || status === "error"
  const label = (() => {
    if (action.type === "open_page") return url ? `Open Page ${url}` : "Open Page"
    if (action.type === "find") return `Find${pattern ? ` "${pattern}"` : ""}${url ? ` in ${url}` : ""}`
    if (query) return `Web Search "${query}"`
    if (status === "completed") return "Web Search completed"
    if (status === "error") return "Web Search failed"
    return "Web Search"
  })()
  const count = Array.isArray(native.sources)
    ? native.sources.filter((source: unknown) => record(source).type === "url" && text(record(source).url)).length
    : undefined
  const suffix =
    count !== undefined
      ? ` (${count} ${count === 1 ? "source" : "sources"})`
      : typeof metadata.numResults === "number" && metadata.numResults
        ? ` (${metadata.numResults} results)`
        : ""

  return {
    label: label + suffix,
    complete: terminal || Boolean(query || url || pattern),
    pending:
      action.type === "open_page"
        ? "Opening page..."
        : action.type === "find"
          ? "Finding in page..."
          : "Searching web...",
  }
}

import type { Part } from "@opencode-ai/sdk/v2"

const ref = /^turn\d+[a-z]+\d+$/
const token = /<cite\|([^<>\n]*)>|\ue200cite\ue202([^\ue200\ue201\n]*)\ue201/g

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function url(value: unknown) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\\\s\x00-\x1f\x7f]/.test(value)) return
  const parsed = URL.parse(value)
  if (!parsed || parsed.username || parsed.password) return
  return value
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

// Only the leading marker is provenance; citations in page body text are not result identities.
function refs(value: unknown) {
  if (typeof value !== "string") return []
  const match = new RegExp(`^(?:${token.source})`).exec(value.trimStart())
  return (match?.[1] ?? match?.[2] ?? "").split(/[|\ue202]/).filter((value) => ref.test(value))
}

export function references(parts: readonly Part[]) {
  const links = new Map<string, string>()
  const found = new Map<string, Set<string>>()
  function collect(value: unknown) {
    const item = record(value)
    if (Array.isArray(item.items)) item.items.forEach(collect)
    if (item.native) collect(item.native)
    if (item.type !== "web_search_call") return
    const action = record(item.action)
    const sources = Array.isArray(action.sources) ? action.sources : Array.isArray(item.sources) ? item.sources : []
    const results = Array.isArray(item.results) ? item.results : []
    sources.concat(results).forEach((value) => {
      const result = record(value)
      const href =
        url(result.url) ??
        (results.length === 1 && ["open_page", "openPage", "find_in_page", "findInPage"].includes(String(action.type))
          ? url(action.url)
          : undefined)
      if (!href) return
      const ids = [result.ref_id, result.id].filter(
        (value): value is string => typeof value === "string" && ref.test(value),
      )
      ids.concat(refs(result.snippet)).forEach((id) => {
        const urls = found.get(id) ?? new Set<string>()
        urls.add(href)
        found.set(id, urls)
      })
    })
  }
  parts.forEach((part) => {
    if (part.type !== "tool" || part.tool !== "websearch" || part.state.status !== "completed") return
    if (part.state.time.compacted) return
    if (part.state.metadata.native !== undefined) {
      collect(part.state.metadata.native)
      return
    }
    collect(parse(part.state.output))
  })
  found.forEach((urls, id) => {
    if (urls.size === 1) links.set(id, [...urls][0])
  })
  return links
}

function literals(content: string) {
  const mask = new Uint8Array(content.length)
  let fence: { char: string; size: number; depth: number } | undefined
  const containers: number[] = []
  let offset = 0
  for (const line of content.split(/(?<=\n)/)) {
    let column = 0
    const expanded = line.replace(/\t/g, (_, index: number) => {
      const size = 4 - ((index + column) % 4)
      column += size - 1
      return " ".repeat(size)
    })
    let start = 0
    let depth = 0
    // A zero-width container is a quote; lists store their continuation indentation.
    for (const indent of containers) {
      const text = expanded.slice(start)
      const prefix = indent === 0 ? /^ {0,3}> ?/.exec(text)?.[0] : new RegExp(`^ {${indent}}`).exec(text)?.[0]
      if (prefix === undefined && (indent === 0 || !/^ *[\r\n]*$/.test(text))) break
      start += prefix?.length ?? text.length
      depth++
    }
    containers.length = depth
    if (fence && depth < fence.depth) fence = undefined
    while (!fence) {
      const text = expanded.slice(start)
      const quote = /^ {0,3}> ?/.exec(text)
      if (quote) {
        start += quote[0].length
        containers.push(0)
        continue
      }
      const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])( +|(?=[\r\n]|$))/.exec(text)
      if (!list) break
      const size = list[0].length - list[1].length + (list[1].length > 4 ? 1 : list[1].length || 1)
      start += size
      containers.push(size)
    }
    const text = expanded.slice(start)
    let index = 0
    let width = 0
    while (width < start && index < line.length) {
      width += line[index] === "\t" ? 4 - (width % 4) : 1
      index++
    }
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(text)
    if (fence) {
      mask.fill(1, offset, offset + line.length)
      if (match && match[1][0] === fence.char && match[1].length >= fence.size && /^[ \t]*$/.test(match[2]))
        fence = undefined
    } else if (match && (match[1][0] !== "`" || !match[2].includes("`"))) {
      fence = { char: match[1][0], size: match[1].length, depth: containers.length }
      mask.fill(1, offset, offset + line.length)
    } else if (/^(?: {4}| {0,3}\t)/.test(text) || /^(?: {4}| {0,3}\t)/.test(line.slice(index))) {
      mask.fill(1, offset, offset + line.length)
    }
    offset += line.length
  }

  // Index equal-length backtick runs once instead of searching again at every opener.
  const runs = new Map<number, { end: number; next?: number }>()
  const tails = new Map<number, number>()
  for (let i = content.length - 1; i >= 0; i--) {
    if (mask[i]) {
      tails.clear()
      continue
    }
    if (content[i] !== "`") continue
    const end = i + 1
    while (i > 0 && !mask[i - 1] && content[i - 1] === "`") i--
    runs.set(i, { end, next: tails.get(end - i) })
    tails.set(end - i, i)
  }
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue
    if (content[i] === "\\") {
      mask.fill(1, i, i + 2)
      i++
      continue
    }
    const run = runs.get(i)
    if (!run) continue
    const end = run.next === undefined ? run.end : runs.get(run.next)!.end
    if (run.next !== undefined) mask.fill(1, i, end)
    i = end - 1
  }

  // Balanced delimiter tables make even a line of unmatched '[' linear to scan.
  const pairs = new Int32Array(content.length)
  const brackets: number[] = []
  const parens: number[] = []
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue
    const char = content[i]
    if (char === "[") brackets.push(i)
    if (char === "(") parens.push(i)
    const start = char === "]" ? brackets.pop() : char === ")" ? parens.pop() : undefined
    if (start !== undefined) pairs[start] = i + 1
  }
  for (let i = 0; i < content.length; i++) {
    if (mask[i] || content[i] !== "[" || !pairs[i]) continue
    const end = pairs[i]
    if ((content[end] !== "(" && content[end] !== "[") || !pairs[end]) continue
    mask.fill(1, i, pairs[end])
    i = pairs[end] - 1
  }
  return mask
}

export function citations(content: string, links: ReadonlyMap<string, string>, streaming = false) {
  if (!content.includes("<cite|") && !content.includes("\ue200cite\ue202")) {
    if (!streaming || !/(?:<(?:c(?:i(?:t(?:e)?)?)?)?|\ue200(?:c(?:i(?:t(?:e)?)?)?)?)$/.test(content)) return content
  }
  const mask = literals(content)
  function replace(value: string, tail = false) {
    const text =
      streaming && tail
        ? value.replace(
            /(?:<(?:c(?:i(?:t(?:e(?:\|[^<>\n]*)?)?)?)?)?|\ue200(?:c(?:i(?:t(?:e(?:\ue202[^\ue200\ue201\n]*)?)?)?)?)?)$/,
            "",
          )
        : value
    return text.replace(token, (match, ascii: string | undefined, unicode: string | undefined) => {
      const ids = (ascii ?? unicode ?? "").split(/[|\ue202]/).filter(Boolean)
      if (!ids.length || ids.some((id) => !ref.test(id))) return match
      return ids
        .map((id) => {
          const href = url(links.get(id))
          if (!href) return `(${id})`
          return `[${id}](${href.replace(/[()<>\\\[\]|`]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)})`
        })
        .join(" ")
    })
  }
  const chunks: string[] = []
  let offset = 0
  for (let i = 0; i < content.length; i++) {
    if (!mask[i]) continue
    const start = i
    while (i < content.length && mask[i]) i++
    chunks.push(replace(content.slice(offset, start)), content.slice(start, i))
    offset = i
  }
  chunks.push(replace(content.slice(offset), true))
  return chunks.join("")
}

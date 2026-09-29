function pattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
}

export function highlight(text: string, query = "") {
  if (!query) return [{ text, match: false }]
  const matches = Array.from(text.matchAll(pattern(query)))
  if (!matches.length) return [{ text, match: false }]
  return matches
    .flatMap((item, index) => [
      {
        text: text.slice(index ? matches[index - 1].index + matches[index - 1][0].length : 0, item.index),
        match: false,
      },
      { text: item[0], match: true },
    ])
    .concat({ text: text.slice(matches.at(-1)!.index + matches.at(-1)![0].length), match: false })
    .filter((item) => item.text)
}

export function preview(text: string, query: string) {
  if (!query) return
  const match = pattern(query).exec(text)
  if (!match) return
  const start = Math.max(0, match.index - 18)
  const end = Math.min(text.length, Math.max(start + 54, match.index + match[0].length))
  return (start ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "")
}

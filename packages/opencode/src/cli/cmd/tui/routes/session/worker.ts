export function parse(title: string) {
  const suffix = title.endsWith(" teammate)")
    ? " teammate)"
    : title.endsWith(" agent)")
      ? " agent)"
      : title.endsWith(" subagent)")
        ? " subagent)"
        : undefined
  const type = suffix === " subagent)" ? ("subagent" as const) : suffix ? ("teammate" as const) : undefined
  const start = type ? title.lastIndexOf(" (@") : -1
  const agent = type && suffix && start >= 0 ? title.slice(start + 3, -suffix.length) : undefined
  if (!type || !agent) return { agent: undefined, type: "subagent" as const, title }
  return {
    agent,
    type,
    title: title.slice(0, start),
  }
}

export function writable(session?: { parentID?: string; title: string }) {
  if (!session) return false
  if (!session.parentID) return true
  return parse(session.title).type === "teammate"
}

export function rename(session: { parentID?: string; title: string } | undefined, title: string) {
  if (!session?.parentID) return title
  const info = parse(session.title)
  if (!info.agent) return parse(title).title
  return `${title} (@${info.agent} ${info.type})`
}

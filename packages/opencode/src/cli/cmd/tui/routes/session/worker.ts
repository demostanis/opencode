export function parse(title: string) {
  const type = title.endsWith(" agent)")
    ? ("agent" as const)
    : title.endsWith(" subagent)")
      ? ("subagent" as const)
      : undefined
  const start = type ? title.lastIndexOf(" (@") : -1
  const agent = type && start >= 0 ? title.slice(start + 3, -` ${type})`.length) : undefined
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
  return parse(session.title).type === "agent"
}

export function rename(session: { parentID?: string; title: string } | undefined, title: string) {
  if (!session?.parentID) return title
  const info = parse(session.title)
  if (!info.agent) return parse(title).title
  return `${title} (@${info.agent} ${info.type})`
}

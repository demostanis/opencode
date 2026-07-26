export function hydrate<T extends { agent: string }>(input: {
  session?: { id: string; parentID?: string }
  id?: string
  msg?: T
  agents: string[]
}) {
  if (!input.session || input.session.parentID || input.session.id === input.id || !input.msg) return
  if (!input.agents.includes(input.msg.agent)) return
  return {
    id: input.session.id,
    msg: input.msg,
  }
}

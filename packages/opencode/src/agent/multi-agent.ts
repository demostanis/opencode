export namespace MultiAgent {
  export const MAX = 3
  export const SUBAGENT = "<multi_agent_subagent>"
  export const ROLE = { permission: "multiagent", pattern: "*", action: "allow" } as const
  export const IDS = [
    "spawn_agent",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
    "list_agents",
  ] as const

  export function tool(id: string) {
    return (IDS as readonly string[]).includes(id)
  }

  export function subagent(prompt?: string, rules?: ReadonlyArray<{ permission: string; pattern: string }>) {
    return (
      prompt?.includes(SUBAGENT) === true ||
      rules?.some((rule) => rule.permission === ROLE.permission && rule.pattern === ROLE.pattern) === true
    )
  }
}

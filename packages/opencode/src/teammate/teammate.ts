export namespace Teammate {
  export const MAX = 3
  export const MARKER = "<teammate_session>"
  export const ROLE = { permission: "teammate", pattern: "*", action: "allow" } as const
  const legacy = {
    marker: "<multi_agent_subagent>",
    role: "multiagent",
  }
  export const IDS = [
    "spawn_teammate",
    "send_message",
    "followup_task",
    "wait_teammate",
    "interrupt_teammate",
    "list_teammates",
  ] as const

  export function tool(id: string) {
    return (IDS as readonly string[]).includes(id)
  }

  export function role(permission: string) {
    return permission === ROLE.permission || permission === legacy.role
  }

  export function session(prompt?: string, rules?: ReadonlyArray<{ permission: string; pattern: string }>) {
    return (
      [MARKER, legacy.marker].some((marker) => prompt?.includes(marker) === true) ||
      rules?.some((rule) => role(rule.permission) && rule.pattern === ROLE.pattern) === true
    )
  }
}

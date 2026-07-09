export namespace MultiAgent {
  export const MAX = 3
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
}

import type { Session } from "@opencode-ai/sdk/v2"

export function list<T extends Pick<Session, "id" | "parentID" | "title" | "directory" | "time">>(
  sessions: T[],
  dir?: string,
  now = Date.now(),
) {
  const today = new Date(now).toDateString()
  return sessions
    .filter((session) => session.parentID === undefined)
    .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
    .map((session) => {
      const remote = session.title.endsWith(" (from another host)")
      const local = !remote && (!dir || session.directory === dir)
      const date = new Date(session.time.updated).toDateString()
      return {
        session,
        local,
        remote,
        category: remote ? "On another host" : local ? (date === today ? "Today" : date) : "In other workspaces",
      }
    })
    .toSorted((a, b) => Number(a.remote) - Number(b.remote) || Number(b.local) - Number(a.local))
}

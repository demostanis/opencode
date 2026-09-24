import { Active } from "@/session/active"

export async function resume(input: {
  sessionID: string
  fork?: boolean
  forkSession: (sessionID: string) => Promise<string | undefined>
  remote?: (sessionID: string) => Promise<boolean>
}) {
  if (!input.fork && !(await (input.remote ?? Active.remote)(input.sessionID))) return input.sessionID
  const id = await input.forkSession(input.sessionID)
  if (!id) throw new Error("Failed to fork session")
  return id
}

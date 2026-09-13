import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { MessageID, PartID } from "@/session/schema"

export async function voice(
  client: OpencodeClient,
  opts: {
    text: string
    disabled?: boolean
    sessionID?: string
    workspaceID?: string
    agent: string
    model?: { providerID: string; modelID: string }
    variant?: string
    memory: "none" | "remember" | "readonly" | "full"
  },
) {
  if (opts.disabled)
    throw new Error("Voice delegation is disabled for this prompt. Select an enabled prompt and retry.")
  if (!opts.text.trim()) throw new Error("Voice delegation is empty. Speak a prompt and retry.")
  if (!opts.model) throw new Error("Connect a provider and select a model before delegating a voice prompt.")

  const session = opts.sessionID
  const workspaceID = opts.workspaceID
  const messageID = MessageID.ascending()
  const prompt = {
    messageID,
    agent: opts.agent,
    model: { ...opts.model },
    variant: opts.variant,
    memory: opts.memory === "none" ? undefined : opts.memory,
    parts: [{ id: PartID.ascending(), type: "text" as const, text: opts.text }],
  }
  const sessionID = session ?? (await client.session.create({ workspaceID }, { throwOnError: true })).data.id
  await client.session.promptAsync({ sessionID, ...prompt }, { throwOnError: true })
  return { sessionID, messageID }
}

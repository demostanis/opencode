import type { Message, Part, Session, SessionSearchHit } from "@opencode-ai/sdk/v2"
import { preview } from "@/util/search"

export function live(
  messages: Message[],
  parts: Record<string, Part[]>,
  query: string,
  revert?: string,
  session?: Pick<Session, "title" | "directory">,
) {
  if (Array.from(query).length < 3) return []
  return messages
    .filter((msg) => msg.role === "assistant" && !msg.time.completed && (!revert || msg.id < revert))
    .flatMap((msg) =>
      (parts[msg.id] ?? []).flatMap((part): SessionSearchHit[] => {
        if (part.type !== "text" || part.synthetic || part.ignored) return []
        const text = preview(part.text, query)
        if (!text) return []
        return [
          {
            sessionID: msg.sessionID,
            title: session?.title ?? "",
            directory: session?.directory ?? "",
            messageID: msg.id,
            partID: part.id,
            role: msg.role,
            type: part.type,
            tool: null,
            time: msg.time.created,
            preview: text,
          },
        ]
      }),
    )
}

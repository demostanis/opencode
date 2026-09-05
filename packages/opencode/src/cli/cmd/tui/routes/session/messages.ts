import type { Message } from "@opencode-ai/sdk/v2"

export function order(messages: Message[]) {
  const deferred = new Map(messages.filter((msg) => msg.role === "user" && msg.deferred).map((msg) => [msg.id, msg]))
  if (deferred.size === 0) return messages
  const main = messages.filter((msg) => !deferred.has(msg.id))
  return main
    .flatMap((msg) => {
      const parent = msg.role === "assistant" ? deferred.get(msg.parentID) : undefined
      if (!parent) return [msg]
      deferred.delete(parent.id)
      return [parent, msg]
    })
    .concat([...deferred.values()])
}

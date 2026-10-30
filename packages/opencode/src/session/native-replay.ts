import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

// Responses drops assistant tool results when store is false. Search needs a portable function result.
export function nativeReplay(prompt: LanguageModelV2Prompt): LanguageModelV2Prompt {
  const ids = new Set(
    prompt.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "tool-result").map((part) => part.toolCallId)
        : [],
    ),
  )
  const results = new Set(
    prompt.flatMap((message) => (message.role === "tool" ? message.content.map((part) => part.toolCallId) : [])),
  )
  const calls = new Set<string>()
  return prompt.flatMap((message): LanguageModelV2Prompt => {
    if (message.role !== "assistant") return [message]
    const messages: LanguageModelV2Prompt = []
    let content: typeof message.content = []
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === "websearch" && ids.has(part.toolCallId)) {
        calls.add(part.toolCallId)
        content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
        continue
      }
      if (part.type === "tool-call" && part.toolName === "websearch" && part.providerExecuted) {
        calls.add(part.toolCallId)
        content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
        if (results.has(part.toolCallId)) continue
        messages.push({ ...message, content })
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { type: "error-text", value: "[Tool execution was interrupted]" },
            },
          ],
        })
        content = []
        continue
      }
      if (part.type === "tool-call" && part.providerExecuted) {
        if (!ids.has(part.toolCallId)) {
          content.push({ type: "text", text: `${part.toolName}: ${JSON.stringify(part.input)}` })
        }
        continue
      }
      if (part.type !== "tool-result") {
        content.push(part)
        continue
      }
      const value = part.output.value
      if (part.toolName === "websearch") {
        if (!calls.has(part.toolCallId)) {
          calls.add(part.toolCallId)
          content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: {} })
        }
        if (content.length > 0) messages.push({ ...message, content })
        messages.push({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output }],
        })
        content = []
        continue
      }
      if (
        part.toolName === "image_generation" &&
        typeof value === "object" &&
        value !== null &&
        "result" in value &&
        typeof value.result === "string"
      ) {
        content.push({ type: "text", text: "image_generation: Generated image" })
        messages.push({ ...message, content })
        messages.push({
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: new URL(`data:image/png;base64,${value.result}`) }],
        })
        content = []
        continue
      }
      content.push({
        type: "text",
        text: `${part.toolName}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      })
    }
    if (content.length > 0) messages.push({ ...message, content })
    return messages
  })
}

import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

test.each(["stop", "tool-calls"] as const)(
  "compact tool summarizes and automatically resumes once after %s",
  async (finish) => {
    const requests: {
      messages: { role: string; content: unknown; tool_call_id?: string }[]
      tools?: { function: { name: string } }[]
    }[] = []
    const summary = "The user requested compaction. Next, report that the original task is complete."
    const output =
      "Compaction requested. The conversation will be compacted after this step and then continue automatically."
    using server = Bun.serve({
      port: 0,
      async fetch(req) {
        const index = requests.length
        requests.push(await req.json())
        const chunks = [
          {
            id: `reply-${index}`,
            choices: [
              {
                delta:
                  index === 0
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-compact",
                            type: "function",
                            function: { name: "compact", arguments: "{}" },
                          },
                        ],
                      }
                    : { role: "assistant", content: index === 1 ? summary : "Original task complete." },
              },
            ],
          },
          {
            id: `reply-${index}`,
            choices: [{ delta: {}, finish_reason: index === 0 && finish === "tool-calls" ? "tool_calls" : "stop" }],
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    await using tmp = await tmpdir({
      config: {
        model: "compact/test",
        enabled_providers: ["compact"],
        compaction: { auto: false },
        permission: { "*": "allow" },
        provider: {
          compact: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${server.url.origin}/v1`, apiKey: "test" },
            models: { test: { name: "Test", limit: { context: 128000, output: 1000 } } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Compact tool integration" })
        try {
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("compact"), modelID: ModelID.make("test") },
            parts: [{ type: "text", text: "Compact this conversation, then finish the original task." }],
          })
          const messages = await Session.messages({ sessionID: session.id })

          expect(requests).toHaveLength(3)
          expect(requests[0].tools?.some((tool) => tool.function.name === "compact")).toBe(true)
          expect(requests[1].tools ?? []).toHaveLength(0)
          expect(requests[1].messages).toContainEqual({ role: "tool", tool_call_id: "call-compact", content: output })
          expect(JSON.stringify(requests[1].messages)).toContain(
            "Provide a detailed prompt for continuing our conversation above.",
          )
          expect(requests[2].tools?.some((tool) => tool.function.name === "compact")).toBe(true)
          expect(JSON.stringify(requests[2].messages)).toContain(summary)

          expect(messages.map((message) => message.info.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
            "assistant",
          ])
          expect(messages[1].info).toMatchObject({ role: "assistant", agent: "build", finish })
          expect(messages[1].parts.filter((part) => part.type === "tool")).toMatchObject([
            {
              tool: "compact",
              callID: "call-compact",
              state: {
                status: "completed",
                input: {},
                title: "Compacting conversation",
                output,
                metadata: { compact: true },
              },
            },
          ])
          expect(
            messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction"),
          ).toMatchObject([{ messageID: messages[2].info.id, auto: true, overflow: false }])
          expect(messages[3].info).toMatchObject({
            role: "assistant",
            parentID: messages[2].info.id,
            agent: "compaction",
            mode: "compaction",
            summary: true,
            finish: "stop",
          })
          expect(messages[3].parts.filter((part) => part.type === "text")).toMatchObject([{ text: summary }])
          expect(messages[4].info).toMatchObject({ role: "user", agent: "build" })
          expect(messages[4].parts).toMatchObject([
            {
              type: "text",
              synthetic: true,
              text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
            },
          ])
          expect(JSON.stringify(requests[2].messages)).toContain(
            messages[4].parts.find((part) => part.type === "text")!.text,
          )
          expect(result.info).toMatchObject({
            id: messages[5].info.id,
            role: "assistant",
            parentID: messages[4].info.id,
            agent: "build",
            mode: "build",
            finish: "stop",
          })
          expect(result.parts.filter((part) => part.type === "text")).toMatchObject([
            { text: "Original task complete." },
          ])
          expect(
            messages.flatMap((message) =>
              message.info.role === "assistant" && message.info.error ? [message.info.error] : [],
            ),
          ).toEqual([])
          expect(SessionStatus.get(session.id).type).toBe("idle")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  },
  30000,
)

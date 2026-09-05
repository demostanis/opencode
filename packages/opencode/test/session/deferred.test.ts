import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { order } from "../../src/cli/cmd/tui/routes/session/messages"
import { tmpdir } from "../fixture/fixture"

test("releases deferred messages together in FIFO order only after each agent turn", async () => {
  const gates = Array.from({ length: 4 }, () => ({
    request: Promise.withResolvers<string>(),
    response: Promise.withResolvers<void>(),
  }))
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const index = requests.length
      const body = await req.text()
      requests.push(body)
      gates[index]?.request.resolve(body)
      await gates[index]?.response.promise
      const chunks = [
        {
          id: `reply-${index}`,
          object: "chat.completion.chunk",
          choices: [
            {
              delta:
                index === 0
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-test",
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({ command: "true", description: "Complete test tool step" }),
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: `response-${index}` },
            },
          ],
        },
        {
          id: `reply-${index}`,
          object: "chat.completion.chunk",
          choices: [{ delta: {}, finish_reason: index === 0 ? "tool_calls" : "stop" }],
        },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  await using tmp = await tmpdir({
    config: {
      model: "queue/test",
      enabled_providers: ["queue"],
      permission: { "*": "allow" },
      provider: {
        queue: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${server.url.origin}/v1`, apiKey: "test" },
          models: { test: { name: "Test", limit: { context: 128000, output: 1000 } } },
        },
      },
    },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Deferred batch regression" })
        const model = { providerID: ProviderID.make("queue"), modelID: ModelID.make("test") }
        const running = SessionPrompt.prompt({
          sessionID: session.id,
          model,
          parts: [{ type: "text", text: "initial prompt" }],
        })
        const submit = (text: string, deferred = true) =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model,
            noReply: true,
            deferred,
            parts: [{ type: "text", text }],
          })
        try {
          await gates[0].request.promise
          await submit("deferred-A")
          await submit("deferred-B")
          gates[0].response.resolve()

          const continuation = await gates[1].request.promise
          expect(continuation).not.toContain("deferred-A")
          expect(continuation).not.toContain("deferred-B")
          expect(continuation).toContain("call-test")
          await submit("normal-C", false)
          gates[1].response.resolve()

          const batch = await gates[2].request.promise
          expect(batch).toContain("deferred-A")
          expect(batch).toContain("deferred-B")
          expect(batch.indexOf("normal-C")).toBeLessThan(batch.indexOf("deferred-A"))
          expect(batch.indexOf("deferred-A")).toBeLessThan(batch.indexOf("deferred-B"))
          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.filter((msg) => msg.info.role === "user" && msg.info.deferred)).toHaveLength(0)
          expect(order(messages.map((msg) => msg.info)).map((msg) => msg.id)).toEqual(
            messages.map((msg) => msg.info.id),
          )
          expect(messages.map((msg) => msg.info.role)).toEqual([
            "user",
            "assistant",
            "assistant",
            "user",
            "user",
            "user",
            "assistant",
          ])

          await submit("deferred-D")
          await submit("deferred-E")
          gates[2].response.resolve()

          const next = await gates[3].request.promise
          expect(next).toContain("deferred-D")
          expect(next).toContain("deferred-E")
          expect(next.indexOf("deferred-D")).toBeLessThan(next.indexOf("deferred-E"))
          gates[3].response.resolve()
          await running

          expect(requests).toHaveLength(4)
          const finished = await Session.messages({ sessionID: session.id })
          expect(finished.filter((msg) => msg.info.role === "user" && msg.info.deferred)).toHaveLength(0)
          expect(finished.slice(-3).map((msg) => msg.info.role)).toEqual(["user", "user", "assistant"])
        } finally {
          SessionPrompt.cancel(session.id, "user")
          gates.forEach((gate) => gate.response.resolve())
          await running.catch(() => {})
          await Session.remove(session.id)
        }
      },
    })
  } finally {
    server.stop(true)
  }
})

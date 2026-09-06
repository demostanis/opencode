import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { order } from "../../src/cli/cmd/tui/routes/session/messages"
import { tmpdir } from "../fixture/fixture"

test("deletes only unclaimed queued messages while busy without releasing cancelled deferred messages", async () => {
  const gates = Array.from({ length: 3 }, () => ({
    request: Promise.withResolvers<string>(),
    response: Promise.withResolvers<void>(),
  }))
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const index = requests.length
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
                          id: "call-delete",
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({ command: "true", description: "Complete deletion test step" }),
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
        const session = await Session.create({ title: "Pending deletion regression" })
        const submit = (text: string, deferred = false) =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: ProviderID.make("queue"), modelID: ModelID.make("test") },
            noReply: true,
            deferred,
            parts: [
              { type: "text", text },
              { type: "text", text: `${text}-second-part` },
            ],
          })
        const earlier = await submit("consumed-earlier")
        const current = await submit("consumed-current")
        const removed: string[] = []
        const unsubscribe = Bus.subscribe(MessageV2.Event.Removed, (event) => {
          if (event.properties.sessionID === session.id) removed.push(event.properties.messageID)
        })
        const remove = (msg: MessageV2.WithParts) =>
          Server.Default().request(`/session/${session.id}/message/${msg.info.id}`, {
            method: "DELETE",
            headers: { "x-opencode-directory": tmp.path },
          })
        const running = SessionPrompt.loop({ sessionID: session.id })
        try {
          const first = await gates[0].request.promise
          expect(first).toContain("consumed-earlier")
          expect(first).toContain("consumed-current")
          const deferred = await submit("cancel-deferred", true)
          const retained = await submit("retain-deferred", true)
          gates[0].response.resolve()

          // The deferred messages have now been snapshotted, but not consumed by the tool continuation.
          const continuation = await gates[1].request.promise
          expect(continuation).toContain("call-delete")
          expect(continuation).not.toContain("cancel-deferred")
          expect(continuation).not.toContain("retain-deferred")
          const normal = await submit("cancel-normal")
          const pending = await submit("retain-normal")
          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.some((msg) => msg.info.role === "assistant" && msg.info.parentID === earlier.info.id)).toBe(
            false,
          )
          expect(messages.some((msg) => msg.info.role === "assistant" && msg.info.parentID === current.info.id)).toBe(
            true,
          )
          const assistant = messages.findLast((msg) => msg.info.role === "assistant")!
          expect(normal.info.id > assistant.info.id).toBe(true)

          for (const msg of [earlier, current, assistant]) {
            const before = await MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
            const response = await remove(msg)
            expect(response.status).toBe(500)
            expect(await response.json()).toMatchObject({
              name: "UnknownError",
              data: { message: expect.stringContaining(`Session ${session.id} is busy`) },
            })
            expect(await MessageV2.get({ sessionID: session.id, messageID: msg.info.id })).toEqual(before)
          }
          expect(removed).toEqual([])

          for (const msg of [normal, deferred]) {
            expect(await MessageV2.parts(msg.info.id)).toHaveLength(2)
            const response = await remove(msg)
            expect(response.status).toBe(200)
            expect(await response.json()).toBe(true)
            expect(await MessageV2.parts(msg.info.id)).toEqual([])
            const missing = await Server.Default().request(`/session/${session.id}/message/${msg.info.id}`, {
              headers: { "x-opencode-directory": tmp.path },
            })
            expect(missing.status).toBe(404)
          }
          expect(removed).toEqual([normal.info.id, deferred.info.id])
          gates[1].response.resolve()

          const batch = await gates[2].request.promise
          expect(batch).toContain("retain-normal")
          expect(batch).toContain("retain-deferred")
          expect(batch.indexOf("retain-normal")).toBeLessThan(batch.indexOf("retain-deferred"))
          const released = await Session.messages({ sessionID: session.id })
          expect(released.some((msg) => msg.info.id === pending.info.id)).toBe(true)
          expect(released.some((msg) => msg.info.id === retained.info.id)).toBe(false)
          expect(released.some((msg) => msg.info.role === "user" && msg.info.deferred)).toBe(false)
          gates[2].response.resolve()
          await running

          expect(requests).toHaveLength(3)
          for (const body of requests) {
            expect(body).not.toContain("cancel-normal")
            expect(body).not.toContain("cancel-deferred")
          }
          const finished = await Session.messages({ sessionID: session.id })
          expect(finished.filter((msg) => msg.info.role === "user").map((msg) => msg.parts[0])).toEqual([
            earlier.parts[0],
            current.parts[0],
            pending.parts[0],
            expect.objectContaining({ type: "text", text: "retain-deferred" }),
          ])
          for (const msg of [normal, deferred]) {
            expect(finished.some((item) => item.info.id === msg.info.id)).toBe(false)
            expect(await MessageV2.parts(msg.info.id)).toEqual([])
            expect(removed.filter((id) => id === msg.info.id)).toHaveLength(1)
          }
        } finally {
          unsubscribe()
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

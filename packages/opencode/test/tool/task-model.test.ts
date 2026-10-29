import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

function server(models: string[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      models.push(body.model)
      const chunks = [
        { choices: [{ delta: { role: "assistant", content: "child result" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]
      return new Response(
        chunks
          .map((chunk) => `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", ...chunk })}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
}

function fixture(url: string) {
  return tmpdir({
    config: {
      model: "abliteration/qwen3-32b",
      enabled_providers: ["abliteration"],
      permission: { "*": "allow" },
      agent: { general: { model: "missing/configured", subagent_model: "missing/subagent" } },
      command: { child: { agent: "general", model: "missing/command", template: "Return child result." } },
      provider: {
        abliteration: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${url}/v1`, apiKey: "test" },
          models: {
            "qwen3-32b": { name: "Qwen", limit: { context: 128000, output: 1000 } },
            "llama-3.3-70b": { name: "Llama", limit: { context: 128000, output: 1000 } },
          },
        },
      },
    },
  })
}

test("resumed general tasks use the current Abliteration parent, not prior child or overrides", async () => {
  const models: string[] = []
  const endpoint = server(models)
  try {
    await using tmp = await fixture(endpoint.url.origin)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const child = await Session.create({ parentID: parent.id, title: "Existing child" })
        await SessionPrompt.prompt({
          sessionID: child.id,
          agent: "general",
          model: { providerID: ProviderID.make("missing"), modelID: ModelID.make("previous") },
          noReply: true,
          parts: [{ type: "text", text: "Previous task" }],
        })
        const tool = await TaskTool.init()
        for (const mid of ["qwen3-32b", "llama-3.3-70b"]) {
          const model = { providerID: ProviderID.make("abliteration"), modelID: ModelID.make(mid) }
          const user = await SessionPrompt.prompt({
            sessionID: parent.id,
            agent: "build",
            model,
            noReply: true,
            parts: [{ type: "text", text: "Delegate task" }],
          })
          const assistant = await Session.updateMessage({
            id: MessageID.ascending(),
            parentID: user.info.id,
            sessionID: parent.id,
            role: "assistant",
            mode: "build",
            agent: "build",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...model,
            time: { created: Date.now() },
          })
          const result = await tool.execute(
            { subagent_type: "general", task_id: child.id, description: "Resume child", prompt: "Continue task" },
            {
              sessionID: parent.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              extra: { subagentModel: { providerID: "missing", modelID: "override" } },
              metadata: (input) => expect(input.metadata?.model).toEqual(model),
              ask: async () => {},
            },
          )
          expect(result.metadata.sessionId).toBe(child.id)
          expect(result.metadata.model).toEqual(model)
          expect(result.output).toContain("child result")
          const messages = await Session.messages({ sessionID: child.id })
          expect(messages.filter((msg) => msg.info.role === "user").at(-1)?.info).toMatchObject({ model })
          expect(messages.at(-1)?.info).toMatchObject(model)
        }
        expect(models).toEqual(["qwen3-32b", "llama-3.3-70b"])
      },
    })
  } finally {
    endpoint.stop(true)
  }
})

for (const explicit of [false, true]) {
  test(`general command subtasks ignore invalid overrides with explicit parent=${explicit}`, async () => {
    const models: string[] = []
    const endpoint = server(models)
    try {
      await using tmp = await fixture(endpoint.url.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Command parent" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("abliteration"), modelID: ModelID.make("qwen3-32b") },
            noReply: true,
            parts: [{ type: "text", text: "Parent context" }],
          })
          const result = await SessionPrompt.command({
            sessionID: session.id,
            agent: "build",
            command: "child",
            arguments: "",
            model: explicit ? "abliteration/llama-3.3-70b" : undefined,
          })
          const mid = explicit ? "llama-3.3-70b" : "qwen3-32b"
          expect(result.info).toMatchObject({ providerID: "abliteration", modelID: mid })
          const messages = await Session.messages({ sessionID: session.id })
          const task = messages.flatMap((msg) => msg.parts).find((part) => part.type === "subtask")
          expect(task).toMatchObject({ model: { providerID: "abliteration", modelID: mid } })
          const children = await Session.children(session.id)
          expect(children).toHaveLength(1)
          const child = await Session.messages({ sessionID: children[0].id })
          expect(child[0].info).toMatchObject({ model: { providerID: "abliteration", modelID: mid } })
          expect(models.length).toBeGreaterThan(0)
          expect(models.every((model) => model === mid)).toBe(true)
        },
      })
    } finally {
      endpoint.stop(true)
    }
  })
}

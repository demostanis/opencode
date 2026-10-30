import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModelV2Prompt, LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { nativeReplay } from "../../src/session/native-replay"
import { nativeResult } from "../../src/session/native-result"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

async function* drain(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return
    yield next.value
  }
}

const items = ["search", "open_page", "find_in_page"].map((type, index) => ({
  id: `ws_${index}`,
  type: "web_search_call",
  status: "completed",
  action: {
    type,
    query: "Bun",
    queries: ["Bun", "Bun docs"],
    url: "https://bun.sh",
    pattern: "install",
    sources: [{ type: "url", url: "https://bun.sh", extra: null }],
    extra: { untouched: true },
  },
  results: [
    {
      type: "text_result",
      snippet: `Exact snippet ${index}\n  preserved`,
      title: "Bun",
      url: "https://bun.sh",
      extra: [null, 42],
    },
  ],
  extra: { future: ["value", null] },
}))

test.each([false, true])("installed adapter retains every exposed search field, streaming=%s", async (streaming) => {
  const requests: Record<string, unknown>[] = []
  const response = {
    id: "resp_1",
    created_at: 0,
    model: "gpt-5",
    output: items,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const sdk = createOpenAI({
    apiKey: "test",
    fetch: Object.assign(
      async (_: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        if (!streaming) return Response.json(response)
        const events = [
          ...items.flatMap((item, index) => [
            {
              type: "response.output_item.added",
              output_index: index,
              item: { id: item.id, type: item.type, status: "in_progress", results: null },
            },
            { type: "response.output_item.done", output_index: index, item },
          ]),
          { type: "response.completed", response: { ...response, output: [] } },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const opts = {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Search" }] }],
    tools: [{ type: "provider-defined" as const, id: "openai.web_search" as const, name: "websearch", args: {} }],
  }
  const language = sdk.responses("gpt-5")
  const chunks = streaming
    ? await Array.fromAsync(drain((await language.doStream(opts)).stream))
    : (await language.doGenerate(opts)).content
  expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
  const results = chunks.filter((chunk) => chunk.type === "tool-result")
  expect(results.map((chunk) => chunk.result)).toEqual(items)
  expect(requests[0].include).toEqual(["web_search_call.action.sources", "web_search_call.results"])
  for (const [index, chunk] of results.entries()) {
    const part: MessageV2.ToolPart = {
      id: PartID.make("part"),
      messageID: MessageID.make("message"),
      sessionID: SessionID.make("session"),
      type: "tool",
      tool: "websearch",
      callID: chunk.toolCallId,
      state: { status: "running", input: {}, time: { start: 0 } },
    }
    const stored = await nativeResult(part, chunk.result)
    expect(stored.metadata.native).toBe(chunk.result)
    expect(
      MessageV2.ToolStateCompleted.parse({ status: "completed", input: {}, ...stored, time: { start: 0, end: 1 } })
        .metadata.native,
    ).toEqual(items[index])
  }
})

test("installed adapter serializes ordered surrogate pairs, not prose, references, or fresh searches", async () => {
  const requests: Record<string, unknown>[] = []
  const sdk = createOpenAI({
    apiKey: "test",
    fetch: Object.assign(
      async (_: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: "resp_2",
          created_at: 0,
          model: "gpt-5",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const prompt: LanguageModelV2Prompt = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Before",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } },
        },
        ...items.flatMap((item): Extract<LanguageModelV2Prompt[number], { role: "assistant" }>["content"] => [
          {
            type: "tool-call",
            toolCallId: item.id,
            toolName: "websearch",
            input: { query: "Bun" },
            providerExecuted: true,
            providerOptions: { openai: { itemId: item.id } },
          },
          {
            type: "tool-result",
            toolCallId: item.id,
            toolName: "websearch",
            output: { type: "json", value: item },
            providerOptions: { openai: { itemId: item.id } },
          },
        ]),
        { type: "text", text: "After" },
        { type: "tool-call", toolCallId: "local", toolName: "bash", input: { command: "true" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "local", toolName: "bash", output: { type: "text", value: "ok" } }],
    },
  ]
  const original = structuredClone(prompt)
  const replay = nativeReplay(prompt)
  expect(nativeReplay(replay)).toEqual(replay)
  expect(prompt).toEqual(original)
  expect(JSON.stringify(replay)).not.toContain("websearch:")
  await sdk.responses("gpt-5").doGenerate({
    prompt: replay,
    tools: [{ type: "function", name: "websearch", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "none" },
    providerOptions: { openai: { store: false } },
  })
  const input = requests[0].input as Array<Record<string, unknown>>
  expect(input.map((item) => item.type ?? item.role)).toEqual([
    "reasoning",
    ...items.flatMap(() => ["function_call", "function_call_output"]),
    "assistant",
    "function_call",
    "function_call_output",
  ])
  expect(input[0]).toMatchObject({ id: "rs_1", encrypted_content: "encrypted" })
  for (const [index, item] of items.entries()) {
    expect(input[1 + index * 2]).toEqual({
      type: "function_call",
      call_id: item.id,
      name: "websearch",
      arguments: '{"query":"Bun"}',
    })
    expect(input[2 + index * 2]).toEqual({
      type: "function_call_output",
      call_id: item.id,
      output: JSON.stringify(item),
    })
  }
  expect(requests[0].tool_choice).toBe("none")
  expect(requests[0].tools).toMatchObject([{ type: "function", name: "websearch" }])
  expect(requests).toHaveLength(1)
})

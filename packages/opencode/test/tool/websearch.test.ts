import { afterEach, expect, spyOn, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { WebSearchTool } from "../../src/tool/websearch"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()))

test.each([false, true])("Codex fallback retains raw done items when final output is empty=%s", async (empty) => {
  const items = ["search", "open_page", "find_in_page"].map((type, index) => ({
    id: `ws_${index}`,
    type: "web_search_call",
    status: "completed",
    action: {
      type,
      query: "query",
      queries: ["query"],
      sources: [{ type: "url", url: "https://example.com", future: null }],
      future: [null],
    },
    results: [
      { type: "text_result", snippet: `Exact ${index}\n`, title: "Title", url: "https://example.com", future: "kept" },
    ],
    future: { nested: [null, true] },
  }))
  const requests: Record<string, unknown>[] = []
  spies.push(
    spyOn(Auth, "get").mockResolvedValue({
      type: "oauth",
      access: "test",
      refresh: "test",
      expires: Date.now() + 60000,
    }),
  )
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_: RequestInfo | URL, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)))
          const events = [
            {
              type: "response.output_item.added",
              item: { id: "ws_0", type: "web_search_call", status: "in_progress", results: null },
            },
            ...items.map((item) => ({ type: "response.output_item.done", item })),
            { type: "response.output_text.delta", delta: "Summary only" },
            { type: "response.completed", response: { output: empty ? [] : items } },
          ]
          const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
          return new Response(
            new ReadableStream({
              start(controller) {
                for (let index = 0; index < bytes.length; index += 17)
                  controller.enqueue(bytes.slice(index, index + 17))
                controller.close()
              },
            }),
          )
        },
        { preconnect: fetch.preconnect },
      ),
    ),
  )
  await using tmp = await tmpdir({ config: { lightweight_model: "openai/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await WebSearchTool.init()
      const result = await tool.execute(
        { query: "query" },
        {
          sessionID: SessionID.make("session"),
          messageID: MessageID.make("message"),
          callID: "outer-call",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      expect(result.output).toBe("Summary only")
      expect(result.metadata.native).toEqual({ backend: "codex", items })
      expect(requests).toHaveLength(1)
      expect(requests[0].include).toEqual(["web_search_call.action.sources", "web_search_call.results"])
    },
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, streamText, tool, type Tool } from "ai"
import { PermissionNext } from "../../src/permission"
import { ResponsesTools } from "../../src/session/responses-tools"
import { Flag } from "../../src/flag/flag"

function local() {
  return tool({
    inputSchema: jsonSchema<{ prompt: string }>({
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    }),
    execute: async (input) => ({ output: input.prompt }),
  })
}

function select(permission: PermissionNext.Ruleset, opts?: { disabled?: Record<string, boolean> }) {
  const tools = { websearch: local(), image_generate: local(), bash: local() }
  return {
    tools,
    selected: ResponsesTools.select({ language: { provider: "openai.responses" }, tools, permission, ...opts }),
  }
}

describe.each([false, true])("session.responses-tools native=%s", (enabled) => {
  const original = Flag.OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION

  beforeEach(() => {
    Object.assign(Flag, { OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION: enabled })
  })

  afterEach(() => {
    Object.assign(Flag, { OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION: original })
  })

  test("gates native images without changing websearch or mutating local tools", async () => {
    const result = select(PermissionNext.fromConfig({ "*": "allow" }))
    expect(result.selected.websearch).toMatchObject({ type: "provider-defined", id: "openai.web_search" })
    expect(result.selected.bash).toBe(result.tools.bash)
    expect(result.tools.websearch.type).not.toBe("provider-defined")
    expect(result.tools.image_generate.type).not.toBe("provider-defined")
    if (!enabled) {
      expect(result.selected.image_generation).toBeUndefined()
      expect(result.selected.image_generate).toBe(result.tools.image_generate)
      expect(result.selected.image_generate.inputSchema).toBe(result.tools.image_generate.inputSchema)
      expect(result.selected.image_generate.execute).toBe(result.tools.image_generate.execute)
      expect(
        await result.selected.image_generate.execute?.(
          { prompt: "A red circle" },
          { toolCallId: "local-image", messages: [] },
        ),
      ).toEqual({ output: "A red circle" })
      return
    }
    expect(result.selected.image_generation).toMatchObject({
      type: "provider-defined",
      id: "openai.image_generation",
      args: { outputFormat: "png" },
    })
    expect(result.selected.image_generate).toBeUndefined()
  })

  test.each(["openai.chat", "openai.completion", "azure.responses", "xai.responses", "anthropic.messages"])(
    "keeps local fallbacks for %s even with an OpenAI model id",
    (provider) => {
      const tools = { websearch: local(), image_generate: local() }
      const sdk = createOpenAI({ apiKey: "test" })
      const language = provider === "openai.chat" ? sdk.chat("gpt-5") : { provider }
      expect(ResponsesTools.select({ language, tools, permission: PermissionNext.fromConfig({ "*": "allow" }) })).toBe(
        tools,
      )
    },
  )

  test.each(["ask", "deny"] as const)("does not replace %s tools", (action) => {
    const result = select(PermissionNext.fromConfig({ "*": action }))
    expect(result.selected.websearch).toBe(result.tools.websearch)
    expect(result.selected.image_generate).toBe(result.tools.image_generate)
    expect(result.selected.image_generation).toBeUndefined()
  })

  test("default ask does not enable native tools", () => {
    const result = select([])
    expect(result.selected.websearch).toBe(result.tools.websearch)
    expect(result.selected.image_generate).toBe(result.tools.image_generate)
  })

  test.each(["ask", "deny"] as const)("keeps runtime checks for pattern-specific %s", (action) => {
    const result = select(
      PermissionNext.fromConfig({
        "*": "allow",
        websearch: { "confidential*": action },
        image_generate: { "private*": action },
      }),
    )
    expect(result.selected.websearch).toBe(result.tools.websearch)
    expect(result.selected.image_generate).toBe(result.tools.image_generate)
  })

  test("specific allows cannot authorize arbitrary native queries", () => {
    const result = select(PermissionNext.fromConfig({ websearch: { "public*": "allow" } }))
    expect(result.selected.websearch).toBe(result.tools.websearch)
  })

  test("honors wildcard permissions and later session overrides", () => {
    const result = select(
      PermissionNext.merge(
        PermissionNext.fromConfig({ "*": "allow", "web*": { "secret*": "deny" } }),
        PermissionNext.fromConfig({ websearch: "allow", image_generate: "ask" }),
      ),
    )
    expect(result.selected.websearch.type).toBe("provider-defined")
    expect(result.selected.image_generate).toBe(result.tools.image_generate)
  })

  test.each(["image_generate", "image_generation", "websearch"])("honors user disable for %s", (name) => {
    const result = select(PermissionNext.fromConfig({ "*": "allow" }), { disabled: { [name]: false } })
    if (name === "websearch") {
      expect(result.selected.websearch).toBeUndefined()
      return
    }
    expect(result.selected.image_generate).toBeUndefined()
    expect(result.selected.image_generation).toBeUndefined()
  })

  test("does not bypass restrictions on the native image name", () => {
    const result = select(PermissionNext.fromConfig({ "*": "allow", image_generation: "deny" }))
    expect(result.selected.image_generation).toBeUndefined()
    expect(result.selected.image_generate).toBe(result.tools.image_generate)
  })

  test("never introduces unavailable tools or overwrites a name collision", () => {
    expect(
      ResponsesTools.select({
        language: { provider: "openai.responses" },
        tools: {},
        permission: PermissionNext.fromConfig({ "*": "allow" }),
      }),
    ).toEqual({})
    const tools = { image_generate: local(), image_generation: local() }
    expect(
      ResponsesTools.select({
        language: { provider: "openai.responses" },
        tools,
        permission: PermissionNext.fromConfig({ "*": "allow" }),
      }),
    ).toEqual(tools)
  })

  test("the installed Responses adapter sends native tools and streams their names and raw results", async () => {
    Object.assign(Flag, { OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION: true })
    const requests: unknown[] = []
    const items = [
      {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "OpenAI", sources: [{ type: "url", url: "https://openai.com" }] },
      },
      {
        id: "ig_1",
        type: "image_generation_call",
        status: "completed",
        result: "aW1hZ2U=",
        revised_prompt: "A red circle on white.",
        action: "generate",
        background: "opaque",
        output_format: "png",
        quality: "low",
        size: "1254x1254",
      },
    ]
    const events = [
      ...items.flatMap((item, index) => [
        { type: "response.output_item.added", output_index: index, item },
        { type: "response.output_item.done", output_index: index, item },
      ]),
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          created_at: 0,
          model: "gpt-5",
          incomplete_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]
    const sdk = createOpenAI({
      apiKey: "test",
      fetch: Object.assign(
        async (_: RequestInfo | URL, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)))
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const language = sdk.responses("gpt-5")
    const tools: Record<string, Tool> = { websearch: local(), image_generate: local() }
    const stream = streamText({
      includeRawChunks: true,
      model: language,
      messages: [{ role: "user", content: "Search and draw" }],
      tools: ResponsesTools.select({ language, tools, permission: PermissionNext.fromConfig({ "*": "allow" }) }),
    })
    const chunks = await Array.fromAsync(stream.fullStream)
    expect(
      chunks
        .filter((chunk) => chunk.type === "raw")
        .some((chunk) => JSON.stringify(chunk.rawValue).includes('"revised_prompt":"A red circle on white."')),
    ).toBe(true)
    expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      tools: [{ type: "web_search" }, { type: "image_generation", output_format: "png" }],
      include: ["web_search_call.action.sources"],
    })
    expect(chunks.filter((chunk) => chunk.type === "tool-call")).toMatchObject([
      { toolName: "websearch", input: {}, providerExecuted: true },
      { toolName: "image_generation", input: {}, providerExecuted: true },
    ])
    expect(chunks.filter((chunk) => chunk.type === "tool-result")).toMatchObject([
      {
        toolName: "websearch",
        providerExecuted: true,
        output: {
          action: { type: "search", query: "OpenAI" },
          sources: [{ type: "url", url: "https://openai.com" }],
        },
      },
      { toolName: "image_generation", providerExecuted: true, output: { result: "aW1hZ2U=" } },
    ])
  })
})

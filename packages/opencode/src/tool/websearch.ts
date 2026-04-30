import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch.txt"
import { abortAfterAny } from "../util/abort"
import { Auth } from "../auth"
import { codexAuthHeaders } from "../plugin/codex"

const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINTS: {
    SEARCH: "/mcp",
  },
  DEFAULT_NUM_RESULTS: 8,
} as const

interface McpSearchRequest {
  jsonrpc: string
  id: number
  method: string
  params: {
    name: string
    arguments: {
      query: string
      numResults?: number
      livecrawl?: "fallback" | "preferred"
      type?: "auto" | "fast" | "deep"
      contextMaxCharacters?: number
    }
  }
}

interface McpSearchResponse {
  jsonrpc: string
  result: {
    content: Array<{
      type: string
      text: string
    }>
  }
}

type CodexItem = {
  type?: string
  content?: Array<{
    type?: string
    text?: string
  }>
  action?: {
    type?: string
    query?: string
    queries?: string[]
    url?: string
  }
}

type CodexResponse = {
  output_text?: string
  output?: CodexItem[]
}

function text(data: CodexResponse) {
  const output = data.output_text?.trim()
  if (output) return output

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part): part is { type?: string; text: string } => !!part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function searches(data: CodexResponse) {
  return (data.output || [])
    .filter((item) => item.type === "web_search_call")
    .map((item) => item.action)
    .filter((item): item is NonNullable<CodexItem["action"]> => !!item)
    .map((item) => item.query || item.queries?.join(", ") || item.url)
    .filter((item): item is string => !!item)
}

async function codex(params: { query: string; type?: "auto" | "fast" | "deep" }, signal: AbortSignal) {
  const headers = await codexAuthHeaders()
  headers.set("content-type", "application/json")

  const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: "gpt-5.5",
      instructions: [
        "Use web_search to answer the user's query with current information.",
        "Return concise results with source URLs when available.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: params.query,
            },
          ],
        },
      ],
      tools: [
        {
          type: "web_search",
          external_web_access: params.type === "fast" ? false : true,
          search_context_size: params.type === "deep" ? "high" : "medium",
        },
      ],
      tool_choice: "auto",
      store: false,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Codex search error (${response.status}): ${body || response.statusText}`)
  }

  const data = (await response.json()) as CodexResponse
  const output = text(data)
  const actions = searches(data)
  return (
    output ||
    (actions.length ? `Searched: ${actions.join("\n")}` : "No search results found. Please try a different query.")
  )
}

export const WebSearchTool = Tool.define("websearch", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: z.object({
      query: z.string().describe("Websearch query"),
      numResults: z.number().optional().describe("Number of search results to return (default: 8)"),
      livecrawl: z
        .enum(["fallback", "preferred"])
        .optional()
        .describe(
          "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
        ),
      type: z
        .enum(["auto", "fast", "deep"])
        .optional()
        .describe(
          "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
        ),
      contextMaxCharacters: z
        .number()
        .optional()
        .describe("Maximum characters for context string optimized for LLMs (default: 10000)"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "websearch",
        patterns: [params.query],
        always: ["*"],
        metadata: {
          query: params.query,
          numResults: params.numResults,
          livecrawl: params.livecrawl,
          type: params.type,
          contextMaxCharacters: params.contextMaxCharacters,
        },
      })

      const auth = await Auth.get("openai")
      if (auth?.type === "oauth") {
        const { signal, clearTimeout } = abortAfterAny(45000, ctx.abort)
        try {
          const output = await codex(params, signal)
          clearTimeout()
          return {
            output,
            title: `Web search: ${params.query}`,
            metadata: { backend: "codex" },
          }
        } catch (error) {
          clearTimeout()
          if (error instanceof Error && error.name === "AbortError") throw new Error("Search request timed out")
          throw error
        }
      }

      const searchRequest: McpSearchRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: params.query,
            type: params.type || "auto",
            numResults: params.numResults || API_CONFIG.DEFAULT_NUM_RESULTS,
            livecrawl: params.livecrawl || "fallback",
            contextMaxCharacters: params.contextMaxCharacters,
          },
        },
      }

      const { signal, clearTimeout } = abortAfterAny(25000, ctx.abort)

      try {
        const headers: Record<string, string> = {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        }

        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}`, {
          method: "POST",
          headers,
          body: JSON.stringify(searchRequest),
          signal,
        })

        clearTimeout()

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Search error (${response.status}): ${errorText}`)
        }

        const responseText = await response.text()

        // Parse SSE response
        const lines = responseText.split("\n")
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data: McpSearchResponse = JSON.parse(line.substring(6))
            if (data.result && data.result.content && data.result.content.length > 0) {
              return {
                output: data.result.content[0].text,
                title: `Web search: ${params.query}`,
                metadata: { backend: "exa" },
              }
            }
          }
        }

        return {
          output: "No search results found. Please try a different query.",
          title: `Web search: ${params.query}`,
          metadata: { backend: "exa" },
        }
      } catch (error) {
        clearTimeout()

        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Search request timed out")
        }

        throw error
      }
    },
  }
})

import { describe, expect, test } from "bun:test"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"
import { nativeReplay } from "../../src/session/native-replay"

describe("nativeReplay", () => {
  test("leaves local search signatures, summaries, and parallel grouping untouched", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search",
            toolName: "websearch",
            input: {},
            providerOptions: { google: { thoughtSignature: "signed" } },
          },
          { type: "tool-call", toolCallId: "bash", toolName: "bash", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search",
            toolName: "websearch",
            output: { type: "json", value: { output: "Summary", native: { backend: "codex", items: [] } } },
          },
          { type: "tool-result", toolCallId: "bash", toolName: "bash", output: { type: "text", value: "ok" } },
        ],
      },
    ]
    expect(nativeReplay(prompt)).toEqual(prompt)
  })

  test.each(["error-text", "error-json"] as const)(
    "keeps native %s results as matched errors in either result role",
    (type) => {
      const output =
        type === "error-text"
          ? { type, value: "Search failed" }
          : { type, value: { error: "Search failed", extra: null } }
      for (const role of ["assistant", "tool"] as const) {
        const prompt: LanguageModelV2Prompt = [
          {
            role: "assistant",
            content: [
              { type: "tool-call", providerExecuted: true, toolCallId: "search", toolName: "websearch", input: {} },
            ],
          },
          { role, content: [{ type: "tool-result", toolCallId: "search", toolName: "websearch", output }] },
        ]
        const result = nativeReplay(prompt)
        expect(result).toEqual([
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "search", toolName: "websearch", input: {} }],
          },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "search", toolName: "websearch", output }] },
        ])
        expect(nativeReplay(result)).toEqual(result)
        expect(JSON.stringify(result)).not.toContain("websearch:")
      }
    },
  )

  test("preserves order and metadata around native images and leaves local tools alone", () => {
    const before = { type: "text" as const, text: "Before", providerOptions: { openai: { itemId: "text-1" } } }
    const after = { type: "text" as const, text: "After", providerOptions: { openai: { itemId: "text-2" } } }
    const local = { type: "tool-call" as const, toolCallId: "local", toolName: "bash", input: {} }
    const prompt: LanguageModelV2Prompt = [
      { role: "system", content: "System" },
      {
        role: "assistant",
        providerOptions: { test: { message: true } },
        content: [
          before,
          { type: "tool-call", providerExecuted: true, toolCallId: "image", toolName: "image_generation", input: {} },
          {
            type: "tool-result",
            toolCallId: "image",
            toolName: "image_generation",
            output: { type: "json", value: { result: "Zm9v" } },
            providerOptions: { openai: { itemId: "image" } },
          },
          after,
          local,
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "local", toolName: "bash", output: { type: "text", value: "ok" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]
    const original = structuredClone(prompt)
    const result = nativeReplay(prompt)
    expect(result).toEqual([
      prompt[0],
      {
        role: "assistant",
        providerOptions: { test: { message: true } },
        content: [before, { type: "text", text: "image_generation: Generated image" }],
      },
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: new URL("data:image/png;base64,Zm9v") }],
      },
      { role: "assistant", providerOptions: { test: { message: true } }, content: [after, local] },
      prompt[2],
      prompt[3],
    ])
    expect(prompt).toEqual(original)
    expect(nativeReplay(result)).toEqual(result)
  })

  test("replays search as matched function messages without native IDs", () => {
    const value = { action: { type: "search", query: "Bun" }, sources: [{ type: "url", url: "https://bun.sh" }] }
    expect(
      nativeReplay([
        {
          role: "assistant",
          content: [
            { type: "tool-call", providerExecuted: true, toolCallId: "search", toolName: "websearch", input: {} },
            { type: "tool-result", toolCallId: "search", toolName: "websearch", output: { type: "json", value } },
          ],
        },
      ]),
    ).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "search", toolName: "websearch", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "search", toolName: "websearch", output: { type: "json", value } },
        ],
      },
    ])
  })

  test("pairs incomplete native search with an interruption error, never success or prose", () => {
    expect(
      nativeReplay([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              providerExecuted: true,
              toolCallId: "search",
              toolName: "websearch",
              input: { query: "Bun" },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "search", toolName: "websearch", input: { query: "Bun" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search",
            toolName: "websearch",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test.each([false, true])(
    "pairs results across assistant messages even with call metadata stripped=%s",
    (stripped) => {
      const output = { type: "json" as const, value: { results: [{ snippet: "Exact result" }], extra: null } }
      const result = nativeReplay([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "search",
              toolName: "websearch",
              input: { query: "Bun" },
              ...(stripped ? {} : { providerExecuted: true, providerOptions: { openai: { itemId: "ws_original" } } }),
            },
          ],
        },
        { role: "assistant", content: [{ type: "tool-result", toolCallId: "search", toolName: "websearch", output }] },
      ])
      expect(result).toEqual([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "search", toolName: "websearch", input: { query: "Bun" } }],
        },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "search", toolName: "websearch", output }] },
      ])
      const message = result[1]
      if (message.role !== "tool") throw new Error("Expected tool result")
      expect(message.content[0].output).toBe(output)
    },
  )
})

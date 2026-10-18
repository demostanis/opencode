import { describe, expect, test } from "bun:test"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"
import { nativeReplay } from "../../src/session/native-replay"

describe("nativeReplay", () => {
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

  test("keeps search actions and sources as text without native IDs", () => {
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
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: `websearch: ${JSON.stringify(value)}` }] }])
  })

  test("keeps incomplete provider calls as text, never fake function calls", () => {
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
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: 'websearch: {"query":"Bun"}' }] }])
  })
})

import { describe, expect, test } from "bun:test"
import { APICallError, generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("drops history before latest completed compaction", () => {
    const summary = assistantInfo("m-summary", "m-compact")
    summary.summary = true
    summary.finish = "stop"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-old-user"),
        parts: [
          {
            ...basePart("m-old-user", "p1"),
            type: "text",
            text: "old user text",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-old-assistant", "m-old-user"),
        parts: [
          {
            ...basePart("m-old-assistant", "p2"),
            type: "text",
            text: "old assistant text",
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo("m-compact"),
        parts: [
          {
            ...basePart("m-compact", "p3"),
            type: "compaction",
            auto: false,
          },
        ] as MessageV2.Part[],
      },
      {
        info: summary,
        parts: [
          {
            ...basePart("m-summary", "p4"),
            type: "text",
            text: "summary text",
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo("m-new-user"),
        parts: [
          {
            ...basePart("m-new-user", "p5"),
            type: "text",
            text: "new user text",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "What did we do so far?" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "summary text" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user text" }],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("strips reasoning parts when requested", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "hidden chain",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "visible answer",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model, { stripReasoning: true })).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })
})

describe("session.message-v2 native replay", () => {
  function history(tool = "websearch", native: unknown = { action: { type: "search", query: "Bun" } }) {
    const part: MessageV2.ToolPart = {
      ...basePart("m-native", "p-native"),
      type: "tool",
      tool,
      callID: "native-item",
      metadata: { providerExecuted: true, openai: { itemId: "native-item" } },
      state: {
        status: "completed",
        input: {},
        output: tool === "image_generation" ? "Generated image: /tmp/generated.png" : "Found Bun documentation",
        title: tool,
        metadata: { native },
        time: { start: 0, end: 1 },
        ...(tool === "image_generation"
          ? {
              attachments: [
                {
                  ...basePart("m-native", "p-image"),
                  type: "file" as const,
                  mime: "image/png",
                  url: "file:///tmp/generated.png",
                },
              ],
            }
          : {}),
      },
    }
    const input: MessageV2.WithParts[] = [{ info: assistantInfo("m-native", "m-user"), parts: [part] }]
    return { part, input }
  }

  test.each([["image_generation", { result: "Zm9v" }]])(
    "preserves raw %s output as an assistant JSON result without duplicate attachments",
    (tool, native) => {
      const fixture = history(tool, native)
      expect(MessageV2.toModelMessages(fixture.input, model)).toEqual([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "native-item",
              toolName: tool,
              input: {},
              providerExecuted: true,
              providerOptions: { openai: { itemId: "native-item" } },
            },
            {
              type: "tool-result",
              toolCallId: "native-item",
              toolName: tool,
              output: { type: "json", value: native },
              providerOptions: { openai: { itemId: "native-item" } },
            },
          ],
        },
      ])
    },
  )

  test.each([false, true])("serializes whole stored search results with paired call IDs, store=%s", async (store) => {
    const native = {
      id: "ws_original",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "Bun",
        queries: ["Bun"],
        sources: [{ type: "url", url: "https://bun.sh", extra: null }],
      },
      results: [{ type: "text_result", snippet: "Exact snippet\n", title: "Bun", url: "https://bun.sh" }],
      extra: { untouched: [null, 7] },
    }
    const requests: Record<string, unknown>[] = []
    const sdk = createOpenAI({
      apiKey: "test",
      fetch: Object.assign(
        async (_: RequestInfo | URL, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)))
          return Response.json({
            id: "resp-test",
            created_at: 0,
            model: "gpt-4.1",
            output: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    for (const target of [
      model,
      { ...model, id: ModelID.make("other") },
      { ...model, providerID: ProviderID.make("other") },
    ]) {
      const fixture = history("websearch", native)
      const messages = MessageV2.toModelMessages(fixture.input, target)
      expect(JSON.stringify(messages)).not.toContain("websearch:")
      expect(messages).toMatchObject([
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "native-item", toolName: "websearch" }] },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "native-item", output: { type: "json", value: native } }],
        },
      ])
      await generateText({ model: sdk.responses("gpt-4.1"), messages, providerOptions: { openai: { store } } })
      expect(requests.at(-1)?.input).toEqual([
        { type: "function_call", call_id: "native-item", name: "websearch", arguments: "{}" },
        { type: "function_call_output", call_id: "native-item", output: JSON.stringify(native) },
      ])
    }
  })

  test.each([
    [],
    [{ type: "web_search_call", action: { type: "search", query: "Bun" }, extra: null }],
    [{ type: "web_search_call", results: [{ snippet: "Exact\n", extra: [null, 42] }] }],
  ])(
    "local search retains summary and raw items, preserving Gemini signatures and parallel calls: %j",
    async (...items) => {
      const native = { backend: "codex", items }
      const fixture = history("websearch", native)
      fixture.part.metadata = { google: { thoughtSignature: "signed-call" } }
      fixture.input[0].parts.push({
        ...fixture.part,
        id: PartID.make("parallel"),
        callID: "parallel",
        tool: "bash",
        metadata: undefined,
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      })
      const messages = MessageV2.toModelMessages(fixture.input, model)
      expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
      expect(messages[0]).toMatchObject({
        content: [
          {
            type: "tool-call",
            toolCallId: "native-item",
            providerOptions: { google: { thoughtSignature: "signed-call" } },
          },
          { type: "tool-call", toolCallId: "parallel" },
        ],
      })
      const value = { output: "Found Bun documentation", native }
      expect(messages[1]).toMatchObject({
        content: [
          { type: "tool-result", toolCallId: "native-item", output: { type: "json", value } },
          { type: "tool-result", toolCallId: "parallel" },
        ],
      })
      const requests: Record<string, unknown>[] = []
      const sdk = createGoogleGenerativeAI({
        apiKey: "test",
        fetch: Object.assign(
          async (_: RequestInfo | URL, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)))
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            })
          },
          { preconnect: fetch.preconnect },
        ),
      })
      await generateText({ model: sdk("gemini-3-pro-preview"), messages })
      expect(requests[0].contents).toMatchObject([
        {
          role: "model",
          parts: [
            { functionCall: { name: "websearch", args: {} }, thoughtSignature: "signed-call" },
            { functionCall: { name: "bash", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "websearch", response: { name: "websearch", content: value } } },
            { functionResponse: { name: "bash" } },
          ],
        },
      ])
      const switched = MessageV2.toModelMessages(fixture.input, { ...model, id: ModelID.make("other") })
      expect(JSON.stringify(switched)).not.toContain("signed-call")
      expect(switched.map((message) => message.role)).toEqual(["assistant", "tool"])
    },
  )

  test.each(["error", "pending", "running"] as const)(
    "native search %s replays a matched error, not assistant prose",
    async (status) => {
      const fixture = history()
      fixture.part.state =
        status === "error"
          ? { status, input: { query: "Bun" }, error: "Search failed", time: { start: 0, end: 1 } }
          : status === "pending"
            ? { status, input: { query: "Bun" }, raw: "" }
            : { status, input: { query: "Bun" }, time: { start: 0 } }
      for (const target of [model, { ...model, id: ModelID.make("other") }]) {
        const messages = MessageV2.toModelMessages(fixture.input, target)
        expect(JSON.stringify(messages)).not.toContain("websearch:")
        expect(messages).toMatchObject([
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "native-item", toolName: "websearch" }] },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "native-item",
                output: {
                  type: "error-text",
                  value: status === "error" ? "Search failed" : "[Tool execution was interrupted]",
                },
              },
            ],
          },
        ])
        const requests: Record<string, unknown>[] = []
        const sdk = createOpenAI({
          apiKey: "test",
          fetch: Object.assign(
            async (_: RequestInfo | URL, init?: RequestInit) => {
              requests.push(JSON.parse(String(init?.body)))
              return Response.json({
                id: "resp-test",
                created_at: 0,
                model: "gpt-4.1",
                output: [],
                usage: { input_tokens: 0, output_tokens: 0 },
              })
            },
            { preconnect: fetch.preconnect },
          ),
        })
        await generateText({ model: sdk.responses("gpt-4.1"), messages, providerOptions: { openai: { store: false } } })
        expect(requests[0].input).toEqual([
          { type: "function_call", call_id: "native-item", name: "websearch", arguments: '{"query":"Bun"}' },
          {
            type: "function_call_output",
            call_id: "native-item",
            output: status === "error" ? "Search failed" : "[Tool execution was interrupted]",
          },
        ])
      }
    },
  )

  test("keeps search results before later reasoning, text, and calls in the same step", () => {
    const fixture = history()
    fixture.input[0].parts.unshift({
      ...basePart("m-native", "p-before"),
      type: "reasoning",
      text: "Before",
      time: { start: 0, end: 1 },
      metadata: { openai: { itemId: "rs_before" } },
    })
    fixture.input[0].parts.push(
      {
        ...basePart("m-native", "p-after"),
        type: "reasoning",
        text: "After",
        time: { start: 2, end: 3 },
        metadata: { openai: { itemId: "rs_after" } },
      },
      { ...basePart("m-native", "p-text"), type: "text", text: "After result" },
      {
        ...fixture.part,
        ...basePart("m-native", "p-local"),
        callID: "local",
        tool: "bash",
        metadata: undefined,
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "bash",
          metadata: {},
          time: { start: 2, end: 3 },
        },
      },
    )
    const messages = MessageV2.toModelMessages(fixture.input, model)
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"])
    expect(messages[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "Before" },
        { type: "tool-call", toolCallId: "native-item" },
      ],
    })
    expect(messages[1]).toMatchObject({ content: [{ type: "tool-result", toolCallId: "native-item" }] })
    expect(messages[2]).toMatchObject({
      content: [
        { type: "reasoning", text: "After" },
        { type: "text", text: "After result" },
        { type: "tool-call", toolCallId: "local" },
      ],
    })
    expect(messages[3]).toMatchObject({ content: [{ type: "tool-result", toolCallId: "local" }] })
  })

  test.each(["image_generation"])("uses Responses item references for %s, never function outputs", async (tool) => {
    const fixture = history(
      tool,
      tool === "image_generation" ? { result: "Zm9v" } : { action: { type: "search", query: "Bun" } },
    )
    const requests: Record<string, unknown>[] = []
    const provider = createOpenAI({
      apiKey: "test",
      fetch: Object.assign(
        async (_url: URL | RequestInfo, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)))
          return Response.json({
            id: "resp-test",
            created_at: 0,
            model: "gpt-4.1",
            output: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    for (const store of [true, false]) {
      const result = await generateText({
        model: provider.responses("gpt-4.1"),
        messages: MessageV2.toModelMessages(fixture.input, model),
        providerOptions: { openai: { store } },
      })
      expect(requests.at(-1)?.input).toEqual(store ? [{ type: "item_reference", id: "native-item" }] : [])
      if (!store)
        expect(result.warnings).toContainEqual({
          type: "other",
          message: `Results for OpenAI tool ${tool} are not sent to the API when store is false`,
        })
    }
  })

  test.each([
    { ...model, id: ModelID.make("other") },
    { ...model, providerID: ProviderID.make("other") },
  ])("uses portable text/media without native IDs on a model/provider switch: %j", (target) => {
    const search = history()
    expect(MessageV2.toModelMessages(search.input, target)).toEqual(MessageV2.toModelMessages(search.input, model))
    expect(JSON.stringify(MessageV2.toModelMessages(search.input, target))).not.toContain("websearch:")
    const image = history("image_generation", { result: "Zm9v" })
    expect(MessageV2.toModelMessages(image.input, target)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "image_generation: Generated image: /tmp/generated.png" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "file", mediaType: "image/png", data: "data:image/png;base64,Zm9v" },
        ],
      },
    ])
  })

  test("does not restore native bytes or attachments when compacted or stripping media", () => {
    const fixture = history("image_generation", { result: "Zm9v" })
    expect(MessageV2.toModelMessages(fixture.input, model, { stripMedia: true })).toEqual([
      { role: "assistant", content: [{ type: "text", text: "image_generation: Generated image: /tmp/generated.png" }] },
    ])
    if (fixture.part.state.status !== "completed") throw new Error("Expected completed tool")
    fixture.part.state.time.compacted = 1
    expect(MessageV2.toModelMessages(fixture.input, model)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "image_generation: [Old tool result content cleared]" }] },
    ])
  })

  test("keeps legacy completed search results as tool output without raw fields", () => {
    const fixture = history()
    if (fixture.part.state.status !== "completed") throw new Error("Expected completed tool")
    fixture.part.state.metadata = {}
    expect(MessageV2.toModelMessages(fixture.input, model)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "native-item", toolName: "websearch", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "native-item",
            toolName: "websearch",
            output: { type: "text", value: "Found Bun documentation" },
          },
        ],
      },
    ])
  })

  test("keeps local and native calls with the same tool name separate across steps", () => {
    const fixture = history()
    fixture.input[0].parts.push(
      { ...basePart("m-native", "p-step"), type: "step-start" },
      {
        ...fixture.part,
        ...basePart("m-native", "p-local"),
        callID: "local-call",
        metadata: undefined,
        state: {
          status: "completed",
          input: { query: "Bun" },
          output: "Local search result",
          title: "Local search",
          metadata: {},
          time: { start: 2, end: 3 },
        },
      },
    )
    const messages = MessageV2.toModelMessages(fixture.input, model)
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"])
    expect(messages[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "local-call",
          toolName: "websearch",
          output: { type: "text", value: "Local search result" },
        },
      ],
    })
    expect(messages[0]).toMatchObject({
      content: [{ type: "tool-call", toolCallId: "native-item", toolName: "websearch", input: {} }],
    })
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "json", value: { action: { type: "search", query: "Bun" } } } }],
    })
  })

  test.each(["pending", "running", "error"] as const)("keeps native image fallback for %s tools", (status) => {
    const fixture = history("image_generation")
    fixture.part.state =
      status === "pending"
        ? { status, input: {}, raw: "" }
        : status === "running"
          ? { status, input: {}, time: { start: 0 } }
          : { status, input: {}, error: "Native search failed", time: { start: 0, end: 1 } }
    expect(MessageV2.toModelMessages(fixture.input, model)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `image_generation: ${status === "error" ? "Native search failed" : "[Tool execution was interrupted]"}`,
          },
        ],
      },
    ])
  })
})

describe("session.message-v2.filterCompacted", () => {
  test("preserves deferred turns that are pending or answered after compaction", async () => {
    const deferred = (id: string, part: string) => {
      const info = userInfo(id)
      info.deferred = true
      return {
        info,
        parts: [
          {
            ...basePart(id, part),
            type: "text" as const,
            text: id,
          },
        ],
      }
    }
    const handled = assistantInfo("m-old-reply", "m-old")
    handled.finish = "stop"
    const summary = assistantInfo("m-summary", "m-compact")
    summary.summary = true
    summary.finish = "stop"
    const recent = assistantInfo("m-recent-reply", "m-recent")
    recent.finish = "stop"
    const input: MessageV2.WithParts[] = [
      deferred("m-old", "p-old"),
      {
        info: handled,
        parts: [{ ...basePart("m-old-reply", "p-old-reply"), type: "text", text: "handled" }],
      },
      deferred("m-recent", "p-recent"),
      deferred("m-pending", "p-pending"),
      {
        info: userInfo("m-compact"),
        parts: [{ ...basePart("m-compact", "p-compact"), type: "compaction", auto: true }],
      },
      {
        info: summary,
        parts: [{ ...basePart("m-summary", "p-summary"), type: "text", text: "summary" }],
      },
      {
        info: recent,
        parts: [{ ...basePart("m-recent-reply", "p-recent-reply"), type: "text", text: "recent" }],
      },
    ]
    async function* stream() {
      for (const msg of input.toReversed()) yield msg
    }

    const result = await MessageV2.filterCompacted(stream())

    expect(result.map((msg) => msg.info.id)).toEqual([
      MessageID.make("m-recent"),
      MessageID.make("m-pending"),
      MessageID.make("m-compact"),
      MessageID.make("m-summary"),
      MessageID.make("m-recent-reply"),
    ])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })
})

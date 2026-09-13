import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Tracker } from "../../../src/cli/cmd/tui/voice/tracker"
import { Command } from "../../../src/cli/cmd/tui/voice/protocol"

function assistant(opts: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "assistant",
    sessionID: "session",
    parentID: "user",
    role: "assistant",
    time: { created: 2, completed: 3 },
    finish: "stop",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...opts,
  }
}

function text(opts: Partial<TextPart> = {}): TextPart {
  return {
    id: "text",
    sessionID: "session",
    messageID: "assistant",
    type: "text",
    text: "All done.",
    time: { start: 2, end: 3 },
    ...opts,
  }
}

function tool(opts: Partial<ToolPart> = {}): ToolPart {
  return {
    id: "tool",
    sessionID: "session",
    messageID: "assistant",
    type: "tool",
    callID: "call",
    tool: "bash",
    state: {
      status: "completed",
      input: { secret: "private args" },
      output: "private output",
      title: "private title",
      metadata: {},
      time: { start: 2, end: 3 },
    },
    ...opts,
  }
}

function fixture(messages = [assistant()], parts: Part[] = [text()]) {
  const tracker = Tracker.create()
  const snapshot: Tracker.Snapshot = {
    message: { session: messages },
    part: { assistant: parts },
    session_status: { session: { type: "idle" } },
    permission: {},
    question: {},
  }
  tracker.add("voice", { sessionID: "session", messageID: "user" })
  return { tracker, snapshot }
}

describe("voice tracker", () => {
  test("updates before receipt binding do not consume a completed answer", () => {
    const { tracker, snapshot } = fixture()
    tracker.clear()
    expect(tracker.update(snapshot, 0)).toEqual([])
    tracker.add("late", { sessionID: "session", messageID: "user" })
    expect(tracker.update(snapshot, 1)).toEqual([{ type: "result", id: "late", text: "All done.", final: true }])
  })

  test("unrelated requests cannot block or narrate a matching answer", () => {
    const { tracker, snapshot } = fixture()
    snapshot.permission.session = [
      {
        id: "unrelated",
        sessionID: "session",
        permission: "bash",
        patterns: [],
        always: [],
        metadata: {},
        tool: { messageID: "other-parent-assistant", callID: "call" },
      },
    ]
    snapshot.question.session = [{ id: "child", sessionID: "child", questions: [] }]
    expect(tracker.update(snapshot, 0)[0]).toMatchObject({ text: "All done.", final: true })
  })

  test("finals work from already populated snapshots and deduplicate receipts", () => {
    const { tracker, snapshot } = fixture()
    tracker.add("voice", { sessionID: "other", messageID: "other" })
    expect(tracker.update(snapshot, 0)).toEqual([{ type: "result", id: "voice", text: "All done.", final: true }])
    tracker.add("voice", { sessionID: "session", messageID: "user" })
    expect(tracker.update(snapshot, 10_000)).toEqual([])
    expect(tracker.size()).toBe(0)
  })

  test("tool-calls, unknown, unfinished and idle are not final", () => {
    for (const message of [
      assistant({ finish: "tool-calls" }),
      assistant({ finish: "unknown" }),
      assistant({ finish: undefined }),
      assistant({ time: { created: 2 } }),
    ]) {
      const { tracker, snapshot } = fixture([message])
      expect(tracker.update(snapshot, 0)).toEqual([])
      expect(tracker.update(snapshot, 20_000)).toEqual([])
      expect(tracker.size()).toBe(1)
    }
  })

  test("wrong sessions, children, parents, summaries and part ownership are excluded", () => {
    const { tracker, snapshot } = fixture([
      assistant({ sessionID: "child" }),
      assistant({ parentID: "old-user" }),
      assistant({ summary: true }),
    ])
    snapshot.message.other = [assistant()]
    expect(tracker.update(snapshot, 0)).toEqual([])
    snapshot.message.session = [assistant()]
    snapshot.part.assistant = [text({ sessionID: "child" }), text({ messageID: "old" })]
    expect(tracker.update(snapshot, 1)).toEqual([])
    snapshot.part.assistant = [text()]
    expect(tracker.update(snapshot, 2)[0]).toMatchObject({ text: "All done.", final: true })
  })

  test("latest step wins even with unordered snapshots and a newer streaming step", () => {
    const { tracker, snapshot } = fixture([assistant({ id: "new", time: { created: 4 } }), assistant()])
    expect(tracker.update(snapshot, 0)).toEqual([])
    snapshot.message.session[0] = assistant({ id: "new", time: { created: 4, completed: 5 } })
    snapshot.part.new = [text({ messageID: "new", text: "Newest answer" })]
    expect(tracker.update(snapshot, 1)[0]).toMatchObject({ text: "Newest answer", final: true })
  })

  test("missing and streaming parts wait despite idle; empty terminals settle", () => {
    const { tracker, snapshot } = fixture()
    delete snapshot.part.assistant
    expect(tracker.update(snapshot, 0)).toEqual([])
    expect(tracker.update(snapshot, 20_000)).toEqual([])
    snapshot.part.assistant = [text({ time: { start: 2 } })]
    expect(tracker.update(snapshot, 30_000)).toEqual([])
    expect(tracker.update(snapshot, 50_000)).toEqual([])
    snapshot.part.assistant = [text()]
    expect(tracker.update(snapshot, 50_001)[0]).toMatchObject({ final: true, text: "All done." })
    const empty = fixture([assistant()], [])
    expect(empty.tracker.update(empty.snapshot, 0)).toEqual([])
    empty.snapshot.session_status.session = { type: "busy" }
    empty.tracker.update(empty.snapshot, 9_000)
    empty.snapshot.session_status.session = { type: "idle" }
    expect(empty.tracker.update(empty.snapshot, 10_000)).toEqual([])
    expect(empty.tracker.update(empty.snapshot, 19_999)).toEqual([])
    expect(empty.tracker.update(empty.snapshot, 20_000)[0]).toMatchObject({ final: true })
  })

  test("permissions and questions direct to TUI and prevent empty finalization", () => {
    const { tracker, snapshot } = fixture([assistant()], [])
    snapshot.permission.session = [
      {
        id: "permission",
        sessionID: "session",
        permission: "bash",
        patterns: ["secret"],
        always: [],
        metadata: {},
        tool: { messageID: "assistant", callID: "call" },
      },
    ]
    expect(tracker.update(snapshot, 0)[0]).toMatchObject({
      final: false,
      text: "OpenCode needs a permission response. Please respond in the TUI.",
    })
    expect(tracker.update(snapshot, 20_000)).toEqual([])
    snapshot.permission.session = []
    snapshot.question.session = [{ id: "question", sessionID: "session", questions: [] }]
    expect(tracker.update(snapshot, 20_001)[0]).toMatchObject({
      final: false,
      text: "OpenCode needs a question response. Please respond in the TUI.",
    })
    snapshot.question.session = []
    snapshot.part.assistant = [text()]
    expect(tracker.update(snapshot, 20_002)[0]).toMatchObject({ final: true })
  })

  test("tool progress is factual, rate limited, and never reads arguments or output", () => {
    const { tracker, snapshot } = fixture([assistant({ finish: "tool-calls" })], [tool()])
    expect(tracker.update(snapshot, 0)).toEqual([
      { type: "result", id: "voice", text: "Tool bash completed.", final: false },
    ])
    snapshot.part.assistant.push(
      tool({
        id: "failed",
        tool: "read",
        state: { status: "error", input: {}, error: "secret", time: { start: 4, end: 5 } },
      }),
    )
    expect(tracker.update(snapshot, 9_999)).toEqual([])
    expect(tracker.update(snapshot, 10_000)[0]).toMatchObject({ text: "Tool read failed.", final: false })
    expect(tracker.update(snapshot, 30_000)).toEqual([])
    snapshot.message.session.push(assistant({ id: "final", time: { created: 6, completed: 7 } }))
    snapshot.part.final = [text({ messageID: "final" })]
    expect(tracker.update(snapshot, 30_001)[0]).toMatchObject({ final: true })
  })

  test("busy is deduplicated and does not suppress a final", () => {
    const { tracker, snapshot } = fixture([])
    snapshot.session_status.session = { type: "busy" }
    expect(tracker.update(snapshot, 0)[0]).toMatchObject({ final: false })
    expect(tracker.update(snapshot, 10_000)).toEqual([])
    snapshot.message.session = [assistant()]
    expect(tracker.update(snapshot, 10_001)[0]).toMatchObject({ final: true })
  })

  test("backend and event errors are safe and session scoped", () => {
    const { tracker, snapshot } = fixture([
      assistant({
        finish: undefined,
        error: { name: "APIError", data: { message: "secret", responseBody: "secret", isRetryable: false } },
      }),
    ])
    expect(tracker.update(snapshot, 0)[0]).toMatchObject({
      final: true,
      text: "OpenCode could not complete this request. Check the TUI for details.",
    })
    tracker.add("second", { sessionID: "second", messageID: "user" })
    expect(tracker.error("session", "secret")).toEqual([])
    expect(tracker.error("second", "secret")[0]).toMatchObject({
      id: "second",
      final: true,
      text: "OpenCode could not complete this request. Check the TUI for details.",
    })
    expect(tracker.error("second", "secret")).toEqual([])
  })

  test("only public completed text is spoken, including commentary; finals are capped", () => {
    const { tracker, snapshot } = fixture(
      [assistant()],
      [
        text({ text: "secret", metadata: { channel: "analysis" } }),
        text({ text: "secret", metadata: { private: true } }),
        text({ text: "secret", ignored: true }),
        text({ text: "secret", synthetic: true }),
        {
          id: "reasoning",
          messageID: "assistant",
          sessionID: "session",
          type: "reasoning",
          text: "secret",
          time: { start: 2, end: 3 },
        },
        tool(),
        text({ text: "Public", metadata: { channel: "commentary" } }),
        text({ text: "x".repeat(40_000) }),
      ],
    )
    const result = tracker.update(snapshot, 0)[0]
    expect(Command.safeParse(result).success).toBe(true)
    if (result.type !== "result") throw new Error("Expected result")
    expect(result.text.startsWith("Public\n\n")).toBe(true)
    expect(result.text).not.toContain("secret")
    expect(result.text).not.toContain("private")
    expect(result.text.length).toBeLessThanOrEqual(12_000)
    expect(result.text).toContain("[Truncated;")
  })

  test("capacity, timeout, completed-id retention and clear are bounded", () => {
    const tracker = Tracker.create()
    for (let n = 0; n < 20; n++) tracker.add(String(n), { sessionID: "session", messageID: "user" })
    expect(tracker.size()).toBe(8)
    const snapshot: Tracker.Snapshot = { message: {}, part: {}, permission: {}, question: {}, session_status: {} }
    expect(tracker.update(snapshot, 0)).toEqual([])
    expect(tracker.update(snapshot, 30 * 60_000)).toHaveLength(8)
    expect(tracker.size()).toBe(0)
    for (let n = 20; n < 300; n++) {
      tracker.add(String(n), { sessionID: "session", messageID: "user" })
      tracker.error("session", "error")
    }
    tracker.add("0", { sessionID: "session", messageID: "user" })
    expect(tracker.size()).toBe(1)
    tracker.clear()
    expect(tracker.size()).toBe(0)
    tracker.add("299", { sessionID: "session", messageID: "user" })
    expect(tracker.size()).toBe(1)
  })
})

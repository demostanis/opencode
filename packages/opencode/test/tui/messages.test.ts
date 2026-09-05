import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { order } from "../../src/cli/cmd/tui/routes/session/messages"

function user(id: string, deferred = false): UserMessage {
  return {
    id,
    sessionID: "session",
    role: "user",
    time: { created: 0 },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    deferred: deferred || undefined,
  }
}

function assistant(id: string, parentID: string): AssistantMessage {
  return {
    id,
    parentID,
    sessionID: "session",
    role: "assistant",
    time: { created: 0 },
    agent: "test",
    mode: "test",
    providerID: "test",
    modelID: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("TUI message order", () => {
  test("keeps normal messages in queue order", () => {
    const messages = [user("1"), assistant("2", "1"), user("3"), user("4")]
    expect(order(messages)).toBe(messages)
  })

  test("places pending deferred messages after the normal queue in FIFO order", () => {
    const messages = [user("1"), user("2", true), assistant("3", "1"), user("4", true), user("5")]
    expect(order(messages).map((msg) => msg.id)).toEqual(["1", "3", "5", "2", "4"])
    expect(messages.map((msg) => msg.id)).toEqual(["1", "2", "3", "4", "5"])
  })

  test("preserves deferred order before any assistant responds", () => {
    expect(order([user("1", true), user("2"), user("3", true)]).map((msg) => msg.id)).toEqual(["2", "1", "3"])
  })

  test("places answered deferred messages immediately before their first reply", () => {
    const messages = [
      user("1"),
      user("2", true),
      user("3", true),
      assistant("4", "1"),
      assistant("5", "3"),
      assistant("6", "3"),
      user("7"),
    ]
    expect(order(messages).map((msg) => msg.id)).toEqual(["1", "4", "3", "5", "6", "7", "2"])
  })

  test("keeps a promoted message at the queue tail ahead of remaining deferred messages", () => {
    const messages = [user("1"), assistant("2", "1"), user("3", true), user("4"), user("5")]
    expect(order(messages).map((msg) => msg.id)).toEqual(["1", "2", "4", "5", "3"])
  })
})

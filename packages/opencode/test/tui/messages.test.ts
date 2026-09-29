import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { order, retain } from "../../src/cli/cmd/tui/routes/session/messages"

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

describe("TUI search history retention", () => {
  test("keeps a bounded recent window plus the selected older message and parent", () => {
    const messages = Array.from({ length: 120 }, (_, index) => user(String(index)))
    const kept = retain(messages, new Set(["2", "3"]))
    expect(kept).toHaveLength(102)
    expect(kept.slice(0, 3).map((msg) => msg.id)).toEqual(["2", "3", "20"])
    expect(kept.at(-1)?.id).toBe("119")
    expect(messages).toHaveLength(120)
  })

  test("releases old hits when another search result is selected", () => {
    const messages = Array.from({ length: 120 }, (_, index) => user(String(index)))
    const kept = retain(messages, new Set(["2", "3"]))
    expect(retain(kept, new Set(["21"]))).toEqual(messages.slice(-100))
  })

  test("preserves the selected hit while new messages arrive", () => {
    const messages = Array.from({ length: 120 }, (_, index) => user(String(index)))
    const kept = retain([...retain(messages, new Set(["2"])), user("120")], new Set(["2"]))
    expect(kept).toHaveLength(101)
    expect(kept[0].id).toBe("2")
    expect(kept[1].id).toBe("21")
    expect(kept.at(-1)?.id).toBe("120")
  })

  test("does not duplicate hits inside the recent window", () => {
    const messages = Array.from({ length: 120 }, (_, index) => user(String(index)))
    expect(retain(messages, new Set(["110"]))).toEqual(messages.slice(-100))
    expect(retain(messages.slice(-10), new Set())).toHaveLength(10)
  })
})

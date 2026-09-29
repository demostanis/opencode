import { expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { live } from "../../src/cli/cmd/tui/util/search"

const message: AssistantMessage = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1 },
  parentID: "msg_0",
  agent: "test",
  mode: "test",
  providerID: "test",
  modelID: "test",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("searches unsaved streaming dialogue without exposing reasoning", () => {
  const parts: Record<string, Part[]> = {
    [message.id]: [
      { id: "prt_1", messageID: message.id, sessionID: message.sessionID, type: "text", text: "streaming NEEDLE" },
      {
        id: "prt_2",
        messageID: message.id,
        sessionID: message.sessionID,
        type: "reasoning",
        text: "reasoning needle",
        time: { start: 1 },
      },
    ],
  }
  const hits = live([message], parts, "needle")
  expect(hits.map((hit) => hit.partID)).toEqual(["prt_1"])
  expect(hits[0].preview).toContain("NEEDLE")
  expect(live([message], parts, "ab")).toEqual([])
  expect(live([message], parts, "not found")).toEqual([])
})

test("does not scan completed messages or include ignored and reverted content", () => {
  const parts: Record<string, Part[]> = {
    [message.id]: [
      {
        id: "prt_1",
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text: "synthetic needle",
        synthetic: true,
      },
      {
        id: "prt_2",
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text: "ignored needle",
        ignored: true,
      },
      { id: "prt_3", messageID: message.id, sessionID: message.sessionID, type: "text", text: "visible needle" },
    ],
  }
  expect(live([message], parts, "needle").map((hit) => hit.partID)).toEqual(["prt_3"])
  expect(live([{ ...message, time: { created: 1, completed: 2 } }], parts, "needle")).toEqual([])
  expect(live([message], parts, "needle", message.id)).toEqual([])
})

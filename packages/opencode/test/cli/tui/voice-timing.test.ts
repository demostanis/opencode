import { expect, test } from "bun:test"
import { VoiceEvent } from "../../../src/cli/cmd/tui/voice/protocol"

test("voice timings carry bounded metadata, never transcript or credentials", () => {
  const event = { type: "timing", event: "delegation.created", at: Date.now(), id: "job" }
  expect(VoiceEvent.safeParse(event).success).toBe(true)
  for (const fields of [
    { text: "private" },
    { headers: {} },
    { at: Infinity },
    { id: "x".repeat(257) },
    { event: "arbitrary" },
  ]) {
    expect(VoiceEvent.safeParse({ ...event, ...fields }).success).toBe(false)
  }
})

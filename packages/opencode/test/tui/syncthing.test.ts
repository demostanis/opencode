import { expect, test } from "bun:test"
import type { SyncthingStatus } from "@opencode-ai/sdk/v2"
import { poll } from "../../src/cli/cmd/tui/routes/session/syncthing"

test("poll failures clear stale health and cleanup aborts without rescheduling", async () => {
  const states: SyncthingStatus[] = []
  const signals: AbortSignal[] = []
  const stop = poll(
    async (signal) => {
      signals.push(signal)
      if (signals.length === 1) return { state: "enabled", disconnected: [] }
      throw new Error("offline")
    },
    (status) => states.push(status),
    5,
  )
  try {
    while (states.length < 2) await Bun.sleep(1)
    expect(states[0].state).toBe("enabled")
    expect(states[1].state).toBe("unavailable")
  } finally {
    stop()
  }
  const count = signals.length
  await Bun.sleep(20)
  expect(signals).toHaveLength(count)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test("cleanup aborts an in-flight poll and prevents late updates", async () => {
  const states: SyncthingStatus[] = []
  const signals: AbortSignal[] = []
  const stop = poll(
    async (signal) => {
      signals.push(signal)
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return { state: "enabled", disconnected: [] }
    },
    (status) => states.push(status),
    5,
  )
  stop()
  await Bun.sleep(20)
  expect(signals).toHaveLength(1)
  expect(signals[0].aborted).toBe(true)
  expect(states).toEqual([])
})

test("poll requests time out without overlapping", async () => {
  const states: SyncthingStatus[] = []
  let calls = 0
  const stop = poll(
    async (signal) => {
      calls++
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      )
      throw new Error("unreachable")
    },
    (status) => states.push(status),
    100,
    5,
  )
  try {
    while (!states.length) await Bun.sleep(1)
    expect(states[0].state).toBe("unavailable")
    expect(calls).toBe(1)
  } finally {
    stop()
  }
})

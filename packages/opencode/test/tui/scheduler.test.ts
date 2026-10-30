import { expect, test } from "bun:test"
import type { SessionSyncStatus } from "@opencode-ai/sdk/v2"
import { describe, watch } from "../../src/cli/cmd/tui/routes/session/scheduler"

const status: SessionSyncStatus = {
  state: "enabled",
  owner: true,
  running: false,
  next: 31_000,
  timestamp: 1_000,
  exported: 0,
}

test("countdown uses server time and elapsed duration, not the client wall clock", () => {
  expect(describe(status).timing).toBe("Next sync in 30 seconds (session files)")
  expect(describe(status, 1_001).timing).toBe("Next sync in 29 seconds (session files)")
  const timestamp = Date.now() + 3_600_000
  expect(describe({ ...status, timestamp, next: timestamp + 30_000 }).timing).toBe(
    "Next sync in 30 seconds (session files)",
  )
  expect(describe({ ...status, next: 1_001 }, 1_000).timing).toBe("Awaiting scheduler...")
  expect(describe(status, 16_000).timing).toBe("Scheduler status stale")
})

test("the one-second local timer advances the displayed countdown between status refreshes", async () => {
  const views: ReturnType<typeof describe>[] = []
  let calls = 0
  const stop = watch(
    async () => {
      calls++
      return status
    },
    (view) => views.push(view),
  )
  try {
    while (!views.some((view) => view.timing === "Next sync in 29 seconds (session files)")) await Bun.sleep(10)
    expect(views[1].timing).toBe("Next sync in 30 seconds (session files)")
    expect(views.at(-1)!.timing).toBe("Next sync in 29 seconds (session files)")
    expect(calls).toBe(1)
  } finally {
    stop()
  }
})

test("followers show next check, while owners distinguish running, disabled and unavailable", () => {
  expect(describe({ ...status, owner: false })).toEqual({
    master: "Sync master: no (another instance)",
    timing: "Next check in 30 seconds",
  })
  expect(describe({ ...status, running: true }).timing).toBe("Sync running (session files)")
  expect(describe({ ...status, next: null }).timing).toBe("No check scheduled")
  expect(describe({ ...status, state: "disabled", owner: null }).master).toBe("Sync master: no (disabled)")
  expect(describe(undefined).master).toBe("Sync master: unknown")
  expect(describe({ ...status, state: "unavailable" }).timing).toBe("Scheduler unavailable")
})

test("local ticks do not poll each second and cleanup stops timers and aborts requests", async () => {
  const views: ReturnType<typeof describe>[] = []
  const signals: AbortSignal[] = []
  const stop = watch(
    async (signal) => {
      signals.push(signal)
      return status
    },
    (view) => views.push(view),
    10_000,
    10,
  )
  try {
    while (views.length < 4) await Bun.sleep(5)
    expect(signals).toHaveLength(1)
    expect(views.at(-1)!.timing).toBe("Next sync in 30 seconds (session files)")
  } finally {
    stop()
  }
  const count = views.length
  await Bun.sleep(30)
  expect(views).toHaveLength(count)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test("poll failure clears ownership and cleanup ignores an in-flight response", async () => {
  const views: ReturnType<typeof describe>[] = []
  let calls = 0
  const stop = watch(
    async (signal) => {
      calls++
      if (calls === 1) return status
      if (calls === 2) throw new Error("offline")
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return status
    },
    (view) => views.push(view),
    5,
    10,
  )
  try {
    while (calls < 3) await Bun.sleep(1)
    expect(views.at(-1)!.master).toBe("Sync master: unknown")
  } finally {
    stop()
  }
  const count = views.length
  await Bun.sleep(30)
  expect(views).toHaveLength(count)
  expect(calls).toBe(3)
})

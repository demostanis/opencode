import type { SessionSyncStatus } from "@opencode-ai/sdk/v2"

export function describe(status: SessionSyncStatus | undefined, elapsed = 0) {
  if (!status || status.state === "unavailable")
    return { master: "Sync master: unknown", timing: "Scheduler unavailable" }
  if (status.state === "disabled") return { master: "Sync master: no (disabled)", timing: "Session sync disabled" }
  const master = status.owner ? "Sync master: yes (this server)" : "Sync master: no (another instance)"
  if (elapsed > 15_000) return { master: "Sync master: unknown", timing: "Scheduler status stale" }
  if (status.owner && status.running) return { master, timing: "Sync running (session files)" }
  if (status.next === null) return { master, timing: "No check scheduled" }
  const seconds = Math.ceil(Math.max(0, status.next - status.timestamp - elapsed) / 1000)
  return {
    master,
    timing:
      seconds > 0
        ? `${status.owner ? "Next sync" : "Next check"} in ${seconds} seconds${status.owner ? " (session files)" : ""}`
        : "Awaiting scheduler...",
  }
}

export function watch(
  read: (signal: AbortSignal) => Promise<SessionSyncStatus>,
  update: (view: ReturnType<typeof describe>) => void,
  interval = 5_000,
  cadence = 1_000,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let status: SessionSyncStatus | undefined
  let received = performance.now()
  const render = () => update(describe(status, performance.now() - received))
  const clock = setInterval(render, cadence)
  async function tick() {
    const start = performance.now()
    const result = await read(AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)])).catch(() => undefined)
    if (controller.signal.aborted) return
    status = result
    // Server time removes clock skew; half the round trip approximates response transit.
    received = (start + performance.now()) / 2
    render()
    timer = setTimeout(tick, interval)
  }
  render()
  void tick()
  return () => {
    controller.abort()
    clearTimeout(timer)
    clearInterval(clock)
  }
}

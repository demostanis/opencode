import type { SyncthingStatus } from "@opencode-ai/sdk/v2"

export function poll(
  read: (signal: AbortSignal) => Promise<SyncthingStatus>,
  update: (status: SyncthingStatus) => void,
  interval = 15_000,
  timeout = 7_000,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function tick() {
    const status = await read(AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])).catch(
      (): SyncthingStatus => ({ state: "unavailable", disconnected: [] }),
    )
    if (controller.signal.aborted) return
    update(status)
    timer = setTimeout(tick, interval)
  }
  void tick()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}

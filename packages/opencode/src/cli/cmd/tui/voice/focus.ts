export namespace Focus {
  export type Watcher = { available: boolean; stop(): void }
  export type Options = {
    env?: NodeJS.ProcessEnv
    commands?: { xprop: string[]; xdotool: string[] }
  }

  export function xid(text: string): number | undefined {
    const value = text.trim()
    if (!/^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value)) return
    const id = Number(value)
    if (id <= 0xffffffff) return id
  }

  export function property(text: string): number | undefined {
    const match = /^_NET_ACTIVE_WINDOW\(WINDOW\): window id # (\S+)\s*$/.exec(text)
    if (match) return xid(match[1])
  }

  // Command prefixes allow integration tests to run real subprocesses without an X server.
  export function watch(event: (focused: boolean) => void, opts: Options = {}): Watcher {
    const env = opts.env ?? process.env
    const id = xid(env.WINDOWID ?? "")
    const commands = opts.commands ?? {
      xprop: [Bun.which("xprop", { PATH: env.PATH }) ?? ""],
      xdotool: [Bun.which("xdotool", { PATH: env.PATH }) ?? ""],
    }
    const available = Boolean(env.DISPLAY?.trim() && id && commands.xprop[0] && commands.xdotool[0])
    let stopped = false
    let focused = false
    let authoritative = false
    let revision = 0
    let spying = false
    let querying = false
    let retry = 0
    const children = new Set<() => void>()

    function emit(value: boolean) {
      if (stopped || focused === value) return
      focused = value
      event(value)
    }

    async function run(cmd: string[], output: (text: string) => void, timeout?: number) {
      if (stopped) return false
      try {
        const child = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
        const reader = child.stdout.getReader()
        let cancelled = false
        const cancel = () => {
          if (cancelled) return
          cancelled = true
          // Kill even an unresponsive X client; also unblock any pending read.
          try {
            child.kill("SIGKILL")
          } catch {}
          void reader.cancel().catch(() => {})
        }
        children.add(cancel)
        const timer = timeout === undefined ? undefined : setTimeout(cancel, timeout)
        try {
          const decoder = new TextDecoder()
          while (!stopped && !cancelled) {
            const chunk = await reader.read()
            if (chunk.done) break
            if (!stopped && !cancelled) output(decoder.decode(chunk.value, { stream: true }))
          }
          return (await child.exited) === 0 && !cancelled
        } finally {
          clearTimeout(timer)
          cancel()
          await child.exited.catch(() => {})
          children.delete(cancel)
          reader.releaseLock()
        }
      } catch {
        return false
      }
    }

    async function query() {
      querying = true
      const version = revision
      let text = ""
      const success = await run(
        [...commands.xdotool, "getwindowfocus"],
        (chunk) => {
          text += chunk
          if (text.length > 4096) throw new Error("Oversized focus response")
        },
        750,
      )
      // An in-flight fallback must never override a newer root property event.
      if (!authoritative && version === revision) emit(success && xid(text) === id)
      querying = false
    }

    async function spy() {
      spying = true
      let buffer = ""
      await run([...commands.xprop, "-root", "-spy", "_NET_ACTIVE_WINDOW"], (chunk) => {
        buffer += chunk
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n")
          if (end > 4096) throw new Error("Oversized focus property")
          const value = property(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          revision++
          authoritative = value !== undefined
          emit(value !== undefined && value === id)
        }
        if (buffer.length > 4096) throw new Error("Oversized focus property")
      })
      revision++
      authoritative = false
      emit(false)
      spying = false
      retry = Date.now() + 1000
    }

    event(false)
    const timer = available
      ? setInterval(() => {
          if (stopped) return
          if (!spying && Date.now() >= retry) void spy()
          if (!authoritative && !querying) void query()
        }, 250)
      : undefined
    if (available) void spy()

    return {
      available,
      stop() {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        children.forEach((cancel) => cancel())
      },
    }
  }
}

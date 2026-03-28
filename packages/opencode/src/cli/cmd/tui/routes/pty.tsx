import { createEffect, createMemo, createSignal, Show, onMount, onCleanup, For } from "solid-js"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Sidebar } from "./session/sidebar"
import { useKV } from "../context/kv"
import { ScrollBoxRenderable, TextAttributes, RGBA } from "@opentui/core"
import { createVirtual, type StyledLine } from "./pty-terminal"

function hexToRGBA(hex: string | undefined): RGBA | undefined {
  if (!hex) return undefined
  return RGBA.fromHex(hex)
}

function keyToSequence(evt: { name: string; ctrl: boolean; shift: boolean; sequence?: string }): string | undefined {
  const ctrl = evt.ctrl
  const name = evt.name

  // Use sequence for printable characters (handles shift correctly)
  if (evt.sequence && evt.sequence.length === 1 && evt.sequence !== "\x1b") {
    // Handle ctrl+letter via sequence
    if (ctrl && evt.sequence >= "a" && evt.sequence <= "z") {
      return String.fromCharCode(evt.sequence.charCodeAt(0) - 96)
    }
    if (ctrl && evt.sequence >= "A" && evt.sequence <= "Z") {
      return String.fromCharCode(evt.sequence.charCodeAt(0) - 64)
    }
    return evt.sequence
  }

  // Special keys
  const specialKeys: Record<string, string> = {
    space: " ",
    return: "\r",
    enter: "\r",
    tab: "\t",
    backspace: "\x7f",
    delete: "\x1b[3~",
    escape: "\x1b",
    left: "\x1b[D",
    right: "\x1b[C",
    up: "\x1b[A",
    down: "\x1b[B",
    home: "\x1b[H",
    end: "\x1b[F",
    pageup: "\x1b[5~",
    pagedown: "\x1b[6~",
    insert: "\x1b[2~",
    f1: "\x1bOP",
    f2: "\x1bOQ",
    f3: "\x1bOR",
    f4: "\x1bOS",
    f5: "\x1b[15~",
    f6: "\x1b[17~",
    f7: "\x1b[18~",
    f8: "\x1b[19~",
    f9: "\x1b[20~",
    f10: "\x1b[21~",
    f11: "\x1b[23~",
    f12: "\x1b[24~",
  }

  return specialKeys[name]
}

export function PtyView() {
  const route = useRouteData("pty")
  const { navigate } = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const kv = useKV()

  const pty = createMemo(() => {
    const p = sync.data.pty.find((p) => p.id === route.ptyID)
    if (p && route.sessionID && p.parentSessionID !== route.sessionID) return undefined
    return p
  })

  const ptyOutput = createMemo(() => sync.data.ptyOutput[route.ptyID])

  const [lines, setLines] = createSignal<StyledLine[]>([])
  const [termReady, setTermReady] = createSignal(false)
  const [lastCursor, setLastCursor] = createSignal(0)

  const cols = createMemo(() => Math.max(20, dimensions().width - 8))
  const rows = createMemo(() => Math.max(5, dimensions().height - 8))

  let term: ReturnType<typeof createVirtual> | undefined
  let scroll: ScrollBoxRenderable

  onMount(async () => {
    term = createVirtual(cols(), rows())

    // Load initial buffer
    try {
      // @ts-ignore
      const res = await sdk.client.pty.read({ ptyID: route.ptyID, include_history: true })
      if (res.data) {
        // The buffer is already raw data, don't escape it
        await term.write(res.data)
        const info = pty()
        setLastCursor(info?.cursor ?? 0)
      }
    } catch (e) {
      console.error("Failed to read PTY buffer:", e)
    }

    setTermReady(true)
    setLines(term.getBuffer())

    setTimeout(() => {
      if (scroll && !scroll.isDestroyed) {
        scroll.scrollTo(scroll.scrollHeight)
      }
    }, 10)
  })

  onCleanup(() => {
    term?.dispose()
  })

  // Process new output from sync
  createEffect(() => {
    if (!term || !termReady()) return

    const output = ptyOutput()
    const prevCursor = lastCursor()
    if (!output || output.cursor <= prevCursor) return

    const deltaSize = output.cursor - prevCursor
    const chunk = output.buffer.slice(-deltaSize)

    // Async write to ensure xterm has processed the data
    void (async () => {
      await term!.write(chunk)
      setLastCursor(output.cursor)
      setLines(term!.getBuffer())

      setTimeout(() => {
        if (scroll && !scroll.isDestroyed) {
          scroll.scrollTo(scroll.scrollHeight)
        }
      }, 10)
    })()
  })

  // Resize terminal when dimensions change
  createEffect(() => {
    const c = cols()
    const r = rows()
    if (term && termReady()) {
      term.resize(c, r)
      setLines(term.getBuffer())
    }
  })

  const handleBack = () => {
    const sid = pty()?.parentSessionID || route.sessionID
    if (sid) {
      navigate({ type: "session", sessionID: sid })
    } else {
      navigate({ type: "home" })
    }
  }

  const handleKill = async () => {
    if (pty()?.status === "running") {
      try {
        await sdk.client.pty.kill({ ptyID: route.ptyID })
      } catch (e) {
        // ignore
      }
    }
  }

  const handleRestart = async () => {
    try {
      await sdk.client.pty.restart({ ptyID: route.ptyID })
    } catch (e) {
      // ignore
    }
  }

  const handleWrite = async (data: string) => {
    if (pty()?.status !== "running") return
    try {
      await sdk.client.pty.write({ ptyID: route.ptyID, data })
    } catch (e) {
      // ignore
    }
  }

  useKeyboard((evt) => {
    // When process has exited, Enter goes back
    if (pty()?.status !== "running") {
      if (evt.name === "return" || evt.name === "enter") {
        handleBack()
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }

    const seq = keyToSequence({
      name: evt.name,
      ctrl: evt.ctrl,
      shift: evt.shift,
      sequence: (evt as any).sequence,
    })

    if (seq) {
      handleWrite(seq)
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  const [sidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen] = createSignal(false)
  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })

  return (
    <box flexDirection="row" width="100%" height="100%">
      <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
        <Show
          when={pty()}
          fallback={
            <box flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
              <text fg={theme.error} attributes={TextAttributes.BOLD}>
                Access Denied or Process Not Found
              </text>
              <text fg={theme.textMuted}>
                You don't have permission to access this background process or it has expired.
              </text>
              <box
                onMouseUp={handleBack}
                backgroundColor={theme.backgroundElement}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                marginTop={1}
              >
                <text fg={theme.text}>Go Back</text>
              </box>
            </box>
          }
        >
          <box flexDirection="column" flexShrink={0} gap={1}>
            <box flexDirection="row" justifyContent="space-between" alignItems="center">
              <box flexDirection="row" gap={1}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                  Background Process
                </text>
                <text fg={theme.text}>{pty()?.title ?? route.ptyID}</text>
                <text fg={theme.textMuted}>
                  ({pty()?.status}
                  {pty()?.exitCode !== undefined ? ` - exit ${pty()?.exitCode}` : ""})
                </text>
              </box>
              <box flexDirection="row" gap={1}>
                <box
                  onMouseUp={handleBack}
                  backgroundColor={theme.backgroundElement}
                  paddingLeft={1}
                  paddingRight={1}
                  width={8}
                  justifyContent="center"
                >
                  <text fg={theme.text}>Back</text>
                </box>
                <box
                  onMouseUp={handleKill}
                  backgroundColor={pty()?.status === "running" ? theme.error : theme.backgroundElement}
                  paddingLeft={1}
                  paddingRight={1}
                  width={8}
                  justifyContent="center"
                  style={{ opacity: pty()?.status === "running" ? 1 : 0.5 }}
                >
                  <text fg={theme.text}>{pty()?.status === "running" ? "Kill" : "Killed"}</text>
                </box>
                <box
                  onMouseUp={handleRestart}
                  backgroundColor={theme.primary}
                  paddingLeft={1}
                  paddingRight={1}
                  width={10}
                  justifyContent="center"
                >
                  <text fg={theme.text}>Restart</text>
                </box>
              </box>
            </box>
            <Show when={pty()}>
              <box paddingLeft={2}>
                <text fg={theme.textMuted} wrapMode="word">
                  <b>Command:</b> {pty()!.command} {(pty()!.args || []).join(" ")}
                </text>
                <text fg={theme.textMuted}>
                  <b>CWD:</b> {pty()!.cwd}
                </text>
              </box>
            </Show>
          </box>

          <scrollbox ref={(r) => (scroll = r)} flexGrow={1} stickyScroll={true} stickyStart="bottom">
            <For each={lines()} fallback={<text fg={theme.textMuted}>Waiting for output...</text>}>
              {(line: StyledLine) => (
                <text>
                  <For each={line.segments}>
                    {(seg) => {
                      // Cursor segment: render with swapped colors
                      if (seg.style.cursor) {
                        const cursorBg = hexToRGBA(seg.style.fg) ?? theme.text
                        const cursorFg = hexToRGBA(seg.style.bg) ?? theme.background
                        return (
                          <span
                            style={{
                              fg: cursorFg,
                              bg: cursorBg,
                              bold: seg.style.bold,
                              italic: seg.style.italic,
                              dim: seg.style.dim,
                              underline: seg.style.underline,
                              strikethrough: seg.style.strikethrough,
                            }}
                          >
                            {seg.text}
                          </span>
                        )
                      }
                      const fg = hexToRGBA(seg.style.fg)
                      const bg = hexToRGBA(seg.style.bg)
                      return (
                        <span
                          style={{
                            fg: fg ?? (seg.style.dim ? theme.textMuted : theme.text),
                            bg: bg,
                            bold: seg.style.bold,
                            italic: seg.style.italic,
                            dim: seg.style.dim,
                            underline: seg.style.underline,
                            strikethrough: seg.style.strikethrough,
                            inverse: seg.style.inverse,
                          }}
                        >
                          {seg.text}
                        </span>
                      )
                    }}
                  </For>
                </text>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
      <Show when={sidebarVisible()}>
        <Sidebar sessionID={pty()?.parentSessionID || route.sessionID || ""} />
      </Show>
    </box>
  )
}

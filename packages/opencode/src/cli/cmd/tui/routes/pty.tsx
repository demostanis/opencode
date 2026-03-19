import { createEffect, createMemo, createSignal, Show, onMount, For } from "solid-js"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useTerminalDimensions } from "@opentui/solid"
import { Sidebar } from "./session/sidebar"
import { useKV } from "../context/kv"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import stripAnsi from "strip-ansi"

export function PtyView() {
  const route = useRouteData("pty")
  const { navigate } = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const kv = useKV()

  const pty = createMemo(() => sync.data.pty.find((p) => p.id === route.ptyID))

  // Local signal for the initial buffer state (fetched from server)
  const [initialBuffer, setInitialBuffer] = createSignal({ buffer: "", cursor: 0 })

  const outputLines = createMemo(() => {
    const initial = initialBuffer()
    const realTime = sync.data.ptyOutput[route.ptyID] || { buffer: "", cursor: 0 }

    let raw = initial.buffer
    if (realTime.cursor > initial.cursor) {
      const deltaSize = realTime.cursor - initial.cursor
      raw += realTime.buffer.slice(-deltaSize)
    }

    // Fix literal \n if they got escaped, and normalize terminal newlines
    const normalized = raw.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\r\n/g, "\n").replace(/\r/g, "\n")

    return stripAnsi(normalized).split("\n")
  })

  let scroll: ScrollBoxRenderable

  const handleBack = () => {
    const sid = route.sessionID || pty()?.parentSessionID
    if (sid) {
      navigate({ type: "session", sessionID: sid })
    } else {
      navigate({ type: "home" })
    }
  }

  const handleKill = async () => {
    if (pty()?.status === "running") {
      try {
        await sdk.client.pty.remove({ ptyID: route.ptyID })
      } catch (e) {
        // ignore
      }
    }
  }

  onMount(async () => {
    try {
      // @ts-ignore
      const res = await sdk.client.pty.read({ ptyID: route.ptyID })
      if (res.data) {
        const info = pty()
        setInitialBuffer({ buffer: res.data, cursor: info?.cursor ?? 0 })

        setTimeout(() => {
          if (scroll && !scroll.isDestroyed) {
            scroll.scrollTo(scroll.scrollHeight)
          }
        }, 10)
      }
    } catch (e) {
      // ignore
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
          <For each={outputLines()} fallback={<text fg={theme.textMuted}>Waiting for output...</text>}>
            {(line: string) => <text fg={theme.text}>{line}</text>}
          </For>
          <Show when={pty()?.status === "killed"}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Process was killed.
            </text>
          </Show>
        </scrollbox>
      </box>
      <Show when={sidebarVisible()}>
        <Sidebar sessionID={route.sessionID || pty()?.parentSessionID || ""} />
      </Show>
    </box>
  )
}

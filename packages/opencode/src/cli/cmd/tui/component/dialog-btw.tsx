import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

export function DialogBtw(props: {
  sessionID: string
  question: string
  model: { providerID: string; modelID: string }
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const abort = new AbortController()
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal(true)
  onCleanup(() => abort.abort())
  onMount(() => {
    dialog.setSize("large")
    sdk.client.session
      .btw(props, { signal: abort.signal, throwOnError: true })
      .then((result) => setText(result.data.text || "No answer returned."))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        const data = typeof err === "object" && err !== null && "data" in err ? err.data : undefined
        const message =
          err instanceof Error
            ? err.message
            : typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
              ? data.message
              : "Unable to answer side question."
        setError(message.split("\n")[0])
      })
      .finally(() => setPending(false))
  })
  return (
    <box paddingX={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>BTW</b>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(3, Math.floor(dimensions().height / 2))}>
        <box gap={1}>
          <text fg={theme.text}>{props.question}</text>
          <Show when={pending()}>
            <text fg={theme.textMuted}>Thinking...</text>
          </Show>
          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>
          <Show when={text()}>
            <markdown content={text()} syntaxStyle={syntax()} />
          </Show>
        </box>
      </scrollbox>
      <text fg={theme.textMuted}>Not saved to history. The main turn continues independently.</text>
    </box>
  )
}

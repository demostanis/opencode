import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { TextareaRenderable } from "@opentui/core"
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
  const [pending, setPending] = createSignal(true)
  const [history, setHistory] = createStore<{ question: string; text: string; error: string; pending: boolean }[]>([])
  let input: TextareaRenderable
  onCleanup(() => abort.abort())
  onMount(() => {
    dialog.setSize("large")
    ask(props.question)
  })

  function ask(value: string) {
    if (!value.trim() || abort.signal.aborted) return
    const index = history.length
    setHistory(index, { question: value.trim(), text: "", error: "", pending: true })
    setPending(true)
    sdk.client.session
      .btw(
        {
          ...props,
          question: value.trim(),
          history: history
            .slice(0, index)
            .flatMap((entry) => [
              { role: "user" as const, content: entry.question },
              ...(entry.text ? [{ role: "assistant" as const, content: entry.text }] : []),
            ]),
        },
        { signal: abort.signal, throwOnError: true },
      )
      .then((result) => setHistory(index, "text", result.data.text || "No answer returned."))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        const data = typeof err === "object" && err !== null && "data" in err ? err.data : undefined
        const message =
          err instanceof Error
            ? err.message
            : typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
              ? data.message
              : "Unable to answer side question."
        setHistory(index, "error", message.split("\n")[0])
      })
      .finally(() => {
        setHistory(index, "pending", false)
        setPending(false)
      })
  }
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
      <scrollbox maxHeight={Math.max(3, Math.floor(dimensions().height / 2))} stickyScroll stickyStart="bottom">
        <box gap={1}>
          <For each={history}>
            {(entry) => (
              <box gap={1}>
                <text fg={theme.text}>{entry.question}</text>
                <Show when={entry.pending}>
                  <text fg={theme.textMuted}>Thinking...</text>
                </Show>
                <Show when={entry.error}>
                  <text fg={theme.error}>{entry.error}</text>
                </Show>
                <Show when={entry.text}>
                  <markdown content={entry.text} syntaxStyle={syntax()} />
                </Show>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <Show when={!pending()}>
        <textarea
          height={3}
          placeholder="Ask another side question"
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(value: TextareaRenderable) => {
            input = value
            setTimeout(() => {
              if (!value.isDestroyed) value.focus()
            }, 1)
          }}
          onSubmit={() => ask(input.plainText)}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
      </Show>
      <text fg={theme.textMuted}>Not saved to main history. The main turn continues independently.</text>
    </box>
  )
}

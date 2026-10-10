import { TextAttributes } from "@opentui/core"
import { Show, createResource, onCleanup, onMount } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

export function DialogSearchStatus() {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [status, { refetch }] = createResource(async () => {
    const result = await sdk.client.session.searchStatus({}, { throwOnError: true })
    return result.data!
  })

  onMount(() => {
    dialog.setSize("large")
    const timer = setInterval(() => void refetch(), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Search index status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={!status.error} fallback={<text fg={theme.error}>Could not load search index status.</text>}>
        <Show when={status()} fallback={<text fg={theme.textMuted}>Loading...</text>}>
          {(data) => (
            <box>
              <text fg={data().indexing ? theme.warning : theme.text}>
                {data().indexing ? "Indexing..." : data().ready ? "Ready" : "Not initialized"}
              </text>
              <text fg={theme.text} wrapMode="word">
                Last completed refresh:{" "}
                {data().refreshed === null ? "Never" : new Date(data().refreshed!).toLocaleString()}
              </text>
              <text fg={theme.text} wrapMode="word">
                Indexed: {data().parts.toLocaleString()} message/tool entries in {data().conversations.toLocaleString()}{" "}
                conversations
              </text>
            </box>
          )}
        </Show>
      </Show>
      <box gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Refresh rules
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Starts on first content search. Without a completed index, search waits for the initial pass.
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Then checks on searches and every 30 seconds. Skips if refreshed less than 30 seconds ago or the database is
          unchanged.
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Live message updates/removals are batched after 100 ms; searches flush pending updates first.
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Refreshes scan newest entries first, update changed entries and remove stale ones. Viewing status does not
          start indexing.
        </text>
      </box>
    </box>
  )
}

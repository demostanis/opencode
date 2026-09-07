import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import type { DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { writable } from "./worker"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [removing, remove] = createSignal(false)
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const queued = createMemo(() => {
    const msg = message()
    if (msg?.role !== "user") return false
    const active = sync.data.message[props.sessionID]?.findLast((x) => x.role === "assistant" && !x.time.completed)
    return !!active && msg.id > active.id
  })
  const pending = createMemo(() => {
    const msg = message()
    if (msg?.role !== "user" || !msg.deferred) return false
    return !(sync.data.message[props.sessionID] ?? []).some(
      (item) => item.role === "assistant" && item.parentID === msg.id,
    )
  })
  const route = useRoute()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        ...((queued() || pending()) && writable(sync.session.get(props.sessionID))
          ? [
              {
                title: removing() ? "Removing..." : "Remove",
                value: "message.remove",
                description: "remove this queued or deferred message",
                onSelect: async (dialog: DialogContext) => {
                  if (removing()) return
                  remove(true)
                  const deleted = await sdk.client.session
                    .deleteMessage({ sessionID: props.sessionID, messageID: props.messageID }, { throwOnError: true })
                    .then(() => true)
                    .catch(() => false)
                  remove(false)
                  if (!deleted) {
                    toast.show({
                      message: "Failed to remove message. It may already be processing.",
                      variant: "error",
                    })
                    return
                  }
                  dialog.clear()
                },
              },
            ]
          : []),
        ...(pending()
          ? [
              {
                title: "Queue now",
                value: "session.queue",
                description: "move to the end of the normal message queue",
                onSelect: async (dialog: DialogContext) => {
                  const queued = await sdk.client.session
                    .queue(
                      {
                        sessionID: props.sessionID,
                        messageID: props.messageID,
                      },
                      { throwOnError: true },
                    )
                    .then(() => true)
                    .catch(() => false)
                  if (!queued) {
                    toast.show({ message: "Failed to queue message", variant: "error" })
                    return
                  }
                  dialog.clear()
                },
              },
            ]
          : []),
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const initialPrompt = (() => {
              const msg = message()
              if (!msg) return undefined
              const parts = sync.data.part[msg.id]
              return parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(part)
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
            })()
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              initialPrompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}

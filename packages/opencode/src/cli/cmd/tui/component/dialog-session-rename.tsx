import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { parse, rename } from "../routes/session/worker"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const session = createMemo(() => sync.session.get(props.session))
  const info = createMemo(() => parse(session()?.title ?? ""))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.parentID && info().agent ? info().title : session()?.title}
      onConfirm={(value) => {
        sdk.client.session.update({
          sessionID: props.session,
          title: rename(session(), value),
        })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

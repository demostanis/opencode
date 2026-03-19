import { createMemo } from "solid-js"
import { useSync } from "./sync"
import { Global } from "@/global"
import { useTerminalDimensions } from "@opentui/solid"
import { Locale } from "@/util/locale"

export function useDirectory() {
  const sync = useSync()
  const dimensions = useTerminalDimensions()
  return createMemo(() => {
    let directory = sync.data.path.directory || process.cwd()
    directory = directory.replace("/run/archiso", "")
    let result = directory.replace(Global.Path.home, "~")
    if (sync.data.vcs?.branch) result = result + ":" + sync.data.vcs.branch
    const maxLen = Math.max(20, dimensions().width - 40)
    return Locale.truncateMiddle(result, maxLen)
  })
}

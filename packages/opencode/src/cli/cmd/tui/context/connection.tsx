import type { Owner } from "@/cli/cmd/tui/owner"
import { resolve, type Backend } from "../backend"
import { batch, createContext, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useRoute } from "./route"
import { SDKProvider } from "./sdk"
import { SyncProvider } from "./sync"

const ctx = createContext<{
  open(sessionID: string, directory: string): Promise<void>
  initial: boolean
}>()

export function ConnectionProvider(
  props: ParentProps<{
    backend: Backend
    owner?: Pick<Owner.Info, "id">
  }>,
) {
  const route = useRoute()
  const [backend, setBackend] = createSignal(props.backend)
  const [initial, setInitial] = createSignal(true)

  const value = {
    async open(sessionID: string, directory: string) {
      const next = await resolve({ sessionID, directory, backend: props.backend, owner: props.owner })
      batch(() => {
        setInitial(false)
        setBackend(next)
        route.navigate({ type: "session", sessionID })
      })
    },
    get initial() {
      return initial()
    },
  }

  return (
    <ctx.Provider value={value}>
      <Show when={backend()} keyed>
        {(item) => (
          <SDKProvider
            url={item.url}
            directory={item.directory}
            fetch={item.fetch}
            headers={item.headers}
            events={item.events}
          >
            <SyncProvider>{props.children}</SyncProvider>
          </SDKProvider>
        )}
      </Show>
    </ctx.Provider>
  )
}

export function useConnection() {
  const value = useContext(ctx)
  if (!value) throw new Error("Connection context must be used within a connection provider")
  return value
}

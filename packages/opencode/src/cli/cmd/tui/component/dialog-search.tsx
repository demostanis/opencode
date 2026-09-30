import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { SessionSearchHit } from "@opencode-ai/sdk/v2"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { createDebouncedSignal } from "@tui/util/signal"
import { Locale } from "@/util/locale"
import { live } from "@tui/util/search"
import stripAnsi from "strip-ansi"
import { useConnection } from "@tui/context/connection"

export function DialogSearch(
  props: {
    sessionID?: string
    onMove?: (hit: SessionSearchHit) => void
    onSelect?: (hit: SessionSearchHit) => void
  } = {},
) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const connection = useConnection()
  const [filter, setFilter] = createSignal("")
  const [query, setQuery] = createDebouncedSignal("", 25)
  const [revision, setRevision] = createDebouncedSignal(0, 1000)
  const [opening, setOpening] = createSignal(false)
  const [indexed, setIndexed] = createSignal(false)
  const [indexing, setIndexing] = createSignal(false)
  const valid = createMemo(() => Array.from(filter().trim()).length >= 3 && filter().trim().length <= 256)
  let disposed = false
  let version = 0
  let abort: AbortController | undefined
  let reveal: AbortController | undefined

  const [results] = createResource(
    () => ({ session: props.sessionID, query: query().trim(), revision: revision() }),
    async (input) => {
      abort?.abort()
      if (input.query && (Array.from(input.query).length < 3 || input.query.length > 256))
        return { query: input.query, hits: [] }
      const controller = new AbortController()
      abort = controller
      const response = await (
        input.session
          ? sdk.client.session.search(
              { sessionID: input.session, query: input.query, limit: 50 },
              { throwOnError: true, signal: controller.signal },
            )
          : sdk.client.session.searchAll(
              { query: input.query, limit: 50 },
              { throwOnError: true, signal: controller.signal },
            )
      ).catch((err: unknown) => {
        if (controller.signal.aborted) return
        throw err
      })
      if (response && !controller.signal.aborted) setIndexed(true)
      return { query: input.query, hits: response?.data ?? [] }
    },
  )

  const hits = createMemo(() => {
    if (!valid()) return []
    const current = Object.entries(sync.data.message)
      .filter(([id]) => !props.sessionID || id === props.sessionID)
      .flatMap(([id, messages]) => {
        const session = sync.session.get(id)
        if (!session) return []
        return live(messages, sync.data.part, filter().trim(), session.revert?.messageID, session)
      })
    const indexed = !results.error && results()?.query === filter().trim() ? (results()?.hits ?? []) : []
    return [...new Map([...indexed, ...current].map((hit) => [hit.partID, hit])).values()]
      .toSorted((a, b) => b.time - a.time || b.messageID.localeCompare(a.messageID) || a.partID.localeCompare(b.partID))
      .slice(0, 50)
  })
  const options = createMemo(() =>
    hits().map((hit) => ({
      title: stripAnsi(hit.preview).replace(/\s+/g, " ").trim(),
      value: hit.partID,
      category: props.sessionID ? undefined : hit.title,
      footer: `${hit.type === "tool" ? hit.tool : hit.type === "reasoning" ? "Thinking" : Locale.titlecase(hit.role)} ${Locale.time(hit.time)}`,
    })),
  )
  const waiting = createMemo(() => results.loading || (valid() && query().trim() !== filter().trim()))

  createEffect(() => {
    if (!results.loading) {
      setIndexing(false)
      return
    }
    const poll = () =>
      sdk.client.session
        .searchStatus()
        .then((response) => {
          if (!disposed && results.loading) setIndexing(response.data?.indexing ?? false)
        })
        .catch(() => {})
    void poll()
    const timer = setInterval(poll, 100)
    onCleanup(() => clearInterval(timer))
  })

  onMount(() => dialog.setSize("large"))
  onCleanup(() => {
    disposed = true
    abort?.abort()
    reveal?.abort()
    setQuery.clear()
    setRevision.clear()
  })
  onCleanup(
    sdk.event.listen((event) => {
      const item = event.details
      if (
        item.type === "message.part.updated" &&
        (!props.sessionID || item.properties.part.sessionID === props.sessionID)
      )
        setRevision(++version)
      if (
        (item.type === "message.removed" || item.type === "message.part.removed") &&
        (!props.sessionID || item.properties.sessionID === props.sessionID)
      )
        setRevision(++version)
      if (item.type === "session.updated" && (!props.sessionID || item.properties.info.id === props.sessionID))
        setRevision(++version)
    }),
  )
  createEffect(() => {
    if (results.error) toast.show({ message: "Conversation search failed", variant: "error" })
  })

  return (
    <DialogSelect
      title={`${props.sessionID ? "Find in conversation" : "Search all conversations"}${hits().length ? ` (${hits().length}${hits().length === 50 ? "+" : ""})${!indexed() || indexing() ? " - Indexing..." : ""}` : ""}`}
      placeholder="Search contents"
      options={options()}
      skipFilter
      highlight={filter().trim()}
      empty={
        opening()
          ? "Opening message..."
          : filter().trim().length > 256
            ? "Search is limited to 256 characters"
            : results.error
              ? "Search failed"
              : !indexed() || indexing()
                ? "Indexing..."
                : waiting()
                  ? "Searching..."
                  : !valid()
                    ? "Enter at least 3 characters"
                    : "No results found"
      }
      onFilter={(text) => {
        setFilter(text)
        setQuery(text)
      }}
      onMove={(option) => {
        const hit = hits().find((hit) => hit.partID === option.value)
        if (hit) props.onMove?.(hit)
      }}
      onSelect={async (option) => {
        if (opening()) return
        const hit = hits().find((hit) => hit.partID === option.value)
        if (!hit) return
        setOpening(true)
        if (!props.sessionID) {
          dialog.clear()
          await connection.open(hit.sessionID, hit.directory, hit, filter().trim()).catch(toast.error)
          return
        }
        const controller = new AbortController()
        reveal = controller
        await sync.session
          .reveal(props.sessionID, hit.messageID, controller.signal)
          .then((revealed) => {
            if (!revealed || disposed) return
            props.onSelect?.(hit)
            dialog.clear()
          })
          .catch((err: unknown) => {
            if (!controller.signal.aborted) toast.error(err)
          })
        if (!disposed) setOpening(false)
      }}
    />
  )
}

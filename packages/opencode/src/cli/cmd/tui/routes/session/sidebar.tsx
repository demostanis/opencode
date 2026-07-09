import { useSync } from "@tui/context/sync"
import { createMemo, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { useRoute } from "../../context/route"
import { Editor } from "../../util/editor"
import "opentui-spinner/solid"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { navigate } = useRoute()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const pty = createMemo(() =>
    sync.data.pty.filter((p) => p.parentSessionID === props.sessionID && p.status === "running"),
  )
  const memory = createMemo(() =>
    sync.data.session.filter(
      (s) =>
        s.parentID === props.sessionID &&
        s.title === "Remembering..." &&
        sync.data.session_status[s.id]?.type === "busy",
    ),
  )
  const workers = createMemo(() => {
    const sessions = sync.data.session
    const byID = new Map(sessions.map((item) => [item.id, item]))
    let root = session()
    while (root?.parentID) root = byID.get(root.parentID)
    if (!root) return []

    const depth = new Map([[root.id, 0]])
    let changed = true
    while (changed) {
      changed = false
      for (const item of sessions) {
        if (!item.parentID || depth.has(item.id)) continue
        const parent = depth.get(item.parentID)
        if (parent === undefined) continue
        depth.set(item.id, parent + 1)
        changed = true
      }
    }

    return sessions
      .flatMap((item) => {
        const level = depth.get(item.id)
        if (!level || item.title === "Remembering...") return []
        const match = item.title.match(/\(@([^ ]+) (agent|subagent)\)$/)
        return [
          {
            ...item,
            level,
            agent: match?.[1],
            type: match?.[2] ?? "subagent",
            status: sync.data.session_status[item.id]?.type ?? "idle",
          },
        ]
      })
      .toSorted((a, b) => a.id.localeCompare(b.id))
  })
  const agents = createMemo(() => workers().filter((worker) => worker.type === "agent"))
  const subagents = createMemo(() => workers().filter((worker) => worker.type === "subagent"))

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    images: true,
    lsp: true,
    pty: true,
    agents: true,
    subagents: true,
  })

  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))
  const generatedImages = createMemo(() => {
    const seen = new Set<string>()
    return messages().flatMap((message) =>
      (sync.data.part[message.id] ?? []).flatMap((part) => {
        if (part.type !== "tool" || part.tool !== "image_generate" || part.state.status !== "completed") return []
        const files = (part.state.metadata?.files ?? []) as Array<{
          path?: string
          mime?: string
          prompt?: string
          revisedPrompt?: string
          shortName?: string
        }>
        return files.flatMap((file) => {
          if (!file.path || !file.mime?.startsWith("image/") || seen.has(file.path)) return []
          seen.add(file.path)
          return [file]
        })
      }),
    )
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={42}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <box flexShrink={0} gap={1} paddingRight={1}>
          <Show when={session()}>
            {(s) => (
              <>
                <box paddingRight={1}>
                  <text fg={theme.text}>
                    <b>{s().title}</b>
                  </text>
                  <Show when={s().share?.url}>
                    <text fg={theme.textMuted}>{s().share!.url}</text>
                  </Show>
                </box>
                <box>
                  <text fg={theme.text}>
                    <b>Context</b>
                  </text>
                  <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
                  <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
                  <text fg={theme.textMuted}>{cost()} spent</text>
                </box>
              </>
            )}
          </Show>

          <Show when={memory().length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => {
                  const session = memory()[0]
                  if (session) navigate({ type: "session", sessionID: session.id })
                }}
              >
                <spinner color={theme.info} interval={80} />
                <text fg={theme.text}>Remembering...</text>
              </box>
            </box>
          </Show>

          <Show when={agents().length > 0}>
            <box>
              <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("agents", !expanded.agents)}>
                <text fg={theme.text}>{expanded.agents ? "▼" : "▶"}</text>
                <text fg={theme.text}>
                  <b>Multi-agent team</b>
                </text>
                <text fg={theme.textMuted}>({agents().filter((agent) => agent.status !== "idle").length} active)</text>
              </box>
              <Show when={expanded.agents}>
                <For each={agents()}>
                  {(agent) => (
                    <box
                      paddingLeft={agent.level * 2}
                      flexDirection="row"
                      gap={1}
                      onMouseUp={() => navigate({ type: "session", sessionID: agent.id })}
                    >
                      <Show
                        when={agent.status !== "idle"}
                        fallback={
                          <text flexShrink={0} fg={agent.id === props.sessionID ? theme.primary : theme.textMuted}>
                            •
                          </text>
                        }
                      >
                        <spinner color={theme.info} interval={80} />
                      </Show>
                      <text fg={agent.id === props.sessionID ? theme.primary : theme.text} wrapMode="none">
                        {agent.title.replace(/ \(@[^ ]+ agent\)$/, "")}
                        <Show when={agent.agent}>
                          <span style={{ fg: theme.textMuted }}> @{agent.agent}</span>
                        </Show>
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          <Show when={subagents().length > 0}>
            <box>
              <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("subagents", !expanded.subagents)}>
                <text fg={theme.text}>{expanded.subagents ? "▼" : "▶"}</text>
                <text fg={theme.text}>
                  <b>Subagents</b>
                </text>
              </box>
              <Show when={expanded.subagents}>
                <For each={subagents()}>
                  {(subagent) => (
                    <box
                      paddingLeft={subagent.level * 2}
                      flexDirection="row"
                      gap={1}
                      onMouseUp={() => navigate({ type: "session", sessionID: subagent.id })}
                    >
                      <Show
                        when={subagent.status !== "idle"}
                        fallback={
                          <text flexShrink={0} fg={subagent.id === props.sessionID ? theme.primary : theme.textMuted}>
                            •
                          </text>
                        }
                      >
                        <spinner color={theme.info} interval={80} />
                      </Show>
                      <text fg={subagent.id === props.sessionID ? theme.primary : theme.text} wrapMode="none">
                        {subagent.title.replace(/ \(@[^ ]+ subagent\)$/, "")}
                        <Show when={subagent.agent}>
                          <span style={{ fg: theme.textMuted }}> @{subagent.agent}</span>
                        </Show>
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          <Show when={pty().length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => pty().length > 2 && setExpanded("pty", !expanded.pty)}
              >
                <Show when={pty().length > 2}>
                  <text fg={theme.text}>{expanded.pty ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Background Processes</b>
                </text>
              </box>
              <Show when={pty().length <= 2 || expanded.pty}>
                <For each={pty()}>
                  {(p) => (
                    <box
                      onMouseUp={() => {
                        navigate({ type: "pty", ptyID: p.id, sessionID: props.sessionID })
                      }}
                      flexDirection="row"
                      gap={1}
                    >
                      <text
                        flexShrink={0}
                        style={{
                          fg: p.status === "running" ? theme.success : theme.textMuted,
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.text} wrapMode="none">
                        {p.title}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          <Show when={mcpEntries().length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
              >
                <Show when={mcpEntries().length > 2}>
                  <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>MCP</b>
                  <Show when={!expanded.mcp}>
                    <span style={{ fg: theme.textMuted }}>
                      {" "}
                      ({connectedMcpCount()} active
                      {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                    </span>
                  </Show>
                </text>
              </box>
              <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                <For each={mcpEntries()}>
                  {([key, item]) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: (
                            {
                              connected: theme.success,
                              failed: theme.error,
                              disabled: theme.textMuted,
                              needs_auth: theme.warning,
                              needs_client_registration: theme.error,
                            } as Record<string, typeof theme.success>
                          )[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.text} wrapMode="word">
                        {key}{" "}
                        <span style={{ fg: theme.textMuted }}>
                          <Switch fallback={item.status}>
                            <Match when={item.status === "connected"}>Connected</Match>
                            <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                            <Match when={item.status === "disabled"}>Disabled</Match>
                            <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                            <Match when={(item.status as string) === "needs_client_registration"}>
                              Needs client ID
                            </Match>
                          </Switch>
                        </span>
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          <box>
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
            >
              <Show when={sync.data.lsp.length > 2}>
                <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
              </Show>
              <text fg={theme.text}>
                <b>LSP</b>
              </text>
            </box>
            <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
              <Show when={sync.data.lsp.length === 0}>
                <text fg={theme.textMuted}>
                  {sync.data.config.lsp === false
                    ? "LSPs have been disabled in settings"
                    : "LSPs will activate as files are read"}
                </text>
              </Show>
              <For each={sync.data.lsp}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <text
                      flexShrink={0}
                      style={{
                        fg: {
                          connected: theme.success,
                          error: theme.error,
                        }[item.status],
                      }}
                    >
                      •
                    </text>
                    <text fg={theme.textMuted}>
                      {item.id} {item.root}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>

          <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
              >
                <Show when={todo().length > 2}>
                  <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Todo</b>
                </text>
              </box>
              <Show when={todo().length <= 2 || expanded.todo}>
                <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
              </Show>
            </box>
          </Show>

          <Show when={generatedImages().length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => generatedImages().length > 2 && setExpanded("images", !expanded.images)}
              >
                <Show when={generatedImages().length > 2}>
                  <text fg={theme.text}>{expanded.images ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Generated images</b>
                </text>
              </box>
              <Show when={generatedImages().length <= 2 || expanded.images}>
                <For each={generatedImages()}>
                  {(item) => (
                    <box flexDirection="row" gap={1} onMouseUp={() => item.path && Editor.openImage(item.path)}>
                      <text flexShrink={0} fg={theme.success}>
                        •
                      </text>
                      <text fg={theme.textMuted} wrapMode="none">
                        {item.shortName || item.path?.split("/").at(-1)}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          <Show when={diff().length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
              >
                <Show when={diff().length > 2}>
                  <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Modified Files</b>
                </text>
              </box>
              <Show when={diff().length <= 2 || expanded.diff}>
                <For each={diff() || []}>
                  {(item) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      justifyContent="space-between"
                      onMouseUp={() => Editor.openFile(item.file)}
                    >
                      <text fg={theme.textMuted} wrapMode="none">
                        {item.file}
                      </text>
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <Show when={item.additions}>
                          <text fg={theme.diffAdded}>+{item.additions}</text>
                        </Show>
                        <Show when={item.deletions}>
                          <text fg={theme.diffRemoved}>-{item.deletions}</text>
                        </Show>
                      </box>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>
        </box>
      </scrollbox>

      <box flexShrink={0} gap={1} paddingTop={1}>
        <Show when={!hasProviders() && !gettingStartedDismissed()}>
          <box
            backgroundColor={theme.backgroundElement}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            flexDirection="row"
            gap={1}
          >
            <text flexShrink={0} fg={theme.text}>
              ⬖
            </text>
            <box flexGrow={1} gap={1}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text}>
                  <b>Getting started</b>
                </text>
                <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                  ✕
                </text>
              </box>
              <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
              <text fg={theme.textMuted}>
                Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
              </text>
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme.text}>Connect provider</text>
                <text fg={theme.textMuted}>/connect</text>
              </box>
            </box>
          </box>
        </Show>
        <text>
          <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
          <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
        </text>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.success }}>•</span> <b>Open</b>
          <span style={{ fg: theme.text }}>
            <b>Code</b>
          </span>{" "}
          <span>{Installation.VERSION}</span>
        </text>
      </box>
    </box>
  )
}

import z from "zod"
import { MultiAgent } from "@/agent/multi-agent"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { PermissionNext } from "@/permission"
import { Instance } from "@/project/instance"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { defer } from "@/util/defer"
import { Tool } from "./tool"

export namespace Collaboration {
  const DELEGATED_AGENT_INSTRUCTION = [
    "You are a delegated subagent, not the coordinating root agent.",
    "Complete the assigned task yourself and return a concise result to your parent.",
    "Do not spawn another agent merely to hand off, repeat, or parallelize this assigned task.",
    "Only delegate when a genuinely independent subtask is necessary to complete your own assignment.",
  ].join(" ")

  type Status = "running" | "completed" | "failed" | "interrupted"
  type External = {
    run: number
    resolve: () => void
  }
  type Entry = {
    id: SessionID
    root: SessionID
    parent: SessionID
    agent: string
    description: string
    model: {
      modelID: ModelID
      providerID: ProviderID
    }
    variant?: string
    status: Status
    result?: string
    error?: string
    time: {
      start: number
      end?: number
    }
    run: number
    activity: number
    pending: number
    promise: Promise<void>
    external?: External
    finalizing?: {
      external: External
      activity: number
    }
  }

  const state = Instance.state(
    () => {
      const entries = new Map<SessionID, Entry>()
      const removed = Bus.subscribe(Session.Event.Deleted, (event) => {
        stop(event.properties.info.id)
        const entry = entries.get(event.properties.info.id)
        if (!entry) return
        entries.delete(entry.id)
      })
      const cancelled = Bus.subscribe(SessionPrompt.Event.Cancelled, (event) => {
        stop(event.properties.sessionID)
      })
      const status = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
        const entry = entries.get(event.properties.sessionID)
        if (!entry) return
        if (event.properties.status.type !== "idle") {
          entry.activity++
          if (entry.pending > 0) return
          const run = ++entry.run
          entry.pending = 1
          entry.status = "running"
          entry.time = { start: Date.now() }
          entry.promise = new Promise<void>((resolve) => {
            entry.external = { run, resolve }
          })
          return
        }

        const external = entry.external
        if (!external) return
        const finalizing = { external, activity: entry.activity }
        entry.finalizing = finalizing
        await finish(entry, finalizing)
      })
      return {
        entries,
        unsub() {
          removed()
          cancelled()
          status()
        },
      }
    },
    async (current) => {
      current.unsub()
      for (const entry of current.entries.values()) {
        if (entry.status !== "running") continue
        interrupt(entry)
      }
    },
  )

  async function root(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    if (!session.parentID) return session.id
    return root(session.parentID)
  }

  function running(rootID: SessionID) {
    return [...state().entries.values()].filter((entry) => entry.root === rootID && entry.status === "running")
  }

  function active(rootID: SessionID) {
    return running(rootID).length
  }

  function limit(rootID: SessionID) {
    const agents = running(rootID)
      .map((entry) => `${entry.agent} "${entry.description}" (${entry.id})`)
      .join(", ")
    return new Error(
      `Multi-agent concurrency limit reached (${MultiAgent.MAX} active across the session tree). Active agents: ${agents}`,
    )
  }

  export function guard(sessionID: SessionID) {
    const entry = state().entries.get(sessionID)
    if (!entry) return () => {}
    if (entry.status === "running") {
      const previous = entry.activity
      const activity = ++entry.activity
      return () => {
        if (entry.activity !== activity) return
        entry.activity = previous
        const current = entry.finalizing
        if (!current) return
        const finalizing = { external: current.external, activity: previous }
        entry.finalizing = finalizing
        void finish(entry, finalizing)
      }
    }
    if (active(entry.root) >= MultiAgent.MAX) throw limit(entry.root)
    const previous = entry.status
    const run = ++entry.run
    entry.pending = 1
    entry.status = "running"
    entry.time = { start: Date.now() }
    entry.promise = new Promise<void>((resolve) => {
      entry.external = { run, resolve }
    })
    return () => {
      if (entry.external?.run !== run) return
      entry.external.resolve()
      delete entry.external
      entry.pending = 0
      entry.status = previous
    }
  }

  async function finish(entry: Entry, finalizing: NonNullable<Entry["finalizing"]>) {
    const { external, activity } = finalizing
    if (entry.run !== external.run) {
      if (entry.finalizing === finalizing) delete entry.finalizing
      delete entry.external
      external.resolve()
      return
    }
    const last = (await Session.messages({ sessionID: entry.id, limit: 1 }))[0]
    if (entry.external !== external || entry.activity !== activity || entry.run !== external.run) return
    if (entry.finalizing === finalizing) delete entry.finalizing
    delete entry.external
    const error = last?.info.role === "assistant" ? last.info.error : undefined
    entry.pending--
    entry.status = entry.pending === 0 ? (error ? "failed" : "completed") : "running"
    entry.error = error ? (error.data?.message ?? error.name) : undefined
    entry.result = last?.parts.findLast((part) => part.type === "text")?.text ?? entry.result
    entry.time.end = Date.now()
    external.resolve()
  }

  function prune(rootID: SessionID) {
    const entries = [...state().entries.values()]
      .filter((entry) => entry.root === rootID && entry.status !== "running")
      .toSorted((a, b) => (b.time.end ?? b.time.start) - (a.time.end ?? a.time.start))
    for (const entry of entries.slice(64)) state().entries.delete(entry.id)

    const terminal = [...state().entries.values()]
      .filter((entry) => entry.status !== "running")
      .toSorted((a, b) => (b.time.end ?? b.time.start) - (a.time.end ?? a.time.start))
    for (const entry of terminal.slice(256)) state().entries.delete(entry.id)
  }

  async function find(sessionID: SessionID, taskID: string) {
    const entry = state().entries.get(SessionID.make(taskID))
    if (!entry) throw new Error(`Unknown agent task: ${taskID}`)
    if (entry.root !== (await root(sessionID))) throw new Error(`Agent task ${taskID} belongs to another session tree`)
    return entry
  }

  function view(entry: Entry, result = true) {
    return {
      task_id: entry.id,
      parent_id: entry.parent,
      agent: entry.agent,
      description: entry.description,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(result && entry.result ? { result: entry.result } : {}),
    }
  }

  function interrupt(entry: Entry) {
    if (entry.status !== "running") return
    entry.run++
    entry.pending = 0
    entry.external?.resolve()
    delete entry.external
    delete entry.finalizing
    entry.status = "interrupted"
    entry.time.end = Date.now()
    SessionPrompt.cancel(entry.id)
  }

  function stop(sessionID: SessionID) {
    for (const entry of [...state().entries.values()]) {
      if (entry.root === sessionID) {
        interrupt(entry)
        continue
      }
      let current: Entry | undefined = entry
      while (current) {
        if (current.id === sessionID || current.parent === sessionID) {
          interrupt(entry)
          break
        }
        current = state().entries.get(current.parent)
      }
    }
  }

  function launch(entry: Entry, prompt: string) {
    const run = entry.run
    const prior = entry.promise
    entry.pending++
    entry.status = "running"
    entry.promise = (async () => {
      await prior
      if (entry.run !== run) return
      entry.time = { start: Date.now() }
      delete entry.result
      delete entry.error
      try {
        const config = await Config.get()
        const parts = await SessionPrompt.resolvePromptParts(prompt)
        if (entry.run !== run) return
        const result = await SessionPrompt.prompt({
          sessionID: entry.id,
          messageID: MessageID.ascending(),
          model: entry.model,
          agent: entry.agent,
          variant: entry.variant,
          system: DELEGATED_AGENT_INSTRUCTION,
          tools: {
            todowrite: false,
            todoread: false,
            ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
          },
          parts,
        })
        if (entry.run !== run) return
        entry.pending--
        entry.status = entry.pending === 0 ? "completed" : "running"
        entry.result = result.parts.findLast((part) => part.type === "text")?.text ?? ""
        entry.time.end = Date.now()
      } catch (error) {
        if (entry.run !== run || entry.status === "interrupted") return
        entry.pending--
        entry.status = entry.pending === 0 ? "failed" : "running"
        entry.error = error instanceof Error ? error.message : String(error)
        entry.time.end = Date.now()
      }
    })()
    return entry.promise
  }

  function available(signal: AbortSignal) {
    if (signal.aborted) throw new Error("Agent operation interrupted")
  }

  async function authorize(ctx: Tool.Context, entries: Entry[]) {
    const patterns = [...new Set(entries.map((entry) => entry.agent))]
    if (patterns.length === 0) return
    await ctx.ask({
      permission: "task",
      patterns,
      always: ["*"],
      metadata: {
        task_ids: entries.map((entry) => entry.id),
      },
    })
  }

  async function settle(promise: Promise<unknown>, signal: AbortSignal) {
    let cleanup = () => {}
    const abort = new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const stop = () => resolve()
      signal.addEventListener("abort", stop, { once: true })
      cleanup = () => signal.removeEventListener("abort", stop)
    })
    using _ = defer(cleanup)
    await Promise.race([promise, abort])
    if (signal.aborted) throw new Error("Agent operation interrupted")
  }

  const spawn = z.object({
    description: z.string().describe("A short description of the delegated task"),
    prompt: z.string().describe("Detailed instructions and expected output for the subagent"),
    subagent_type: z.string().describe("The specialized subagent type to run"),
  })

  export const SpawnAgentTool = Tool.define("spawn_agent", async (ctx) => {
    const agents = await Agent.list().then((items) => items.filter((agent) => agent.mode !== "primary"))
    const caller = ctx?.agent
    const visible = caller
      ? agents.filter((agent) => PermissionNext.evaluate("task", agent.name, caller.permission).action !== "deny")
      : agents
    return {
      description: [
        "Start a subagent in the background for independent, bounded work. The call returns immediately; use wait_agent to collect results.",
        "Available subagents:",
        ...visible.map((agent) => `- ${agent.name}: ${agent.description ?? "User-defined subagent"}`),
      ].join("\n"),
      parameters: spawn,
      async execute(params: z.infer<typeof spawn>, ctx) {
        if (!ctx.extra?.bypassAgentCheck) {
          await ctx.ask({
            permission: "task",
            patterns: [params.subagent_type],
            always: ["*"],
            metadata: {
              description: params.description,
              subagent_type: params.subagent_type,
            },
          })
        }
        available(ctx.abort)
        const requested = await Agent.get(params.subagent_type)
        if (!requested || requested.mode === "primary") {
          throw new Error(`Unknown subagent type: ${params.subagent_type}`)
        }
        const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant") throw new Error("Agent spawning requires an assistant message")
        const rootID = await root(ctx.sessionID)
        const rootMessage = (await Session.messages({ sessionID: rootID })).findLast(
          (message) => message.info.role === "user",
        )
        if (!rootMessage || rootMessage.info.role !== "user") {
          throw new Error("Unable to resolve the root multi-agent runtime")
        }
        const agent = await Agent.get(rootMessage.info.agent)
        if (!agent) throw new Error(`Unknown root agent: ${rootMessage.info.agent}`)
        const model = rootMessage.info.model
        const variant = rootMessage.info.variant
        prune(rootID)
        if (active(rootID) >= MultiAgent.MAX) {
          throw limit(rootID)
        }
        available(ctx.abort)
        const session = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} agent)`,
          permission: [
            { permission: "todowrite", pattern: "*", action: "deny" },
            { permission: "todoread", pattern: "*", action: "deny" },
          ],
        })
        if (ctx.abort.aborted) {
          await Session.remove(session.id)
          throw new Error("Agent operation interrupted")
        }
        if (active(rootID) >= MultiAgent.MAX) {
          await Session.remove(session.id)
          throw limit(rootID)
        }
        const entry: Entry = {
          id: session.id,
          root: rootID,
          parent: ctx.sessionID,
          agent: agent.name,
          description: params.description,
          model,
          variant,
          status: "running",
          time: { start: Date.now() },
          run: 0,
          activity: 0,
          pending: 0,
          promise: Promise.resolve(),
        }
        state().entries.set(entry.id, entry)
        launch(entry, params.prompt)
        return {
          title: params.description,
          metadata: {
            sessionId: entry.id,
            model,
            status: entry.status,
          },
          output: [`Spawned ${agent.name} agent.`, `task_id: ${entry.id}`].join("\n"),
        }
      },
    }
  })

  const target = z.object({
    task_id: z.string().describe("The task ID returned by spawn_agent"),
    message: z.string().describe("The message or additional context to send"),
  })

  export const SendMessageTool = Tool.define("send_message", {
    description: "Queue a message for an existing subagent. It runs as the next turn after its current work.",
    parameters: target,
    async execute(params, ctx) {
      const entry = await find(ctx.sessionID, params.task_id)
      await authorize(ctx, [entry])
      available(ctx.abort)
      launch(entry, params.message)
      return {
        title: `Message ${entry.agent}`,
        metadata: { sessionId: entry.id, status: entry.status },
        output: "Message queued.",
      }
    },
  })

  export const FollowupTaskTool = Tool.define("followup_task", {
    description: "Give an existing subagent another task while preserving its context.",
    parameters: target,
    async execute(params, ctx) {
      const entry = await find(ctx.sessionID, params.task_id)
      await authorize(ctx, [entry])
      if (entry.status === "interrupted") await settle(entry.promise, ctx.abort)
      available(ctx.abort)
      launch(entry, params.message)
      return {
        title: `Follow up ${entry.agent}`,
        metadata: { sessionId: entry.id, status: entry.status },
        output: entry.status === "running" ? "Follow-up accepted." : "Follow-up queued.",
      }
    },
  })

  const wait = z.object({
    task_ids: z.array(z.string()).optional().describe("Task IDs to wait for; omit to wait for any agent in this tree"),
    timeout_ms: z.number().int().min(0).max(3_600_000).optional().describe("Maximum wait time in milliseconds"),
  })

  export const WaitAgentTool = Tool.define("wait_agent", {
    description: "Wait for subagent progress and return the latest statuses and completed results.",
    parameters: wait,
    async execute(params, ctx) {
      const rootID = await root(ctx.sessionID)
      const entries = params.task_ids?.length
        ? await Promise.all(params.task_ids.map((id) => find(ctx.sessionID, id)))
        : [...state().entries.values()].filter((entry) => entry.root === rootID)
      if (entries.length === 0) throw new Error("No subagents to wait for")
      await authorize(ctx, entries)
      const running = entries.filter((entry) => entry.status === "running")
      if (running.length > 0) {
        await settle(
          Promise.race([Promise.race(running.map((entry) => entry.promise)), Bun.sleep(params.timeout_ms ?? 30_000)]),
          ctx.abort,
        )
      }
      return {
        title: "Agent results",
        metadata: { count: entries.length },
        output: JSON.stringify(
          entries.map((entry) => view(entry)),
          null,
          2,
        ),
      }
    },
  })

  const task = z.object({
    task_id: z.string().describe("The task ID returned by spawn_agent"),
  })

  export const InterruptAgentTool = Tool.define("interrupt_agent", {
    description: "Stop a running subagent while preserving its session for a later follow-up.",
    parameters: task,
    async execute(params, ctx) {
      const entry = await find(ctx.sessionID, params.task_id)
      await authorize(ctx, [entry])
      stop(entry.id)
      return {
        title: `Interrupt ${entry.agent}`,
        metadata: { sessionId: entry.id, status: entry.status },
        output: entry.status === "interrupted" ? "Agent interrupted." : `Agent is already ${entry.status}.`,
      }
    },
  })

  export const ListAgentsTool = Tool.define("list_agents", {
    description: "List subagents in the current session tree with their tasks and statuses.",
    parameters: z.object({}),
    async execute(_params, ctx) {
      const rootID = await root(ctx.sessionID)
      prune(rootID)
      const entries = [...state().entries.values()].filter((entry) => entry.root === rootID)
      await authorize(ctx, entries)
      return {
        title: "Agent tree",
        metadata: { count: entries.length },
        output: JSON.stringify(
          entries.map((entry) => view(entry, false)),
          null,
          2,
        ),
      }
    },
  })

  export const tools = [
    SpawnAgentTool,
    SendMessageTool,
    FollowupTaskTool,
    WaitAgentTool,
    InterruptAgentTool,
    ListAgentsTool,
  ]
}

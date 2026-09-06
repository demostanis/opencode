import z from "zod"
import { Teammate } from "@/teammate/teammate"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { defer } from "@/util/defer"
import { Log } from "@/util/log"
import { Tool } from "./tool"

export namespace Collaboration {
  const log = Log.create({ service: "tool.collaboration" })
  const instruction = (agent: string) =>
    [
      Teammate.MARKER,
      `You are a delegated Teammate running the same \`${agent}\` agent mode as the parent that spawned you.`,
      "Own and complete your assigned workstream, integrate supporting results, and return a concise outcome to your parent.",
      "Never pass your assigned workstream, or most of it, to another Teammate or create a delegation chain for the same work.",
      "Use ordinary task subagents for bounded exploration, verification, and small one-shot supporting tasks.",
      "Only spawn a Teammate for a newly discovered, substantial workstream with a distinct deliverable and no current owner.",
      "Communicate dependencies, decisions, progress, conflicts, and shared-file ownership with the team.",
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
    queue?: Promise<MessageV2.WithParts | undefined>
    external?: External
    finalizing?: {
      external: External
      activity: number
    }
  }

  const state = Instance.state(
    () => {
      const entries = new Map<SessionID, Entry>()
      const messages = new Map<SessionID, MessageID>()
      const waiters = new Map<SessionID, Set<() => void>>()
      const removed = Bus.subscribe(Session.Event.Deleted, (event) => {
        stop(event.properties.info.id)
        messages.delete(event.properties.info.id)
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
        restored: new Map<SessionID, Promise<void>>(),
        messages,
        waiters,
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

  async function restore(sessionID: SessionID) {
    const id = await root(sessionID)
    const current = state()
    const previous = current.restored.get(id)
    if (previous) {
      await previous
      return id
    }
    const pending = (async () => {
      async function visit(parent: SessionID): Promise<void> {
        await Promise.all(
          (await Session.children(parent)).map(async (session) => {
            await visit(session.id)
            if (current.entries.has(session.id)) return
            const history = [] as MessageV2.WithParts[]
            for await (const message of MessageV2.stream(session.id)) {
              history.push(message)
              if (message.info.role === "user") break
            }
            const user = history.find((message) => message.info.role === "user")?.info
            if (!user || user.role !== "user" || !Teammate.session(user.system, session.permission)) return
            const last = history[0]
            const assistant = last?.info.role === "assistant" ? last.info : undefined
            const error = assistant?.error
            const status =
              error?.name === "MessageAbortedError"
                ? "interrupted"
                : error
                  ? "failed"
                  : assistant?.time.completed &&
                      assistant.finish &&
                      !["tool-calls", "unknown"].includes(assistant.finish)
                    ? "completed"
                    : "interrupted"
            current.entries.set(session.id, {
              id: session.id,
              root: id,
              parent,
              agent: user.agent,
              description: session.title.replace(/ \(@.* (?:teammate|agent)\)$/, ""),
              model: user.model,
              variant: user.variant,
              status,
              result: assistant ? last.parts.findLast((part) => part.type === "text")?.text : undefined,
              error: error ? (error.data?.message ?? error.name) : undefined,
              time: { start: user.time.created, end: assistant?.time.completed ?? session.time.updated },
              run: 0,
              activity: 0,
              pending: 0,
              promise: Promise.resolve(),
            })
          }),
        )
      }
      await visit(id)
    })()
    current.restored.set(id, pending)
    await pending.catch((error) => {
      current.restored.delete(id)
      throw error
    })
    return id
  }

  function running(rootID: SessionID) {
    return [...state().entries.values()].filter((entry) => entry.root === rootID && entry.status === "running")
  }

  function active(rootID: SessionID) {
    return running(rootID).length
  }

  function limit(rootID: SessionID) {
    const peers = running(rootID)
      .map((entry) => `${entry.agent} "${entry.description}" (${entry.id})`)
      .join(", ")
    return new Error(
      `Teammate concurrency limit reached (${Teammate.MAX} active across the session tree). Active Teammates: ${peers}`,
    )
  }

  export async function guard(sessionID: SessionID) {
    await restore(sessionID)
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
    if (active(entry.root) >= Teammate.MAX) throw limit(entry.root)
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

  async function find(sessionID: SessionID, taskID: string) {
    const rootID = await restore(sessionID)
    const entry = state().entries.get(SessionID.make(taskID))
    if (!entry) throw new Error(`Unknown Teammate task: ${taskID}`)
    if (entry.root !== rootID) throw new Error(`Teammate task ${taskID} belongs to another team`)
    return entry
  }

  function view(entry: Entry, result = true) {
    return {
      task_id: entry.id,
      parent_id: entry.parent,
      coordinator_id: entry.root,
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

  function notify(session: SessionID, message: MessageID) {
    if ((state().messages.get(session) ?? "") < message) state().messages.set(session, message)
    for (const wake of state().waiters.get(session) ?? []) wake()
  }

  function enqueue(entry: Entry, prompt: string) {
    const run = entry.run
    const previous = entry.queue
    const queued = (async () => {
      await previous
      if (entry.run !== run) return
      const config = await Config.get()
      const parts = await SessionPrompt.resolvePromptParts(prompt)
      if (entry.run !== run) return
      return SessionPrompt.prompt({
        sessionID: entry.id,
        messageID: MessageID.ascending(),
        model: entry.model,
        agent: entry.agent,
        variant: entry.variant,
        system: instruction(entry.agent),
        tools: {
          todowrite: false,
          todoread: false,
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
        },
        noReply: true,
        parts,
      })
    })()
    entry.queue = queued.catch(() => undefined)
    return queued
  }

  function launch(entry: Entry, prompt: string, message = false) {
    const run = entry.run
    const prior = entry.promise
    entry.pending++
    entry.status = "running"
    const queued = message ? enqueue(entry, prompt) : undefined
    entry.promise = (async () => {
      try {
        if (queued) {
          const msg = await queued
          if (entry.run !== run) return
          if (msg) notify(entry.id, msg.info.id)
        }
        await prior
        if (entry.run !== run) return
        entry.time = { start: Date.now() }
        delete entry.result
        delete entry.error
        if (!queued) await enqueue(entry, prompt)
        if (entry.run !== run) return
        const result = await SessionPrompt.loop({ sessionID: entry.id })
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
    if (signal.aborted) throw new Error("Teammate operation interrupted")
  }

  async function runtime(ctx: Tool.Context) {
    available(ctx.abort)
    const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (msg.info.role !== "assistant") throw new Error("Teammate tools require an assistant message")
    const info = msg.info
    const agent = await Agent.get(info.agent)
    if (!agent) throw new Error(`Agent is unavailable: ${info.agent}`)
    if (info.variant !== "ultra" || !agent.ultra_mode_allowed) {
      throw new SessionPrompt.UltraModeError({
        message: `Ultra mode is not allowed for agent "${agent.name}"`,
        agent: agent.name,
      })
    }
    const model = await Provider.getModel(info.providerID, info.modelID)
    if (!ProviderTransform.ultra(model, info.variant)) {
      throw new SessionPrompt.UltraModeError({
        message: `Ultra mode is not supported by model "${info.providerID}/${info.modelID}"`,
        agent: agent.name,
        model: `${info.providerID}/${info.modelID}`,
      })
    }
    available(ctx.abort)
    return { msg: info, agent }
  }

  async function authorize(ctx: Tool.Context, entries: Entry[]) {
    const patterns = [...new Set(entries.map((entry) => entry.agent))]
    if (patterns.length === 0) return
    await ctx.ask({
      permission: "teammate",
      patterns,
      always: ["*"],
      metadata: {
        task_ids: entries.map((entry) => entry.id),
      },
    })
  }

  async function coordinator(ctx: Tool.Context, rootID: SessionID, message: string) {
    if (ctx.sessionID === rootID) throw new Error("The root coordinator cannot message itself")
    const user = (await Session.messages({ sessionID: rootID })).findLast((item) => item.info.role === "user")
    if (!user || user.info.role !== "user") throw new Error("Unable to resolve the root coordinator runtime")
    available(ctx.abort)
    await ctx.ask({
      permission: "teammate",
      patterns: [user.info.agent],
      always: ["*"],
      metadata: { task_ids: [rootID] },
    })
    available(ctx.abort)
    const sender = state().entries.get(ctx.sessionID)
    const parts = await SessionPrompt.resolvePromptParts(
      [
        "<teammate-message>",
        `sender_session_id: ${ctx.sessionID}`,
        `sender_agent: ${ctx.agent}`,
        `sender_message_id: ${ctx.messageID}`,
        ...(sender ? [`sender_workstream: ${sender.description}`] : []),
        "",
        message,
        "</teammate-message>",
      ].join("\n"),
    )
    available(ctx.abort)
    const queued = await SessionPrompt.prompt({
      sessionID: rootID,
      messageID: MessageID.ascending(),
      model: user.info.model,
      agent: user.info.agent,
      variant: user.info.variant,
      system: user.info.system,
      memory: user.info.memory,
      format: user.info.format,
      tools: user.info.tools,
      noReply: true,
      parts,
    })
    notify(rootID, queued.info.id)
    void SessionPrompt.loop({ sessionID: rootID }).catch((err) =>
      log.error("failed to deliver Teammate message", {
        sessionID: rootID,
        messageID: queued.info.id,
        err,
      }),
    )
    return queued
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
    if (signal.aborted) throw new Error("Teammate operation interrupted")
  }

  const spawn = z.object({
    description: z.string().describe("A short description of the Teammate's workstream"),
    prompt: z.string().describe("Detailed workstream instructions and expected output for the Teammate"),
  })

  export const SpawnTeammateTool = Tool.define("spawn_teammate", async () => {
    return {
      description:
        "Start a Teammate in the background using the same agent mode as you for a separate, substantial workstream with a clear deliverable and owner. Do not use this for exploration, verification, or small one-shot work; use the task tool instead. The call returns immediately; use wait_teammate to collect results.",
      parameters: spawn,
      async execute(params: z.infer<typeof spawn>, ctx) {
        const current = await runtime(ctx)
        const msg = current.msg
        const agent = current.agent
        const rootID = await restore(ctx.sessionID)
        available(ctx.abort)
        if (!ctx.extra?.bypassAgentCheck) {
          await ctx.ask({
            permission: "teammate",
            patterns: [agent.name],
            always: ["*"],
            metadata: {
              description: params.description,
            },
          })
        }
        available(ctx.abort)
        const model = { providerID: msg.providerID, modelID: msg.modelID }
        const variant = msg.variant
        if (active(rootID) >= Teammate.MAX) {
          throw limit(rootID)
        }
        available(ctx.abort)
        const session = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} teammate)`,
          permission: [
            Teammate.ROLE,
            { permission: "todowrite", pattern: "*", action: "deny" },
            { permission: "todoread", pattern: "*", action: "deny" },
          ],
        })
        if (ctx.abort.aborted) {
          await Session.remove(session.id)
          throw new Error("Teammate operation interrupted")
        }
        if (active(rootID) >= Teammate.MAX) {
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
          output: [`Spawned ${agent.name} Teammate.`, `task_id: ${entry.id}`].join("\n"),
        }
      },
    }
  })

  const target = z.object({
    task_id: z
      .string()
      .describe("A Teammate task ID returned by spawn_teammate, or the coordinator ID from list_teammates"),
    message: z.string().describe("The message or additional context to send"),
  })

  export const SendMessageTool = Tool.define("send_message", {
    description:
      "Queue a message for an existing Teammate or the root coordinator. It becomes available on the target's next turn and wakes wait_teammate.",
    parameters: target,
    async execute(params, ctx) {
      await runtime(ctx)
      const rootID = await restore(ctx.sessionID)
      if (params.task_id === rootID) {
        await coordinator(ctx, rootID, params.message)
        return {
          title: "Message coordinator",
          metadata: { sessionId: rootID, status: "queued" },
          output: "Message queued for coordinator.",
        }
      }
      const entry = await find(ctx.sessionID, params.task_id)
      await authorize(ctx, [entry])
      available(ctx.abort)
      launch(entry, params.message, true)
      return {
        title: `Message ${entry.agent}`,
        metadata: { sessionId: entry.id, status: entry.status },
        output: "Message queued.",
      }
    },
  })

  export const FollowupTaskTool = Tool.define("followup_task", {
    description: "Give an existing Teammate follow-up work in its workstream while preserving its context.",
    parameters: target,
    async execute(params, ctx) {
      await runtime(ctx)
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
    task_ids: z
      .array(z.string())
      .optional()
      .describe("Task IDs to wait for; omit to wait for any Teammate in this team"),
    timeout_ms: z.number().int().min(0).max(3_600_000).optional().describe("Maximum wait time in milliseconds"),
  })

  export const WaitTeammateTool = Tool.define("wait_teammate", {
    description:
      "Wait for Teammate progress or an incoming message and return the latest statuses and completed results. Queued messages are available on your next turn.",
    parameters: wait,
    async execute(params, ctx) {
      await runtime(ctx)
      const current = state()
      const message = Promise.withResolvers<void>()
      const waiters = current.waiters.get(ctx.sessionID) ?? new Set<() => void>()
      current.waiters.set(ctx.sessionID, waiters)
      waiters.add(message.resolve)
      using _ = defer(() => {
        waiters.delete(message.resolve)
        if (waiters.size === 0) current.waiters.delete(ctx.sessionID)
      })
      const rootID = await restore(ctx.sessionID)
      const entries = params.task_ids?.length
        ? await Promise.all(params.task_ids.map((id) => find(ctx.sessionID, id)))
        : [...state().entries.values()].filter((entry) => entry.root === rootID)
      if (entries.length === 0) throw new Error("No Teammates to wait for")
      await authorize(ctx, entries)
      available(ctx.abort)
      const running = entries.filter((entry) => entry.status === "running")
      if (running.length > 0 && (current.messages.get(ctx.sessionID) ?? "") <= ctx.messageID) {
        await settle(
          Promise.race([
            Promise.race(running.map((entry) => entry.promise)),
            message.promise,
            Bun.sleep(params.timeout_ms ?? 30_000),
          ]),
          ctx.abort,
        )
      }
      return {
        title: "Teammate results",
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
    task_id: z.string().describe("The task ID returned by spawn_teammate"),
  })

  export const InterruptTeammateTool = Tool.define("interrupt_teammate", {
    description: "Stop a running Teammate while preserving its session for a later follow-up.",
    parameters: task,
    async execute(params, ctx) {
      await runtime(ctx)
      const entry = await find(ctx.sessionID, params.task_id)
      await authorize(ctx, [entry])
      stop(entry.id)
      return {
        title: `Interrupt ${entry.agent}`,
        metadata: { sessionId: entry.id, status: entry.status },
        output: entry.status === "interrupted" ? "Teammate interrupted." : `Teammate is already ${entry.status}.`,
      }
    },
  })

  export const ListTeammatesTool = Tool.define("list_teammates", {
    description: "List Teammates with their workstreams, statuses, and root coordinator ID.",
    parameters: z.object({}),
    async execute(_params, ctx) {
      await runtime(ctx)
      const rootID = await restore(ctx.sessionID)
      const entries = [...state().entries.values()].filter((entry) => entry.root === rootID)
      await authorize(ctx, entries)
      return {
        title: "Teammates",
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
    SpawnTeammateTool,
    SendMessageTool,
    FollowupTaskTool,
    WaitTeammateTool,
    InterruptTeammateTool,
    ListTeammatesTool,
  ]
}

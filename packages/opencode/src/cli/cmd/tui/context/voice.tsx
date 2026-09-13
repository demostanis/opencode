import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useRoute } from "./route"
import { usePromptRef } from "./prompt"
import { useLocal } from "./local"
import { useTuiConfig } from "./tui-config"
import { useToast } from "../ui/toast"
import { Voice } from "../voice/runtime"
import { Tracker } from "../voice/tracker"
import { Focus } from "../voice/focus"
import { Action } from "../voice/action"
import type { Command, VoiceEvent } from "../voice/protocol"

export const { use: useVoice, provider: VoiceProvider } = createSimpleContext({
  name: "Voice",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const route = useRoute()
    const prompt = usePromptRef()
    const local = useLocal()
    const config = useTuiConfig()
    const toast = useToast()
    const renderer = useRenderer()
    const tracker = Tracker.create()
    const [state, setState] = createSignal<Extract<VoiceEvent, { type: "state" }>["state"]>("off")
    const [focused, setFocused] = createSignal(false)
    const [binding, setBinding] = createSignal("")
    const [handle, setHandle] = createSignal<Voice.Handle>()
    const [submission, setSubmission] = createSignal<{
      controller: AbortController
      home: boolean
      errors: Set<string>
      sent: boolean
      candidate?: string
    }>()
    const seen = new Set<string>()
    let abort: AbortController | undefined
    let flight: Promise<void> | undefined
    let closing = Promise.resolve()
    let retry: ReturnType<typeof setTimeout> | undefined
    let transition: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let warned = false
    let disposed = false
    let cooling = false
    let healthy = 0
    let previous = ""
    let watcher: Focus.Watcher | undefined

    function target() {
      if (route.data.type === "session") return route.data.sessionID
      if (route.data.type === "home") return `home:${route.data.workspaceID ?? ""}`
      return ""
    }

    function enabled() {
      return !disposed && process.platform === "linux" && config.voice !== false && sync.ready && local.model.ready
    }

    const active = () => focused() && (state() === "listening" || state() === "speaking")

    function send(commands: Command[]) {
      if (disposed || binding() !== target()) return
      commands.forEach((item) => handle()?.send(item))
    }

    function update() {
      if (disposed || !handle() || binding() !== target() || !tracker.size()) return
      send(tracker.update(sync.data))
    }

    const context = createMemo(() => {
      if (!sync.ready || !local.model.ready) return ""
      const session = route.data.type === "session" ? route.data.sessionID : undefined
      const model = local.model.current()
      return JSON.stringify({
        session: session ? sync.session.get(session)?.title.slice(0, 256) : "Nouvelle session",
        agent: local.agent.current().name.slice(0, 128),
        model: model && { providerID: model.providerID.slice(0, 128), modelID: model.modelID.slice(0, 128) },
        status: session ? (sync.data.session_status[session]?.type ?? "idle") : "idle",
        messages: (session ? (sync.data.message[session] ?? []) : [])
          .filter(
            (message) =>
              message.sessionID === session &&
              (message.role === "user" ||
                (!message.summary &&
                  !message.error &&
                  message.time.completed !== undefined &&
                  !!message.finish &&
                  !["tool-calls", "unknown", "error"].includes(message.finish))),
          )
          .slice(-4)
          .map((message) => ({
            role: message.role,
            text: (sync.data.part[message.id] ?? [])
              .flatMap((part) =>
                part.sessionID === session &&
                part.messageID === message.id &&
                part.type === "text" &&
                !part.ignored &&
                !part.synthetic &&
                !part.metadata?.private &&
                !part.metadata?.reasoning &&
                !part.metadata?.analysis &&
                (part.metadata?.channel === undefined || part.metadata.channel === "final") &&
                (message.role === "user" || part.time?.end !== undefined)
                  ? [part.text]
                  : [],
              )
              .join("\n")
              .replace(/[\x00-\x1f\x7f]/g, " ")
              .slice(0, 1000),
          }))
          .filter((message) => message.text),
        capabilities:
          "Délègue les demandes de travail à OpenCode. Les permissions et questions doivent être traitées dans le TUI. Ne prétends pas avoir effectué une action sans résultat. Arrêter la voix ne doit jamais arrêter le travail OpenCode.",
      })
    })

    function publish() {
      const child = handle()
      const text = context()
      if (!child || !text || state() === "starting" || state() === "off" || target() !== binding()) return
      if (text === previous) return
      previous = text
      child.send({ type: "context", text })
    }

    function cancel() {
      clearTimeout(transition)
      transition = undefined
      submission()?.controller.abort()
      setSubmission(undefined)
      tracker.clear()
    }

    function stop() {
      const child = handle()
      const pending = flight
      abort?.abort()
      abort = undefined
      flight = undefined
      previous = ""
      healthy = 0
      seen.clear()
      closing = Promise.all([closing, child?.stop(), pending]).then(() => {})
      batch(() => {
        cancel()
        setHandle(undefined)
        setState("off")
        setBinding("")
      })
    }

    function recover(message?: string) {
      cooling = true
      if (healthy && Date.now() - healthy >= 120_000) failures = 0
      stop()
      failures = Math.min(failures + 1, 3)
      if (message && !warned) {
        warned = true
        toast.show({ variant: "error", title: "Voice", message, duration: 10000 })
      }
      if (!enabled()) return
      retry = setTimeout(() => {
        retry = undefined
        cooling = false
        if (enabled() && target()) start()
      }, 30_000 * failures)
    }

    async function delegate(event: Extract<VoiceEvent, { type: "delegate" }>, controller: AbortController) {
      if (controller !== abort || controller.signal.aborted || binding() !== target() || seen.has(event.id)) return
      if (!focused()) {
        send([
          {
            type: "result",
            id: event.id,
            final: true,
            text: "Demande non envoyée : cette fenêtre OpenCode n'a plus le focus. Répète la demande dans la fenêtre active.",
          },
        ])
        return
      }
      seen.add(event.id)
      if (seen.size > 256) seen.delete(seen.values().next().value!)
      const current = prompt.current
      if (!current || !target() || submission() || tracker.size() >= 8) {
        send([
          {
            type: "result",
            id: event.id,
            final: true,
            text: "Demande non envoyée. Attends la fin de l'envoi précédent ou sélectionne une session dans le TUI, puis réessaie.",
          },
        ])
        return
      }
      const request = {
        controller: new AbortController(),
        home: route.data.type === "home",
        errors: new Set<string>(),
        sent: false,
      }
      setSubmission(request)
      const cancelled = Promise.withResolvers<undefined>()
      request.controller.signal.addEventListener("abort", () => cancelled.resolve(undefined), { once: true })
      const timeout = setTimeout(() => cancelled.resolve(undefined), 60_000)
      const receipt = await Promise.race([
        Promise.resolve()
          .then(async () => {
            if (controller !== abort || request.controller.signal.aborted || binding() !== target() || !focused())
              return
            const action = await Action.choose(event.text, request.controller.signal)
            if (controller !== abort || request.controller.signal.aborted || binding() !== target() || !focused())
              return
            if (action === "stop_listening") {
              handle()?.send({ type: "tool", id: event.id, name: action })
              return "stopped" as const
            }
            request.sent = true
            return current.voice(event.text)
          })
          .catch(() => undefined),
        cancelled.promise,
      ])
      clearTimeout(timeout)
      if (controller !== abort || controller.signal.aborted || request.controller.signal.aborted) return
      clearTimeout(transition)
      transition = undefined
      if (receipt === "stopped") {
        setSubmission(undefined)
        return
      }
      batch(() => {
        if (receipt && request.home && target() === receipt.sessionID) setBinding(receipt.sessionID)
        setSubmission(undefined)
      })
      if (controller !== abort || binding() !== target()) return
      if (!receipt || receipt.sessionID !== target()) {
        send([
          {
            type: "result",
            id: event.id,
            final: true,
            text: "OpenCode n'a pas confirmé la demande. Vérifie la session, la connexion et le modèle dans le TUI avant de réessayer.",
          },
        ])
        return
      }
      tracker.add(event.id, receipt)
      if (request.errors.has(receipt.sessionID)) {
        send(tracker.error(receipt.sessionID, ""))
        return
      }
      send([
        {
          type: "result",
          id: event.id,
          final: false,
          text: "Ta demande a été envoyée à l'agent OpenCode sélectionné. Le travail n'est pas encore terminé.",
        },
      ])
      update()
    }

    function start() {
      if (!enabled() || !focused() || !target() || abort || retry || cooling) return
      const controller = new AbortController()
      abort = controller
      setBinding(target())
      setState("starting")
      flight = closing
        .then(async () => {
          if (controller !== abort || controller.signal.aborted || !enabled()) return
          const child = await Voice.start({
            signal: controller.signal,
            event(event) {
              if (controller !== abort || controller.signal.aborted || disposed) return
              if (event.type === "error") return recover(event.message)
              if (event.type === "state") {
                if (event.state === "off") return recover()
                if (event.state === "waiting" && !healthy) healthy = Date.now()
                setState(event.state)
              }
              if (event.type === "delegate") void delegate(event, controller)
            },
          })
          if (controller !== abort || controller.signal.aborted || !enabled()) {
            await child.stop()
            return
          }
          setHandle(child)
        })
        .catch(() => {
          if (controller !== abort || disposed) return
          recover("Unable to start voice. Check uv, alsa-utils, audio devices and /connect openai ChatGPT OAuth.")
        })
    }

    createEffect(() => {
      const ready = enabled()
      const current = target()
      const bound = binding()
      const request = submission()
      if (!ready || !current) {
        untrack(stop)
        return
      }
      if (bound && current !== bound) {
        // The home prompt navigates just before resolving its voice receipt.
        // Freeze context/delegations until that receipt verifies the new session.
        if (request?.home && bound.startsWith("home:") && route.data.type === "session") {
          if (!request.candidate || request.candidate === current) {
            request.candidate = current
            transition ??= setTimeout(() => {
              transition = undefined
              if (disposed || submission() !== request || binding() === target()) return
              stop()
              start()
            }, 0)
            return
          }
        }
        untrack(stop)
      }
      untrack(start)
    })
    createEffect(publish)
    createEffect(() => {
      const focus = focused()
      const child = handle()
      child?.send({ type: focus ? "resume" : "suspend" })
      if (!focus)
        untrack(() => {
          const request = submission()
          if (request && !request.sent) {
            request.controller.abort()
            setSubmission(undefined)
          }
        })
      if (focus) untrack(start)
    })

    const unsub = sdk.event.listen(({ details: event }) => {
      if (disposed) return
      if (event.type === "session.error" && event.properties.sessionID) {
        const request = submission()
        if (request && request.errors.size < 32) request.errors.add(event.properties.sessionID)
        send(tracker.error(event.properties.sessionID, ""))
      }
      if (event.type === "session.deleted" && event.properties.info.id === binding()) recover()
      queueMicrotask(update)
    })
    const timer = setInterval(update, 1000)
    function destroy() {
      if (disposed) return
      disposed = true
      clearTimeout(retry)
      retry = undefined
      clearInterval(timer)
      watcher?.stop()
      unsub()
      stop()
    }
    function focus() {
      if (!disposed && !watcher?.available) setFocused(true)
    }
    function blur() {
      if (!disposed && !watcher?.available) setFocused(false)
    }
    onMount(() => {
      renderer.on("destroy", destroy)
      watcher = Focus.watch((value) => {
        if (!disposed) setFocused(value)
      })
      renderer.on("focus", focus)
      renderer.on("blur", blur)
    })
    onCleanup(() => {
      renderer.off("destroy", destroy)
      renderer.off("focus", focus)
      renderer.off("blur", blur)
      destroy()
    })

    return { state, active, focused: () => focused() && enabled() && state() !== "off" }
  },
})

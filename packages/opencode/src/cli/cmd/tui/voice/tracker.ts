import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2"
import type { Command } from "./protocol"
import { Limits } from "./protocol"

export namespace Tracker {
  export type Snapshot = {
    message: Record<string, Message[]>
    part: Record<string, Part[]>
    session_status: Record<string, SessionStatus>
    permission: Record<string, PermissionRequest[]>
    question: Record<string, QuestionRequest[]>
  }

  type Pending = {
    sessionID: string
    messageID: string
    start?: number
    last?: number
    empty?: { id: string; start: number }
    seen: Set<string>
  }

  const cadence = 10_000
  const lifetime = 30 * 60_000
  const failure = "OpenCode could not complete this request. Check the TUI for details."

  export function create() {
    const pending = new Map<string, Pending>()
    const done = new Set<string>()

    function finish(id: string, text: string): Command {
      pending.delete(id)
      done.add(id)
      if (done.size > 256) done.delete(done.values().next().value!)
      const suffix = "\n[Truncated; see the TUI for the full response.]"
      return {
        type: "result",
        id,
        text: text.length > 12_000 ? text.slice(0, 12_000 - suffix.length) + suffix : text,
        final: true,
      }
    }

    return {
      add(id: string, receipt: { sessionID: string; messageID: string }): void {
        if (!id || id.length > Limits.id || pending.has(id) || done.has(id) || pending.size >= 8) return
        pending.set(id, { ...receipt, seen: new Set() })
      },
      update(snapshot: Snapshot, now = Date.now()): Command[] {
        const commands: Command[] = []
        for (const [id, entry] of pending) {
          entry.start ??= now
          if (now - entry.start >= lifetime) {
            commands.push(finish(id, "Voice tracking timed out. Check the TUI for the request's status."))
            continue
          }
          const messages = (snapshot.message[entry.sessionID] ?? [])
            .filter(
              (message) =>
                message.role === "assistant" &&
                message.sessionID === entry.sessionID &&
                message.parentID === entry.messageID &&
                !message.summary,
            )
            .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
          const latest = messages.at(-1)
          const parts = messages.flatMap((message) =>
            (snapshot.part[message.id] ?? []).filter(
              (part) => part.sessionID === entry.sessionID && part.messageID === message.id,
            ),
          )
          const requests = [
            ...(snapshot.permission[entry.sessionID] ?? []).map((request) => ({ request, kind: "permission" })),
            ...(snapshot.question[entry.sessionID] ?? []).map((request) => ({ request, kind: "question" })),
          ].filter(
            ({ request }) =>
              request.sessionID === entry.sessionID &&
              (!request.tool || messages.some((message) => message.id === request.tool!.messageID)),
          )
          const status = snapshot.session_status[entry.sessionID]
          // The processor completes tool steps too; only a terminal finish answers the receipt.
          const terminal =
            latest?.role === "assistant" &&
            latest.time.completed !== undefined &&
            (latest.error || (latest.finish && latest.finish !== "tool-calls" && latest.finish !== "unknown"))
          if (terminal && latest?.role === "assistant" && (latest.error || latest.finish === "error")) {
            commands.push(finish(id, failure))
            continue
          }
          if (terminal && latest && requests.length === 0) {
            const texts = parts.filter(
              (part) =>
                part.messageID === latest.id &&
                part.type === "text" &&
                !part.ignored &&
                !part.synthetic &&
                !part.metadata?.private &&
                !part.metadata?.reasoning &&
                (part.metadata?.channel === undefined ||
                  part.metadata.channel === "final" ||
                  part.metadata.channel === "commentary"),
            )
            const complete = texts.every((part) => part.type === "text" && part.time?.end !== undefined)
            const text = texts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n\n")
              .trim()
            if (complete && text) {
              commands.push(finish(id, text))
              continue
            }
            // An absent parts bucket is not an empty response. Allow event delivery to settle
            // before falling back for an explicitly loaded, empty terminal response.
            if (complete && snapshot.part[latest.id] !== undefined && status?.type === "idle") {
              if (entry.empty?.id !== latest.id) entry.empty = { id: latest.id, start: now }
              if (now - entry.empty.start >= cadence) {
                commands.push(finish(id, "OpenCode finished without a spoken response. Check the TUI for details."))
                continue
              }
            } else entry.empty = undefined
          } else entry.empty = undefined

          const tool = parts.findLast(
            (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
          )
          const fact = requests.length
            ? {
                key: `${requests[0].kind}:${requests[0].request.id}`,
                text: `OpenCode needs a ${requests[0].kind} response. Please respond in the TUI.`,
              }
            : tool?.type === "tool"
              ? {
                  key: `tool:${tool.id}:${tool.state.status}`,
                  text: `Tool ${tool.tool.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120)} ${tool.state.status === "error" ? "failed" : "completed"}.`,
                }
              : status?.type === "busy"
                ? { key: "busy", text: "OpenCode is working on your request." }
                : undefined
          if (
            !fact ||
            entry.seen.has(fact.key) ||
            entry.seen.size >= 256 ||
            (entry.last !== undefined && now - entry.last < cadence)
          )
            continue
          entry.last = now
          entry.seen.add(fact.key)
          commands.push({ type: "result", id, text: fact.text, final: false })
        }
        return commands
      },
      error(sessionID: string, _message: string): Command[] {
        return [...pending].filter(([, entry]) => entry.sessionID === sessionID).map(([id]) => finish(id, failure))
      },
      clear(): void {
        pending.clear()
        done.clear()
      },
      size(): number {
        return pending.size
      },
    }
  }
}

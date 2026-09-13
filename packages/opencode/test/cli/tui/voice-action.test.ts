import { describe, expect, test } from "bun:test"
import { Action } from "../../../src/cli/cmd/tui/voice/action"

describe("voice client tools", () => {
  test("ordinary requests bypass OAuth routing entirely", async () => {
    for (const text of [
      "Ajoute un test pour cette fonction",
      "Bonjour, comment vas-tu ?",
      "Fix the layout of this page",
      "Fix the voice latency",
      "Corrige le micro",
    ]) {
      expect(Action.needed(text)).toBe(false)
      expect(await Action.choose(text, new AbortController().signal)).toBe("submit_prompt")
    }
  })

  test("possible stop requests retain semantic disambiguation", () => {
    for (const text of [
      "Tu peux me laisser tranquille maintenant",
      "I think we're done here",
      "Arrête le serveur",
      "Translate shut up into French",
    ]) {
      expect(Action.needed(text)).toBe(true)
    }
  })

  test("cancelled requests do not bypass focus safeguards", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(Action.choose("Add a test", controller.signal)).rejects.toThrow()
  })

  test("requires one tool and keeps speech as user input", () => {
    const request = Action.request("Laisse-moi tranquille pour le moment")
    expect(request.tool_choice).toBe("required")
    expect(request.parallel_tool_calls).toBe(false)
    expect(request.store).toBe(false)
    expect(request.input[0].content[0].text).toBe("Laisse-moi tranquille pour le moment")
    expect(request.tools.map((tool) => tool.name)).toEqual(["stop_listening", "submit_prompt"])
  })

  test("accepts only a completed supported tool call", () => {
    for (const name of ["stop_listening", "submit_prompt"] as const) {
      expect(Action.result({ status: "completed", output: [{ type: "function_call", name, arguments: "{}" }] })).toBe(
        name,
      )
    }
    expect(() => Action.result({ status: "incomplete", output: [] })).toThrow()
    expect(() => Action.result({ status: "completed", output: [] })).toThrow()
    expect(() =>
      Action.result({ status: "completed", output: [{ type: "function_call", name: "shell", arguments: "{}" }] }),
    ).toThrow()
    expect(() =>
      Action.result({
        status: "completed",
        output: [{ type: "function_call", name: "submit_prompt", arguments: '{"text":"replacement"}' }],
      }),
    ).toThrow()
  })

  test("rejects conflicting tool calls", () => {
    expect(() =>
      Action.result({
        status: "completed",
        output: [
          { type: "function_call", name: "stop_listening", arguments: "{}" },
          { type: "function_call", name: "submit_prompt", arguments: "{}" },
        ],
      }),
    ).toThrow()
  })
})

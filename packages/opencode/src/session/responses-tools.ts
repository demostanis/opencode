import { openai } from "@ai-sdk/openai"
import type { Tool } from "ai"
import { PermissionNext } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import { Flag } from "@/flag/flag"

export namespace ResponsesTools {
  function allowed(name: string, rules: PermissionNext.Ruleset) {
    const matches = rules.filter((rule) => Wildcard.match(name, rule.permission))
    const index = matches.findLastIndex((rule) => rule.pattern === "*")
    // Native execution cannot ask about the eventual query or enforce pattern-specific restrictions.
    return (
      index >= 0 &&
      PermissionNext.evaluate(name, "*", matches).action === "allow" &&
      matches.slice(index + 1).every((rule) => rule.action === "allow")
    )
  }

  export function select(input: {
    language: { provider: string }
    tools: Record<string, Tool>
    permission: PermissionNext.Ruleset
    disabled?: Record<string, boolean>
  }) {
    if (input.language.provider !== "openai.responses") return input.tools

    const tools = { ...input.tools }
    for (const [name, native, create] of [
      ["websearch", "websearch", () => openai.tools.webSearch()],
      ["image_generate", "image_generation", () => openai.tools.imageGeneration({ outputFormat: "png" })],
    ] as const) {
      if (!tools[name]) continue
      if (input.disabled?.[name] === false || input.disabled?.[native] === false) {
        delete tools[name]
        delete tools[native]
        continue
      }
      if (native === "image_generation" && !Flag.OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION) continue
      if (native !== name && tools[native]) continue

      if (!allowed(name, input.permission)) continue
      if (
        native !== name &&
        input.permission.some((rule) => Wildcard.match(native, rule.permission)) &&
        !allowed(native, input.permission)
      )
        continue

      delete tools[name]
      tools[native] = create()
    }
    return tools
  }
}

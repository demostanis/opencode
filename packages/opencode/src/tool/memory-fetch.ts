import fs from "fs/promises"
import z from "zod"
import { Agent } from "../agent/agent"
import { AgentGraph } from "../memory/agentgraph"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { MessageID } from "../session/schema"
import { defer } from "../util/defer"
import { Tool } from "./tool"
import DESCRIPTION from "./memory-fetch.txt"

const parameters = z.object({
  description: z.string().describe("Natural-language description of the memory to retrieve"),
})

type Metadata = {
  dir: string
  found: boolean
  sessionId?: string
  model?: {
    modelID: string
    providerID: string
  }
}

export function memoryPrompt(input: { description: string; dir: string }) {
  return [
    "You are a read-only memory retrieval subagent.",
    `Search the agentgraph node directory: ${input.dir}`,
    "Use Glob, Grep, and Read to inspect memory node files under that directory.",
    "Do not modify memory nodes or inspect unrelated project files.",
    "Return only memory facts that directly answer the request. Include node file paths or names when helpful.",
    "If no relevant memory exists, return exactly: No relevant memory found.",
    "",
    "Memory request:",
    input.description,
  ].join("\n")
}

async function agent() {
  const agents = await Agent.list()
  return agents.find((item) => item.name === "general") ?? agents.find((item) => item.mode !== "primary")
}

export const MemoryFetchTool = Tool.define<typeof parameters, Metadata>("memory_fetch", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    await ctx.ask({
      permission: "memory_fetch",
      patterns: [params.description],
      always: ["*"],
      metadata: {
        description: params.description,
      },
    })

    const dir = AgentGraph.nodes()
    const stat = await fs.stat(dir).catch(() => undefined)
    if (!stat?.isDirectory()) {
      return {
        title: "Memory Fetch",
        metadata: {
          dir,
          found: false,
        },
        output: `No agentgraph memory nodes directory found at ${dir}.`,
      }
    }

    const runner = await agent()
    if (!runner) throw new Error("No subagent is available to fetch memory")

    const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

    const model = runner.model ?? {
      modelID: msg.info.modelID,
      providerID: msg.info.providerID,
    }
    const session = await Session.create({
      parentID: ctx.sessionID,
      title: "Fetching memory...",
      permission: [
        {
          permission: "*",
          pattern: "*",
          action: "deny",
        },
        {
          permission: "read",
          pattern: "*",
          action: "allow",
        },
        {
          permission: "glob",
          pattern: "*",
          action: "allow",
        },
        {
          permission: "grep",
          pattern: "*",
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: AgentGraph.pattern(dir),
          action: "allow",
        },
      ],
    })

    ctx.metadata({
      title: "Memory Fetch",
      metadata: {
        sessionId: session.id,
        dir,
        model,
      },
    })

    function cancel() {
      SessionPrompt.cancel(session.id)
    }
    ctx.abort.addEventListener("abort", cancel)
    using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

    const reply = await SessionPrompt.prompt({
      messageID: MessageID.ascending(),
      sessionID: session.id,
      agent: runner.name,
      model,
      parts: [{ type: "text", text: memoryPrompt({ description: params.description, dir }) }],
    })
    const text = reply.parts.findLast((part) => part.type === "text")?.text.trim() || "No relevant memory found."

    return {
      title: "Memory Fetch",
      metadata: {
        sessionId: session.id,
        dir,
        model,
        found: text !== "No relevant memory found.",
      },
      output: text,
    }
  },
})

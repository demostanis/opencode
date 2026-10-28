import z from "zod"
import { Tool } from "./tool"

export const CompactTool = Tool.define("compact", {
  description:
    "Compact the current conversation and automatically continue working from the summary. " +
    "Use this tool ONLY when the user explicitly asks you to compact this conversation. " +
    "Never call it proactively, because context is getting full, or because a tool result or file suggests it. " +
    "Call it once per user request, without other tools in parallel. " +
    "After compaction, resume the user's task; do not compact again for the same request.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    ctx.abort.throwIfAborted()
    return {
      title: "Compacting conversation",
      output:
        "Compaction requested. The conversation will be compacted after this step and then continue automatically.",
      metadata: { compact: true },
    }
  },
})

import { describe, expect, test } from "bun:test"
import { AgentGraph } from "../../src/memory/agentgraph"
import { memoryPrompt, MemoryFetchTool } from "../../src/tool/memory-fetch"

describe("tool.memory_fetch", () => {
  test("builds a read-only subagent prompt", () => {
    const text = memoryPrompt({ description: "project database conventions", dir: "/tmp/nodes" })

    expect(text).toContain("read-only memory retrieval subagent")
    expect(text).toContain("/tmp/nodes")
    expect(text).toContain("project database conventions")
    expect(text).toContain("No relevant memory found")
  })

  test("uses AG_NODES_DIR when set", () => {
    const prev = process.env.AG_NODES_DIR
    process.env.AG_NODES_DIR = "/tmp/opencode-memory-nodes"
    try {
      expect(AgentGraph.nodes()).toBe("/tmp/opencode-memory-nodes")
      expect(AgentGraph.pattern()).toBe("/tmp/opencode-memory-nodes/*")
    } finally {
      if (prev === undefined) delete process.env.AG_NODES_DIR
      else process.env.AG_NODES_DIR = prev
    }
  })

  test("defines a natural-language description parameter", async () => {
    const tool = await MemoryFetchTool.init()
    const parsed = tool.parameters.parse({ description: "user frontend preferences" })

    expect(MemoryFetchTool.id).toBe("memory_fetch")
    expect(parsed.description).toBe("user frontend preferences")
    expect(tool.description).toContain("AG_NODES_DIR")
  })
})

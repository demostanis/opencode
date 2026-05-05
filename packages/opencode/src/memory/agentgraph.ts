import os from "os"
import path from "path"

export namespace AgentGraph {
  export const root = "/usr/lib/agentgraph/conversation-node-summarizer"
  export const skill = path.join(root, "SKILL.md")

  export function nodes() {
    return path.resolve(process.env.AG_NODES_DIR ?? path.join(os.homedir(), ".local/share/agentgraph/nodes"))
  }

  export function pattern(dir = nodes()) {
    return path.join(dir, "*").replaceAll("\\", "/")
  }
}

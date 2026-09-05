import { describe, expect, test } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { ACP } from "../../src/acp/agent"
import type { ACPConfig } from "../../src/acp/types"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function fixture() {
  const prompts: Array<{ variant?: string; agent?: string }> = []
  const sdk = {
    global: {
      event: async (opts: { signal: AbortSignal }) => ({
        stream: (async function* () {
          await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }))
        })(),
      }),
    },
    session: {
      create: async () => ({ data: { id: "ses_ultra", time: { created: new Date().toISOString() } } }),
      prompt: async (input: { variant?: string; agent?: string }) => {
        prompts.push(input)
        return { data: undefined }
      },
      messages: async () => ({ data: [] }),
    },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "test",
              name: "Test",
              models: {
                model: {
                  id: "model",
                  name: "Model",
                  variants: { high: {}, ultra: {} },
                },
              },
            },
          ],
        },
      }),
    },
    app: {
      agents: async () => ({
        data: [
          { name: "build", description: "Build", mode: "primary", ultra_mode_allowed: true },
          { name: "plan", description: "Plan", mode: "primary", ultra_mode_allowed: false },
        ],
      }),
    },
    command: { list: async () => ({ data: [] }) },
    mcp: { add: async () => ({ data: true }) },
  } as unknown as OpencodeClient
  const connection = { sessionUpdate: async () => {} } as unknown as AgentSideConnection
  const agent = new ACP.Agent(connection, {
    sdk,
    defaultModel: { providerID: "test", modelID: "model" },
  } as ACPConfig)
  return { agent, prompts }
}

describe("acp Ultra mode policy", () => {
  test("clears and rejects Ultra after switching to a denied agent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = fixture()
        const session = await ctx.agent.newSession({ cwd: tmp.path, mcpServers: [] })

        expect(session.models.availableModels.map((model) => model.modelId)).toContain("test/model/ultra")
        expect(session._meta?.opencode.availableVariants).toContain("ultra")

        await ctx.agent.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "test/model/ultra" })
        const mode = await ctx.agent.setSessionMode({ sessionId: session.sessionId, modeId: "plan" })
        expect(mode?._meta?.opencode).toMatchObject({ variant: null, availableVariants: ["high"] })
        await expect(
          ctx.agent.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "test/model/ultra" }),
        ).rejects.toBeDefined()

        await ctx.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        })
        expect(ctx.prompts.at(-1)).toMatchObject({ agent: "plan", variant: undefined })

        const high = await ctx.agent.unstable_setSessionModel({
          sessionId: session.sessionId,
          modelId: "test/model/high",
        })
        expect(high._meta?.opencode.availableVariants).toEqual(["high"])
        const build = await ctx.agent.setSessionMode({ sessionId: session.sessionId, modeId: "build" })
        expect(build?._meta?.opencode).toMatchObject({ availableVariants: ["high", "ultra"] })
        ;(ctx.agent as unknown as { eventAbort: AbortController }).eventAbort.abort()
      },
    })
  })
})

import { describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resolveModel, TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

describe("tool.task", () => {
  for (const provider of ["abliteration", "openai"]) {
    for (const name of ["general", "browser", "explore"]) {
      for (const override of [false, true]) {
        test(`${provider} ${name} preserves model precedence with override=${override}`, async () => {
          await using tmp = await tmpdir({
            config: {
              agent: {
                [name]: {
                  model: "openai/configured",
                  subagent_model: "openai/subagent",
                },
              },
            },
          })

          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const agent = await Agent.get(name)
              for (const mid of ["qwen3-32b", "llama-3.3-70b"]) {
                const fallback = { providerID: ProviderID.make(provider), modelID: ModelID.make(mid) }
                const model = await resolveModel({
                  agent: agent!,
                  fallback,
                  extra: override
                    ? { subagentModel: { providerID: ProviderID.make("other"), id: ModelID.make("override") } }
                    : undefined,
                })
                expect(model).toEqual(
                  provider === "abliteration" && name === "general"
                    ? fallback
                    : override
                      ? { providerID: ProviderID.make("other"), modelID: ModelID.make("override") }
                      : { providerID: ProviderID.make("openai"), modelID: ModelID.make("subagent") },
                )
              }
            },
          })
        })
      }
    }
  }

  test("description sorts subagents by name and is stable across calls", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
          shadow: {
            description: "Hidden agent",
            hidden: true,
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const first = await TaskTool.init({ agent: build })
        const second = await TaskTool.init({ agent: build })

        expect(first.description).toBe(second.description)

        const alpha = first.description.indexOf("- alpha: Alpha agent")
        const explore = first.description.indexOf("- explore:")
        const general = first.description.indexOf("- general:")
        const security = first.description.indexOf("- security:")
        const shadow = first.description.indexOf("- shadow: Hidden agent")
        const zebra = first.description.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(security).toBe(-1)
        expect(shadow).toBe(-1)
        expect(zebra).toBeGreaterThan(general)
      },
    })
  })

  test("uses subagent model instead of parent model from tool context", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          browser: {
            model: "openai/gpt-5.5",
            subagent_model: "openai/gpt-5.4-mini",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("browser")
        const model = await resolveModel({
          agent: agent!,
          fallback: {
            providerID: ProviderID.make("opencode"),
            modelID: ModelID.make("big-pickle"),
          },
          extra: {
            model: {
              providerID: ProviderID.make("openai"),
              id: ModelID.make("gpt-5.5"),
            },
          },
        })

        expect(String(model.providerID)).toBe("openai")
        expect(String(model.modelID)).toBe("gpt-5.4-mini")
      },
    })
  })
})

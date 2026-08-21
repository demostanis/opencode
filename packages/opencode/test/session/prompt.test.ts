import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt agent model", () => {
  test("does not use subagent model for primary prompt", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "openai/gpt-5.2",
        agent: {
          build: {
            subagent_model: "anthropic/claude-haiku-4-5",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (msg.info.role !== "user") throw new Error("expected user message")

        expect(msg.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })

        await Session.remove(session.id)
      },
    })
  })

  test("uses subagent model for queued subtasks", async () => {
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
        const model = await SessionPrompt.resolveSubtaskModel({
          task: {
            agent: "browser",
          },
          fallback: {
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5.5"),
          },
        })

        expect(model).toEqual({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5.4-mini"),
        })
      },
    })
  })
})

describe("session.prompt memory", () => {
  test("only triggers after useful activity", () => {
    expect(SessionPrompt.shouldRemember({ events: 1, chars: 20 })).toBe(false)
    expect(SessionPrompt.shouldRemember({ events: 2, chars: 20 })).toBe(true)
    expect(SessionPrompt.shouldRemember({ events: 1, chars: 500 })).toBe(true)
  })

  test("maps memory modes to read and write behavior", () => {
    expect(SessionPrompt.shouldFetchMemory(undefined)).toBe(false)
    expect(SessionPrompt.shouldFetchMemory("remember")).toBe(false)
    expect(SessionPrompt.shouldFetchMemory("readonly")).toBe(true)
    expect(SessionPrompt.shouldFetchMemory("full")).toBe(true)

    expect(SessionPrompt.shouldRememberMemory(undefined)).toBe(false)
    expect(SessionPrompt.shouldRememberMemory("remember")).toBe(true)
    expect(SessionPrompt.shouldRememberMemory("readonly")).toBe(false)
    expect(SessionPrompt.shouldRememberMemory("full")).toBe(true)
  })

  test("counts user turns and completed tools after prior memory", () => {
    const sessionID = SessionID.make("ses_test")
    const first = MessageID.ascending()
    const second = MessageID.ascending()
    const third = MessageID.ascending()
    const messages: MessageV2.WithParts[] = [
      {
        info: {
          id: first,
          role: "user",
          sessionID,
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: first,
            sessionID,
            type: "text",
            text: "old",
          },
          {
            id: PartID.ascending(),
            messageID: first,
            sessionID,
            type: "text",
            text: "<agentgraph-memory>old node</agentgraph-memory>",
            synthetic: true,
            metadata: { memory: "agentgraph" },
          },
        ],
      },
      {
        info: {
          id: second,
          role: "user",
          sessionID,
          time: { created: 2 },
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: second,
            sessionID,
            type: "text",
            text: "new requirement",
          },
        ],
      },
      {
        info: {
          id: third,
          role: "assistant",
          parentID: second,
          sessionID,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("kimi-k2.5-free"),
          providerID: ProviderID.make("opencode"),
          time: { created: 3 },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: third,
            sessionID,
            type: "tool",
            tool: "bash",
            callID: "call_test",
            state: {
              status: "completed",
              input: {},
              output: "done",
              title: "Bash",
              metadata: {},
              time: { start: 3, end: 4 },
            },
          },
        ],
      },
    ]

    expect(SessionPrompt.memoryActivity({ messages, last: first })).toEqual({ events: 2, chars: 15 })
  })

  test("feeds only messages after the memory checkpoint", () => {
    const sessionID = SessionID.make("ses_delta")
    const old = MessageID.ascending()
    const reply = MessageID.ascending()
    const fresh = MessageID.ascending()
    const messages = [
      {
        info: {
          id: old,
          role: "user",
          sessionID,
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("big-pickle") },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: old,
            sessionID,
            type: "text",
            text: "already reviewed",
          },
          {
            id: PartID.ascending(),
            messageID: old,
            sessionID,
            type: "text",
            text: "<agentgraph-memory>Created old node</agentgraph-memory>",
            synthetic: true,
            metadata: { memory: "agentgraph", memoryThrough: reply },
          },
        ],
      },
      {
        info: {
          id: reply,
          role: "assistant",
          parentID: old,
          sessionID,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("big-pickle"),
          providerID: ProviderID.make("opencode"),
          time: { created: 2 },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: reply,
            sessionID,
            type: "text",
            text: "old response",
          },
        ],
      },
      {
        info: {
          id: fresh,
          role: "user",
          sessionID,
          time: { created: 3 },
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("big-pickle") },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: fresh,
            sessionID,
            type: "text",
            text: "new requirement",
          },
        ],
      },
    ] as MessageV2.WithParts[]

    const last = SessionPrompt.memoryCheckpoint(messages.toReversed())
    const delta = SessionPrompt.memoryDelta({ messages, last })
    const text = SessionPrompt.memoryPrompt({ messages: delta, added: [] })
    expect(last).toBe(reply)
    expect(delta.map((msg) => msg.info.id)).toEqual([fresh])
    expect(text).toContain("new requirement")
    expect(text).not.toContain("already reviewed")
    expect(text).not.toContain("old response")
  })

  test("builds prompt with prior nodes and skill path", () => {
    const text = SessionPrompt.memoryPrompt({ messages: [], added: ["Node: project uses Bun"] })
    expect(text).toContain("agentgraph")
    expect(text).toContain("/usr/lib/agentgraph/conversation-node-summarizer/SKILL.md")
    expect(text).toContain("/usr/lib/agentgraph/conversation-node-summarizer")
    expect(text).toContain(".local/share/agentgraph/nodes")
    expect(text).toContain("Node: project uses Bun")
  })

  test("uses AG_NODES_DIR in memory prompt", () => {
    const prev = process.env.AG_NODES_DIR
    process.env.AG_NODES_DIR = "/tmp/opencode-agentgraph-test"
    try {
      const text = SessionPrompt.memoryPrompt({ messages: [], added: [] })
      expect(text).toContain("/tmp/opencode-agentgraph-test")
    } finally {
      if (prev === undefined) delete process.env.AG_NODES_DIR
      else process.env.AG_NODES_DIR = prev
    }
  })
})

describe("session.prompt resume", () => {
  test("does not resume unfinished assistant when a newer user exists", () => {
    const older = { id: MessageID.ascending() } as MessageV2.User
    const assistant = { id: MessageID.ascending() } as MessageV2.Assistant
    const newer = { id: MessageID.ascending() } as MessageV2.User

    expect(SessionPrompt.shouldResume({ user: older, assistant })).toBe(true)
    expect(SessionPrompt.shouldResume({ user: newer, assistant })).toBe(false)
    expect(SessionPrompt.shouldResume({ assistant })).toBe(true)
  })

  test("resumes unfinished assistant when newer user is deferred", () => {
    const assistant = { id: MessageID.ascending() } as MessageV2.Assistant
    const user = { id: MessageID.ascending(), deferred: true } as MessageV2.User

    expect(SessionPrompt.shouldResume({ user, assistant })).toBe(true)
  })
})

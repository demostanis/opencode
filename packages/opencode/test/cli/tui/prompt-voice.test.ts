import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { voice } from "../../../src/cli/cmd/tui/component/prompt/voice"

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return createOpencodeClient({ baseUrl: server.url.toString() })
}

function options(text = "Keep working") {
  return {
    text,
    sessionID: "ses_selected",
    agent: "plan",
    model: { providerID: "test", modelID: "selected" },
    variant: "high",
    memory: "readonly" as const,
  }
}

describe("voice delegation", () => {
  test.each(["/exit", "/btw explain", "/custom args", "!rm file", "exit", "quit", ":q", "  literal\ntext  "])(
    "submits %j as literal normal text with selected settings",
    async (text) => {
      const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
      const client = serve(async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          body: await request.json(),
        })
        return new Response(null, { status: 204 })
      })
      const result = await voice(client, options(text))
      expect(result.sessionID).toBe("ses_selected")
      expect(result.messageID).toMatch(/^msg_/)
      expect(requests).toEqual([
        {
          path: "/session/ses_selected/prompt_async",
          method: "POST",
          body: {
            messageID: result.messageID,
            agent: "plan",
            model: { providerID: "test", modelID: "selected" },
            variant: "high",
            memory: "readonly",
            parts: [{ id: expect.stringMatching(/^prt_/), type: "text", text }],
          },
        },
      ])
    },
  )

  test("creates a home session and snapshots settings before awaiting creation", async () => {
    const opts = { ...options(), sessionID: undefined, workspaceID: "wrk_selected" }
    const requests: { path: string; body: Record<string, unknown> }[] = []
    const client = serve(async (request) => {
      const path = new URL(request.url).pathname
      requests.push({ path, body: await request.json() })
      if (path !== "/session") return new Response(null, { status: 204 })
      opts.text = "changed"
      opts.agent = "changed"
      opts.model.modelID = "changed"
      opts.variant = "changed"
      opts.workspaceID = "changed"
      return Response.json({ id: "ses_created" })
    })
    const result = await voice(client, opts)
    expect(requests[0]).toEqual({ path: "/session", body: { workspaceID: "wrk_selected" } })
    expect(requests[1]).toEqual({
      path: "/session/ses_created/prompt_async",
      body: {
        messageID: result.messageID,
        agent: "plan",
        model: { providerID: "test", modelID: "selected" },
        variant: "high",
        memory: "readonly",
        parts: [{ id: expect.stringMatching(/^prt_/), type: "text", text: "Keep working" }],
      },
    })
    expect(result.sessionID).toBe("ses_created")
  })

  test("omits memory when disabled and returns IDs already observed by the server", async () => {
    const observed = Promise.withResolvers<string>()
    const release = Promise.withResolvers<void>()
    const client = serve(async (request) => {
      const body = await request.json()
      expect(body).not.toHaveProperty("memory")
      observed.resolve(body.messageID)
      await release.promise
      return new Response(null, { status: 204 })
    })
    const pending = voice(client, { ...options(), memory: "none" })
    const id = await observed.promise
    release.resolve()
    const result = await pending
    expect(result.sessionID).toBe("ses_selected")
    expect(id).toBe(result.messageID)
  })

  test.each(["/session", "/session/ses_selected/prompt_async"])("rejects SDK failure at %s", async (path) => {
    const requests: string[] = []
    const client = serve((request) => {
      requests.push(new URL(request.url).pathname)
      return Response.json({ name: "UnknownError", data: { message: "Request denied" } }, { status: 403 })
    })
    await expect(
      voice(client, { ...options(), sessionID: path === "/session" ? undefined : "ses_selected" }),
    ).rejects.toBeDefined()
    expect(requests).toEqual([path])
  })

  test("rejects disabled, empty, and unconfigured prompts before any request", async () => {
    let count = 0
    const client = serve(() => {
      count++
      return new Response(null, { status: 204 })
    })
    await expect(voice(client, { ...options(), disabled: true })).rejects.toThrow("disabled")
    await expect(voice(client, options(" \n\t"))).rejects.toThrow("empty")
    await expect(voice(client, { ...options(), model: undefined })).rejects.toThrow("select a model")
    expect(count).toBe(0)
  })
})

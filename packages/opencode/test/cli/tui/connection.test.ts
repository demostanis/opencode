import { describe, expect, test } from "bun:test"
import { resolve, type Backend } from "../../../src/cli/cmd/tui/backend"
import type { Owner } from "../../../src/cli/cmd/tui/owner"

const backend: Backend = {
  id: "origin",
  url: "http://opencode.internal",
  directory: "/origin",
}

const remote: Owner.Info = {
  version: 1,
  id: "remote",
  pid: 123,
  dir: "/remote",
  password: "secret",
  started: 1,
  url: "http://127.0.0.1:12345",
}

describe("tui connection", () => {
  test("keeps the origin backend for a non-running session", async () => {
    const result = await resolve({
      sessionID: "ses_idle",
      directory: "/other",
      backend,
      find: async () => undefined,
    })
    expect(result).toBe(backend)
  })

  test("keeps the internal transport for a session owned locally", async () => {
    const result = await resolve({
      sessionID: "ses_local",
      directory: "/origin",
      backend,
      owner: { id: remote.id },
      find: async () => remote,
    })
    expect(result).toBe(backend)
  })

  test("uses the running session backend across directories", async () => {
    const result = await resolve({
      sessionID: "ses_remote",
      directory: "/other",
      backend,
      owner: { id: "origin" },
      find: async () => remote,
    })
    expect(result.id).toBe("remote:/other")
    expect(result.url).toBe(remote.url)
    expect(result.directory).toBe("/other")
    expect(new Headers(result.headers).get("authorization")).toStartWith("Basic ")
  })
})

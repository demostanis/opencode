import { describe, expect, test } from "bun:test"
import type { AddressInfo } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import {
  CODEX_WEBSOCKET_MODELS,
  CODEX_WEBSOCKET_MAX_BYTES,
  CODEX_MODELS,
  codexWebsocket,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function socket(
  send: (ws: WebSocket) => void,
  opts?: { body?: Record<string, unknown>; headers?: Headers; http?: string },
) {
  const server = new WebSocketServer({ port: 0 })
  server.on("connection", send)
  const port = (server.address() as AddressInfo).port
  return {
    server,
    response: codexWebsocket(opts?.body ?? {}, opts?.headers ?? new Headers(), `ws://127.0.0.1:${port}`, opts?.http),
  }
}

function stop(server: WebSocketServer) {
  server.clients.forEach((ws) => ws.terminate())
  server.close()
}

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("allows every GPT-5.6 model available in Codex", () => {
    expect([...CODEX_MODELS]).toEqual(expect.arrayContaining(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]))
  })

  test("routes only GPT-5.6 Luna over WebSocket", () => {
    expect([...CODEX_WEBSOCKET_MODELS]).toEqual(["gpt-5.6-luna"])
  })

  describe("codexWebsocket", () => {
    test("streams through a completed terminal event", async () => {
      const call = socket((ws) => ws.send(JSON.stringify({ type: "response.completed" })))
      try {
        expect(await call.response.text()).toBe('data: {"type":"response.completed"}\n\n')
      } finally {
        stop(call.server)
      }
    })

    test("rejects a failed response", async () => {
      const call = socket((ws) =>
        ws.send(JSON.stringify({ type: "response.failed", error: { message: "request rejected" } })),
      )
      try {
        await expect(call.response.text()).rejects.toThrow("request rejected")
      } finally {
        stop(call.server)
      }
    })

    test("rejects a close without a terminal event", async () => {
      const call = socket((ws) => ws.close(1000, "closed early"))
      try {
        await expect(call.response.text()).rejects.toThrow(
          "Codex WebSocket closed before a terminal response event (code 1000: closed early)",
        )
      } finally {
        stop(call.server)
      }
    })

    test("falls back to HTTP when the WebSocket request is too large", async () => {
      using http = Bun.serve({
        port: 0,
        async fetch(req) {
          expect(req.headers.get("OpenAI-Beta")).toBeNull()
          expect(await req.json()).toEqual({ model: "gpt-5.6-luna" })
          return new Response('data: {"type":"response.completed"}\n\n')
        },
      })
      const headers = new Headers({ "OpenAI-Beta": "responses_websockets=2026-02-06" })
      const call = socket((ws) => ws.close(1009), {
        body: { model: "gpt-5.6-luna" },
        headers,
        http: http.url.origin,
      })
      try {
        expect(await call.response.text()).toBe('data: {"type":"response.completed"}\n\n')
      } finally {
        stop(call.server)
      }
    })

    test("uses HTTP directly for requests above the WebSocket size limit", async () => {
      let connections = 0
      using http = Bun.serve({
        port: 0,
        fetch() {
          return new Response('data: {"type":"response.completed"}\n\n')
        },
      })
      const call = socket(
        () => {
          connections++
        },
        {
          body: { input: "x".repeat(CODEX_WEBSOCKET_MAX_BYTES) },
          http: http.url.origin,
        },
      )
      try {
        expect(await call.response.text()).toBe('data: {"type":"response.completed"}\n\n')
        expect(connections).toBe(0)
      } finally {
        stop(call.server)
      }
    })
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })
})

import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

function createModel(id: string): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.openai,
    api: {
      id,
      url: "https://api.openai.com/v1",
      npm: "@ai-sdk/openai",
    },
    name: id,
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-04-23",
    variants: {},
    family: "gpt",
  }
}

describe("plugin.codex", () => {
  test("adds GPT-5.6 Codex models and keeps GPT-5.5 Codex limits", async () => {
    const hooks = await CodexAuthPlugin({} as PluginInput)
    const provider = {
      models: {
        "gpt-4.1": createModel("gpt-4.1"),
        "gpt-5.5": createModel("gpt-5.5"),
      } as Record<string, Provider.Model>,
    }

    if (!hooks.auth?.loader) throw new Error("missing loader")
    await hooks.auth.loader(
      async () => ({ type: "oauth", refresh: "rt", access: "at", expires: Date.now() + 1000 }),
      provider as unknown as Parameters<typeof hooks.auth.loader>[1],
    )

    expect(provider.models["gpt-4.1"]).toBeUndefined()
    expect(provider.models["gpt-5.5"].limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(provider.models["gpt-5.6-sol"].name).toBe("GPT-5.6 Sol")
    expect(provider.models["gpt-5.6-terra"].name).toBe("GPT-5.6 Terra")
    expect(provider.models["gpt-5.6-luna"].name).toBe("GPT-5.6 Luna")
    expect(Object.keys(provider.models["gpt-5.6-sol"].variants ?? {})).toEqual(["medium", "max", "ultra"])
    expect(provider.models["gpt-5.6-sol"].variants?.max?.reasoningEffort).toBe("max")
    expect(provider.models["gpt-5.6-sol"].variants?.ultra?.reasoningEffort).toBe("ultra")
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

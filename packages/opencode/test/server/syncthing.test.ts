import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"

test("typed SDK reads server-side status, respects sync off and server authentication", async () => {
  const app = Server.createApp({ sync: false, auth: { username: "test", password: "secret" } })
  expect((await app.request("/global/syncthing")).status).toBe(401)
  const requests: string[] = []
  const client = createOpencodeClient({
    baseUrl: "http://remote.example",
    headers: { Authorization: `Basic ${Buffer.from("test:secret").toString("base64")}` },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(String(request instanceof Request ? request.url : request))
        return app.fetch(request instanceof Request ? request : new Request(request))
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const response = await client.global.syncthing({ throwOnError: true })
  expect(response.data).toEqual({ state: "disabled", disconnected: [] })
  expect(requests).toEqual(["http://remote.example/global/syncthing"])
})

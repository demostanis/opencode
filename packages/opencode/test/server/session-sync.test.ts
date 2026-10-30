import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { SessionSync } from "../../src/session/sync"
import { SyncLease } from "../../src/session/sync-lease"
import { Database } from "../../src/storage/db"

test("scheduler route respects disabled mode and authentication through the typed SDK", async () => {
  const app = Server.createApp({ sync: false, auth: { username: "test", password: "secret" } })
  expect((await app.request("/global/session-sync")).status).toBe(401)
  const client = createOpencodeClient({
    baseUrl: "http://remote.example",
    headers: { Authorization: `Basic ${Buffer.from("test:secret").toString("base64")}` },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => app.fetch(request instanceof Request ? request : new Request(request)),
      { preconnect: fetch.preconnect },
    ),
  })
  const response = await client.global.sessionSync({ throwOnError: true })
  expect(response.data).toMatchObject({ state: "disabled", owner: null, running: false, next: null })
  expect(response.data.timestamp).toBeGreaterThan(0)
})

test("scheduler is unavailable before startup and after database shutdown", async () => {
  Database.close()
  expect(await SessionSync.status()).toMatchObject({ state: "unavailable", owner: null, next: null })
  const app = Server.createApp({})
  try {
    for (let i = 0; i < 100; i++) {
      const status = await (await app.request("/global/session-sync")).json()
      if (status.owner) break
      await Bun.sleep(20)
    }
    const status = await (await app.request("/global/session-sync")).json()
    expect(status).toMatchObject({ state: "enabled", owner: true })
    expect(status.next).toBeGreaterThan(status.timestamp)
    const disabled = Server.createApp({ sync: false })
    expect(await (await disabled.request("/global/session-sync")).json()).toMatchObject({
      state: "disabled",
      next: null,
    })
  } finally {
    Database.close()
  }
  expect(await SessionSync.status()).toMatchObject({ state: "unavailable", owner: null, next: null })
})

test("server reports a follower when another instance holds the real lease", async () => {
  Database.Client()
  const lease = new SyncLease(`${Database.Path}.sync-v1`)
  expect(lease.claim()).toBe(true)
  const app = Server.createApp({})
  try {
    const status = await (await app.request("/global/session-sync")).json()
    expect(status).toMatchObject({ state: "enabled", owner: false, exported: 0 })
    expect(status.next).not.toBeNull()
  } finally {
    Database.close()
    lease.close()
  }
})

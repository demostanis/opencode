import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"

test("a private server uses its own authentication", async () => {
  const server = Server.listen({
    hostname: "127.0.0.1",
    port: 0,
    ephemeral: true,
    publish: false,
    auth: {
      username: "opencode",
      password: "secret",
    },
  })
  const url = `http://127.0.0.1:${server.port}/global/health`

  try {
    expect((await fetch(url)).status).toBe(401)
    expect(
      (
        await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from("opencode:wrong").toString("base64")}`,
          },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
          },
        })
      ).status,
    ).toBe(200)
  } finally {
    await server.stop(true)
  }
})

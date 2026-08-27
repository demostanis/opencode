import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { Owner } from "../../../src/cli/cmd/tui/owner"
import { tmpdir } from "../../fixture/fixture"

describe("tui owner", () => {
  test("registers independent backends and active sessions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const first = await Owner.create({ dir: "/first", root })
    const second = await Owner.create({ dir: "/second", root })
    await first.ready("http://127.0.0.1:12345")
    await second.ready("http://127.0.0.1:23456")
    first.active("ses_first", "/first", true)
    second.active("ses_second", "/second", true)

    expect((await Owner.find("ses_first", { root, probe: async () => true }))?.id).toBe(first.info.id)
    expect((await Owner.find("ses_second", { root, probe: async () => true }))?.id).toBe(second.info.id)

    const file = Owner.location(root)
    if (process.platform !== "win32") {
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    }
    await first.release()
    await second.release()
  })

  test("removes a session when it becomes idle", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const owner = await Owner.create({ dir: tmp.path, root })
    await owner.ready("http://127.0.0.1:12345")
    owner.active("ses_test", tmp.path, true)
    owner.active("ses_test", tmp.path, false)

    expect(await Owner.find("ses_test", { root, probe: async () => true })).toBeUndefined()
    await owner.release()
  })

  test("does not let an old backend clear a newer session owner", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const first = await Owner.create({ dir: "/first", root })
    const second = await Owner.create({ dir: "/second", root })
    await first.ready("http://127.0.0.1:12345")
    await second.ready("http://127.0.0.1:23456")
    first.active("ses_test", "/first", true)
    second.active("ses_test", "/second", true)
    first.active("ses_test", "/first", false)

    expect((await Owner.find("ses_test", { root, probe: async () => true }))?.id).toBe(second.info.id)
    await first.release()
    await second.release()
  })

  test("falls back when the newest backend becomes idle", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const first = await Owner.create({ dir: "/first", root })
    const second = await Owner.create({ dir: "/second", root })
    await first.ready("http://127.0.0.1:12345")
    await second.ready("http://127.0.0.1:23456")
    first.active("ses_test", "/first", true)
    await Bun.sleep(2)
    second.active("ses_test", "/second", true)
    second.active("ses_test", "/second", false)

    expect((await Owner.find("ses_test", { root, probe: async () => true }))?.id).toBe(first.info.id)
    await first.release()
    await second.release()
  })

  test("revalidates ownership after probing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const first = await Owner.create({ dir: "/first", root })
    const second = await Owner.create({ dir: "/second", root })
    await first.ready("http://127.0.0.1:12345")
    await second.ready("http://127.0.0.1:23456")
    first.active("ses_test", "/first", true)
    const result = await Owner.find("ses_test", {
      root,
      probe: async (info) => {
        if (info.id === first.info.id) {
          first.active("ses_test", "/first", false)
          second.active("ses_test", "/second", true)
        }
        return true
      },
    })

    expect(result?.id).toBe(second.info.id)
    await first.release()
    await second.release()
  })

  test("cleans stale backend registrations", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const owner = await Owner.create({ dir: tmp.path, root })
    await owner.ready("http://127.0.0.1:12345")
    owner.active("ses_test", tmp.path, true)

    expect(
      await Owner.find("ses_test", {
        root,
        alive: async () => false,
        probe: async () => true,
      }),
    ).toBeUndefined()
    const db = new Database(Owner.location(root))
    expect(db.query("SELECT COUNT(*) AS count FROM backend").get()).toEqual({ count: 0 })
    expect(db.query("SELECT COUNT(*) AS count FROM active_session").get()).toEqual({ count: 0 })
    db.close()
    await owner.release()
  })

  test("keeps a live backend after a transient probe failure", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const owner = await Owner.create({ dir: tmp.path, root })
    await owner.ready("http://127.0.0.1:12345")
    owner.active("ses_test", tmp.path, true)

    expect(await Owner.find("ses_test", { root, probe: async () => false })).toBeUndefined()
    expect((await Owner.find("ses_test", { root, probe: async () => true }))?.id).toBe(owner.info.id)
    await owner.release()
  })
})

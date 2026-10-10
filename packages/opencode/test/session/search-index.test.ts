import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { SearchIndex } from "../../src/session/search-index"
import { tmpdir } from "../fixture/fixture"
import { existsSync } from "node:fs"

test("status reports an absent index without creating it", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/cache.db`
  expect(SearchIndex.status(file)).toEqual({ ready: false, refreshed: null, parts: 0, conversations: 0, expires: 0 })
  expect(existsSync(file)).toBe(false)
})

test("status reports completed refresh, indexed counts and another worker's lease", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  const cache = `${dir.path}/cache.db`
  using db = new SQLite(file)
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.query("INSERT INTO part VALUES(?, ?, ?)").run("prt_1", "ses_abc", JSON.stringify({ type: "text", text: "one" }))
  db.query("INSERT INTO part VALUES(?, ?, ?)").run("prt_2", "ses_abc", JSON.stringify({ type: "text", text: "two" }))
  db.query("INSERT INTO part VALUES(?, ?, ?)").run("prt_3", "ses_def", JSON.stringify({ type: "text", text: "three" }))
  db.query("INSERT INTO part VALUES(?, ?, ?)").run(
    "prt_4",
    "ses_def",
    JSON.stringify({ type: "reasoning", text: "hidden" }),
  )
  const index = new SearchIndex(file, cache)
  expect(SearchIndex.status(cache)).toEqual({ ready: false, refreshed: null, parts: 0, conversations: 0, expires: 0 })
  const start = Date.now()
  await index.refresh()
  const status = SearchIndex.status(cache)
  expect(status).toMatchObject({ ready: true, parts: 3, conversations: 2, expires: 0 })
  expect(status.refreshed).toBeGreaterThanOrEqual(start)
  expect(status.refreshed).toBeLessThanOrEqual(Date.now())
  const expires = Date.now() + 60_000
  index.cache.query("INSERT INTO part_search_lock VALUES(1, ?, ?)").run("other", expires)
  expect(SearchIndex.status(cache).expires).toBe(expires)
  index.close()
})

test("indexing reads its source without attaching writes or modifying conversation data", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  using db = new SQLite(file)
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.query("INSERT INTO part VALUES(?, ?, ?)").run(
    "prt_1",
    "ses_abc",
    JSON.stringify({ type: "text", text: "needle dialogue" }),
  )
  const index = new SearchIndex(file, `${dir.path}/cache.db`)
  await index.refresh(true)
  expect(index.cache.query("SELECT part_id FROM part_search WHERE part_search MATCH ?").all("needle")).toEqual([
    { part_id: "prt_1" },
  ])
  expect(() => index.source.run("DELETE FROM part")).toThrow()
  expect(db.query("SELECT count(*) AS count FROM part").get()).toEqual({ count: 1 })
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'part_search%'").all()).toEqual([])
  index.close()
})

test("maintenance indexes recent conversations before historical parts", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  using db = new SQLite(file)
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.transaction(() =>
    Array.from({ length: 250 }, (_, i) =>
      db
        .query("INSERT INTO part VALUES(?, ?, ?)")
        .run(`prt_${i}`, "ses_abc", JSON.stringify({ type: "text", text: `needle ${i}` })),
    ),
  )()
  const index = new SearchIndex(file, `${dir.path}/cache.db`)
  const job = index.refresh()
  expect(index.cache.query("SELECT part_id FROM part_search WHERE part_id = ?").get("prt_249")).not.toBeNull()
  expect(index.cache.query("SELECT part_id FROM part_search WHERE part_id = ?").get("prt_0")).toBeNull()
  await job
  expect(index.cache.query("SELECT count(*) AS count FROM part_search").get()).toEqual({ count: 250 })
  index.close()
})

test("maintenance recovers an expired lease on an existing stale index", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  using db = new SQLite(file)
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.query("INSERT INTO part VALUES(?, ?, ?)").run(
    "prt_1",
    "ses_abc",
    JSON.stringify({ type: "text", text: "missing dialogue" }),
  )
  const index = new SearchIndex(file, `${dir.path}/cache.db`)
  index.cache.run("INSERT INTO part_search_meta VALUES(1, '0')")
  index.cache.run("INSERT INTO part_search_lock VALUES(1, 'interrupted', 0)")
  await index.refresh()
  expect(index.cache.query("SELECT part_id FROM part_search WHERE part_search MATCH ?").all("missing")).toEqual([
    { part_id: "prt_1" },
  ])
  expect(index.cache.query("SELECT * FROM part_search_lock").all()).toEqual([])
  index.close()
})

test("a failed refresh does not throttle recovery", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  using db = new SQLite(file)
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.query("INSERT INTO part VALUES(?, ?, ?)").run(
    "prt_1",
    "ses_abc",
    JSON.stringify({ type: "text", text: "missing dialogue" }),
  )
  const index = new SearchIndex(file, `${dir.path}/cache.db`)
  index.cache.run("INSERT INTO part_search_meta VALUES(1, '0')")
  db.run("UPDATE part SET data = 'invalid'")
  await expect(index.refresh()).rejects.toThrow("malformed JSON")
  db.query("UPDATE part SET data = ?").run(JSON.stringify({ type: "text", text: "missing dialogue" }))
  await index.refresh()
  expect(index.cache.query("SELECT part_id FROM part_search WHERE part_search MATCH ?").all("missing")).toEqual([
    { part_id: "prt_1" },
  ])
  index.close()
})

test("maintenance completes in one pass even when the source changes during indexing", async () => {
  await using dir = await tmpdir()
  const file = `${dir.path}/source.db`
  using db = new SQLite(file)
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
  db.transaction(() =>
    Array.from({ length: 500 }, (_, i) =>
      db
        .query("INSERT INTO part VALUES(?, ?, ?)")
        .run(`prt_${i}`, "ses_abc", JSON.stringify({ type: "text", text: `needle ${i}` })),
    ),
  )()
  const index = new SearchIndex(file, `${dir.path}/cache.db`)
  const job = index.refresh(true)
  await Bun.sleep(0)
  db.query("UPDATE part SET data = ? WHERE id = ?").run(
    JSON.stringify({ type: "text", text: "updated needle" }),
    "prt_0",
  )
  await job
  expect(index.indexing).toBe(false)
  index.update(["prt_0"])
  expect(index.cache.query("SELECT text FROM part_search WHERE part_id = ?").get("prt_0")).toEqual({
    text: "updated needle",
  })
  index.close()
})

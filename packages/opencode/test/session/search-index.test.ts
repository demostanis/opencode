import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { SearchIndex } from "../../src/session/search-index"
import { tmpdir } from "../fixture/fixture"

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

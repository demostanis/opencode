import { Database as SQLite } from "bun:sqlite"

export class SearchIndex {
  readonly source: SQLite
  readonly cache: SQLite
  readonly file: string
  indexing = false
  private version = -1
  private time = 0
  private job?: Promise<void>
  private owner = crypto.randomUUID()

  constructor(file: string, cache = `${file}.search-v2`) {
    this.file = file
    this.cache = new SQLite(cache, { create: true })
    this.cache.run("PRAGMA journal_mode = WAL")
    this.cache.run("PRAGMA synchronous = NORMAL")
    this.cache.run("PRAGMA busy_timeout = 5000")
    this.cache.run(
      "CREATE TABLE IF NOT EXISTS part_search_meta (id INTEGER PRIMARY KEY CHECK(id = 1), stamp TEXT NOT NULL)",
    )
    this.cache.run(
      "CREATE TABLE IF NOT EXISTS part_search_lock (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL)",
    )
    this.cache.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS part_search USING fts5(part_id UNINDEXED, session_id UNINDEXED, text, scope, tokenize = 'trigram')",
    )
    this.source = new SQLite(file, { readonly: true })
    this.source.run("PRAGMA busy_timeout = 5000")
    this.source.query("ATTACH DATABASE ? AS conversation_search").run(cache)
    this.source.run(`CREATE TEMP VIEW part_search_source AS
      SELECT part.rowid AS rowid, part.id AS part_id, part.session_id,
        substr(part.session_id, -3) AS scope,
        CASE json_extract(data, '$.type')
          WHEN 'text' THEN json_extract(data, '$.text')
          WHEN 'tool' THEN CASE json_extract(data, '$.tool')
            WHEN 'bash' THEN coalesce(json_extract(data, '$.state.input.command'), '')
            WHEN 'read' THEN coalesce(json_extract(data, '$.state.input.filePath'), '') END
        END AS text
      FROM main.part
      WHERE (json_extract(data, '$.type') = 'text' AND coalesce(json_extract(data, '$.synthetic'), 0) = 0
        AND coalesce(json_extract(data, '$.ignored'), 0) = 0)
        OR (json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') IN ('bash', 'read'))`)
    this.source.run("PRAGMA query_only = ON")
  }

  get ready() {
    return Boolean(this.cache.query("SELECT 1 FROM part_search_meta WHERE id = 1").get())
  }

  async refresh(force = false, notify: (indexing: boolean) => void = () => {}) {
    if (this.job) return this.job
    if (!force && this.ready && Date.now() - this.time < 30_000) return
    const saved = this.cache.query<{ stamp: string }, []>("SELECT stamp FROM part_search_meta WHERE id = 1").get()
    if (!force && saved && Date.now() - Number(saved.stamp) < 30_000) return
    const version = this.source.query<{ data_version: number }, []>("PRAGMA main.data_version").get()!.data_version
    if (!force && this.version === version) return
    const now = Date.now()
    const lease = this.cache
      .query<{ id: number }, [string, number, number]>(
        `
      INSERT INTO part_search_lock(id, owner, expires) VALUES(1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires
      WHERE part_search_lock.expires < ? RETURNING id
    `,
      )
      .get(this.owner, now + 60_000, now)
    if (!lease) return
    this.job = (async () => {
      this.indexing = true
      notify(true)
      let cursor = 0
      while (true) {
        // Bound the source rows before evaluating JSON, rather than scanning the whole corpus for 100 changes.
        const rows = this.source
          .query<{ rowid: number }, [number]>(
            `
          SELECT rowid FROM main.part WHERE rowid > ? ORDER BY rowid LIMIT 100
        `,
          )
          .all(cursor)
        if (!rows.length) break
        const end = rows.at(-1)!.rowid
        this.range(cursor, end)
        this.cache.query("UPDATE part_search_lock SET expires = ? WHERE owner = ?").run(Date.now() + 60_000, this.owner)
        cursor = end
        await Bun.sleep(0)
      }
      cursor = 0
      while (true) {
        const rows = this.source
          .query<{ rowid: number; present: number }, [number]>(
            `
          WITH batch AS MATERIALIZED (
            SELECT rowid, part_id FROM conversation_search.part_search WHERE rowid > ? ORDER BY rowid LIMIT 100
          )
          SELECT batch.rowid, EXISTS(SELECT 1 FROM main.part WHERE part.rowid = batch.rowid AND part.id = batch.part_id) AS present
          FROM batch ORDER BY batch.rowid
        `,
          )
          .all(cursor)
        if (!rows.length) break
        this.cache.transaction(() =>
          rows
            .filter((row) => !row.present)
            .forEach((row) => this.cache.query("DELETE FROM part_search WHERE rowid = ?").run(row.rowid)),
        )()
        cursor = rows.at(-1)!.rowid
        await Bun.sleep(0)
      }
      this.version = version
      this.cache
        .query(
          "INSERT INTO part_search_meta(id, stamp) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET stamp = excluded.stamp",
        )
        .run(String(Date.now()))
    })().finally(() => {
      this.time = Date.now()
      this.indexing = false
      this.cache.query("DELETE FROM part_search_lock WHERE owner = ?").run(this.owner)
      this.job = undefined
      notify(false)
    })
    return this.job
  }

  private range(start: number, end: number) {
    const rows = this.source
      .query<
        {
          rowid: number
          part_id: string
          session_id: string
          text: string
          scope: string
          changed: number
        },
        [number, number]
      >(
        `
      SELECT part_search_source.*, (
        part_search.rowid IS NULL OR part_search.part_id IS NOT part_search_source.part_id OR
        part_search.session_id IS NOT part_search_source.session_id OR part_search.text IS NOT part_search_source.text
      ) AS changed
      FROM part_search_source LEFT JOIN conversation_search.part_search ON part_search.rowid = part_search_source.rowid
      WHERE part_search_source.rowid > ? AND part_search_source.rowid <= ?
    `,
      )
      .all(start, end)
    const retained = new Set(rows.map((row) => row.rowid))
    const removed = this.cache
      .query<{ rowid: number }, [number, number]>("SELECT rowid FROM part_search WHERE rowid > ? AND rowid <= ?")
      .all(start, end)
      .filter((row) => !retained.has(row.rowid))
    this.cache.transaction(() => {
      removed.forEach((row) => this.cache.query("DELETE FROM part_search WHERE rowid = ?").run(row.rowid))
      rows
        .filter((row) => row.changed)
        .forEach((row) =>
          this.cache
            .query("INSERT OR REPLACE INTO part_search(rowid, part_id, session_id, text, scope) VALUES (?, ?, ?, ?, ?)")
            .run(row.rowid, row.part_id, row.session_id, row.text, row.scope),
        )
    })()
  }

  update(ids: string[]) {
    const rows = this.source
      .query<{ rowid: number }, string[]>(`SELECT rowid FROM main.part WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids)
    rows.forEach((row) => this.range(row.rowid - 1, row.rowid))
    const found = new Set(rows.map((row) => row.rowid))
    this.cache
      .query<{ rowid: number }, string[]>(
        `SELECT rowid FROM part_search WHERE part_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids)
      .filter((row) => !found.has(row.rowid))
      .forEach((row) => this.cache.query("DELETE FROM part_search WHERE rowid = ?").run(row.rowid))
  }

  close() {
    this.source.close()
    this.cache.close()
  }
}

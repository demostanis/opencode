import { Database as SQLite } from "bun:sqlite"

export class SyncLease {
  private db: SQLite
  private owner: string

  constructor(file: string, owner: string = crypto.randomUUID()) {
    this.owner = owner
    this.db = new SQLite(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.db.run("PRAGMA busy_timeout = 1000")
    this.db.run("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, owner TEXT, pid INTEGER, expires INTEGER)")
  }

  claim(now = Date.now()) {
    const prev = this.db.query<{ owner: string; pid: number }, []>("SELECT owner, pid FROM lease WHERE id = 1").get()
    if (prev && prev.owner !== this.owner) {
      const alive = (() => {
        try {
          process.kill(prev.pid, 0)
          return true
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === "ESRCH") return false
          return true
        }
      })()
      if (!alive) this.db.query("DELETE FROM lease WHERE owner = ?").run(prev.owner)
    }
    return Boolean(
      this.db
        .query(
          `
        INSERT INTO lease (id, owner, pid, expires) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, expires = excluded.expires
        WHERE lease.owner = excluded.owner OR lease.expires < ? RETURNING id
      `,
        )
        .get(this.owner, process.pid, now + 30_000, now),
    )
  }

  release() {
    this.db.query("DELETE FROM lease WHERE owner = ?").run(this.owner)
  }

  held() {
    return Boolean(this.db.query("SELECT 1 FROM lease WHERE owner = ? AND expires > ?").get(this.owner, Date.now()))
  }

  close() {
    this.release()
    this.db.close()
  }
}

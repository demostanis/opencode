import { expect, test } from "bun:test"
import { list } from "../../src/cli/cmd/tui/util/session"

const now = new Date("2026-09-30T12:00:00Z").getTime()
const session = (id: string, updated: number, directory = "/current", title = id, parentID?: string) => ({
  id,
  title,
  directory,
  parentID,
  time: { created: 1, updated },
})

test("separates imported sessions from the current and other workspaces", () => {
  const items = list(
    [
      session("remote-current", now + 3, "/current", "Notes (from another host)"),
      session("workspace", now + 2, "/other"),
      session("local", now),
      session("remote-other", now + 1, "/other", "Other notes (from another host)"),
      session("child", now + 4, "/current", "Child", "local"),
    ],
    "/current",
    now,
  )
  expect(items.map((item) => item.session.id)).toEqual(["local", "workspace", "remote-current", "remote-other"])
  expect(items.map((item) => item.category)).toEqual([
    "Today",
    "In other workspaces",
    "On another host",
    "On another host",
  ])
  expect(items.filter((item) => item.local).map((item) => item.session.id)).toEqual(["local"])
})

test("keeps each section newest first with deterministic timestamp ties", () => {
  const items = list(
    [
      session("old", now - 86400000),
      session("a", now),
      session("z", now),
      session("workspace-old", 1, "/other"),
      session("workspace-new", 2, "/other"),
      session("remote-old", 1, "/current", "Old (from another host)"),
      session("remote-new", 2, "/current", "New (from another host)"),
    ],
    "/current",
    now,
  )
  expect(items.map((item) => item.session.id)).toEqual([
    "z",
    "a",
    "old",
    "workspace-new",
    "workspace-old",
    "remote-new",
    "remote-old",
  ])
})

test("retains the remote section when no workspace directory is available", () => {
  expect(list([session("remote", now, "/other", "Notes (from another host)")], undefined, now)[0]).toMatchObject({
    category: "On another host",
    local: false,
    remote: true,
  })
})

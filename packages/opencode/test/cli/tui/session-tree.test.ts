import { expect, test } from "bun:test"
import { tree } from "../../../src/cli/cmd/tui/context/session-tree"

test.each(["root", "nested"])("loads ancestors, descendants and peers from %s", async (id) => {
  const saved = [
    { id: "root" },
    { id: "child", parentID: "root" },
    { id: "nested", parentID: "child" },
    { id: "peer", parentID: "root" },
    { id: "unrelated" },
  ]
  const requests = [] as string[]
  const sessions = await tree(
    saved.find((session) => session.id === id)!,
    async (id) => saved.find((session) => session.id === id)!,
    async (id) => {
      requests.push(id)
      return saved.filter((session) => session.parentID === id)
    },
  )
  expect(sessions.map((session) => session.id).sort()).toEqual(["child", "nested", "peer", "root"])
  expect(requests.sort()).toEqual(["child", "nested", "peer", "root"])
})

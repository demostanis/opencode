import { expect, test } from "bun:test"
import { resume } from "../../../src/cli/cmd/tui/resume"

test("resumes an inactive or same-machine session", async () => {
  expect(await resume({ sessionID: "old", remote: async () => false, forkSession: async () => undefined })).toBe("old")
})

test("forks a remotely busy session exactly once", async () => {
  const calls: string[] = []
  expect(
    await resume({
      sessionID: "old",
      remote: async () => true,
      forkSession: async (id) => {
        calls.push(id)
        return "new"
      },
    }),
  ).toBe("new")
  expect(calls).toEqual(["old"])
})

test("explicit fork does not check markers or fork twice", async () => {
  let calls = 0
  expect(
    await resume({
      sessionID: "old",
      fork: true,
      remote: async () => {
        throw new Error("should not check")
      },
      forkSession: async () => {
        calls++
        return "new"
      },
    }),
  ).toBe("new")
  expect(calls).toBe(1)
})

test("errors never fall back to the original session", async () => {
  expect(resume({ sessionID: "old", remote: async () => true, forkSession: async () => undefined })).rejects.toThrow()
  expect(
    resume({
      sessionID: "old",
      remote: async () => {
        throw new Error("unreadable")
      },
      forkSession: async () => "new",
    }),
  ).rejects.toThrow("unreadable")
})

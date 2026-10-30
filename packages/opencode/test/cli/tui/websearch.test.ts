import { describe, expect, test } from "bun:test"
import { websearch } from "../../../src/cli/cmd/tui/routes/session/websearch"

describe("websearch presentation", () => {
  test("displays raw native action sources and query arrays", () => {
    expect(
      websearch(
        {},
        {
          native: {
            action: { type: "search", queries: ["Bun", "Docs"], sources: [{ type: "url", url: "https://bun.sh" }] },
          },
        },
        "completed",
      ).label,
    ).toBe('Web Search "Bun, Docs" (1 source)')
    expect(
      websearch({}, { native: { action: { type: "open_page", url: "https://bun.sh" } } }, "completed"),
    ).toMatchObject({ label: "Open Page https://bun.sh", pending: "Opening page..." })
    expect(
      websearch(
        {},
        { native: { action: { type: "find_in_page", url: "https://bun.sh", pattern: "install" } } },
        "completed",
      ),
    ).toMatchObject({ label: 'Find "install" in https://bun.sh', pending: "Finding in page..." })
  })
  test("running native search uses its query in task summaries", () => {
    expect(websearch({}, { native: { action: { type: "search", query: "review redaction" } } }, "running").label).toBe(
      'Web Search "review redaction"',
    )
  })

  test("completed native search uses action query and sources with empty input", () => {
    expect(
      websearch(
        {},
        {
          providerExecuted: true,
          native: {
            action: { type: "search", query: "Bun documentation" },
            sources: [{ type: "url", url: "https://bun.sh" }],
          },
        },
        "completed",
      ),
    ).toEqual({
      label: 'Web Search "Bun documentation" (1 source)',
      complete: true,
      pending: "Searching web...",
    })
  })

  test("counts native URL sources including zero", () => {
    for (const count of [0, 2]) {
      const sources = Array.from({ length: count }, () => ({ type: "url", url: "https://example.com" }))
      expect(
        websearch(
          {},
          {
            native: { action: { type: "search", query: "query" }, sources: [...sources, null, { type: "other" }] },
          },
          "completed",
        ).label,
      ).toBe(`Web Search "query" (${count} sources)`)
    }
  })

  test("native openPage shows URL", () => {
    expect(
      websearch(
        {},
        {
          native: { action: { type: "openPage", url: "https://bun.sh/docs" } },
        },
        "completed",
      ),
    ).toEqual({
      label: "Open Page https://bun.sh/docs",
      complete: true,
      pending: "Opening page...",
    })
  })

  test("native findInPage shows pattern and URL", () => {
    expect(
      websearch(
        {},
        {
          native: { action: { type: "findInPage", pattern: "install", url: "https://bun.sh/docs" } },
        },
        "completed",
      ),
    ).toEqual({
      label: 'Find "install" in https://bun.sh/docs',
      complete: true,
      pending: "Finding in page...",
    })
  })

  test("completed calls without query never show the pending label", () => {
    for (const metadata of [{}, { providerExecuted: true }, { native: { action: { type: "search" } } }]) {
      expect(websearch({}, metadata, "completed")).toEqual({
        label: "Web Search completed",
        complete: true,
        pending: "Searching web...",
      })
    }
  })

  test("pending and running calls without details remain pending", () => {
    for (const status of ["pending", "running"]) {
      expect(websearch({}, {}, status).complete).toBe(false)
    }
  })

  test("local search retains its query and result count", () => {
    expect(websearch({ query: "local query" }, { numResults: 3 }, "completed")).toEqual({
      label: 'Web Search "local query" (3 results)',
      complete: true,
      pending: "Searching web...",
    })
    expect(websearch({ query: "local query" }, {}, "running").complete).toBe(true)
    expect(websearch({ query: "local query" }, { numResults: 0 }, "completed").label).toBe('Web Search "local query"')
  })

  test("malformed metadata safely falls back to local input", () => {
    for (const native of [null, [], "invalid", { action: { query: 42 }, sources: "invalid" }]) {
      expect(websearch({ query: "local" }, { native }, "completed").label).toBe('Web Search "local"')
    }
  })

  test("failed calls without details are not presented as searching", () => {
    expect(websearch({}, {}, "error")).toEqual({
      label: "Web Search failed",
      complete: true,
      pending: "Searching web...",
    })
  })
})

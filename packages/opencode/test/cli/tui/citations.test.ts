import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { citations, references } from "../../../src/cli/cmd/tui/routes/session/citations"

const first = "https://www.iana.org/domains/reserved"
const second = "https://www.iana.org/help/example-domains?webscale_search_refresh_probe=codex_20260605_174845"
const native = {
  type: "web_search_call",
  action: {
    type: "search",
    sources: [
      { type: "url", url: second },
      { type: "url", url: first },
    ],
  },
  results: [
    {
      title: "IANA-managed Reserved Domains",
      url: first,
      snippet:
        "\ue200cite\ue202turn0search0\ue201 [wordlim: 200] Crawled: today; As described in RFC 2606 and RFC 6761",
    },
    {
      title: "Example Domains",
      url: second,
      snippet:
        "\ue200cite\ue202turn0search1\ue201 [wordlim: 200] Crawled: last month; These domains may be used as illustrative examples",
    },
  ],
}

function tool(value: unknown, output = ""): ToolPart {
  return {
    id: "prt_test",
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "tool",
    tool: "websearch",
    callID: "call_test",
    state: {
      status: "completed",
      input: {},
      output,
      title: "Web search",
      metadata: value === undefined ? {} : { native: value },
      time: { start: 0, end: 1 },
    },
  }
}

describe("citation provenance", () => {
  test("uses real snippet markers and exact result URLs, not source ordering", () => {
    const part = tool(native)
    const before = JSON.stringify(part)
    expect([...references([part])]).toEqual([
      ["turn0search0", first],
      ["turn0search1", second],
    ])
    expect(JSON.stringify(part)).toBe(before)
  })

  test("supports local native item lists and serialized fallback envelopes", () => {
    for (const value of [
      native,
      { backend: "codex", items: [native] },
      { output: "summary", native: { backend: "codex", items: [native] } },
    ]) {
      expect(references([tool(value)]).get("turn0search1")).toBe(second)
      expect(references([tool(undefined, JSON.stringify(value))]).get("turn0search1")).toBe(second)
    }
  })

  test("open/find markers use their stored action URL when the result omits it", () => {
    for (const type of ["open_page", "find_in_page", "openPage", "findInPage"]) {
      expect(
        references([
          tool({
            type: "web_search_call",
            action: { type, url: first },
            results: [{ snippet: "\ue200cite\ue202turn1view0\ue201 Source: open(...)" }],
          }),
        ]).get("turn1view0"),
      ).toBe(first)
    }
  })

  test("explicit source refs and ASCII snippet provenance are supported", () => {
    expect([
      ...references([
        tool({
          type: "web_search_call",
          sources: [{ type: "url", ref_id: "turn2search9", url: first }],
          results: [{ snippet: "<cite|turn2search3> text", url: second }],
        }),
      ]),
    ]).toEqual([
      ["turn2search9", first],
      ["turn2search3", second],
    ])
  })

  test("never invents refs from source positions or citations in page bodies", () => {
    expect(references([tool({ type: "web_search_call", action: native.action })]).size).toBe(0)
    expect(
      references([
        tool({ ...native, results: [{ url: first, snippet: "Page quotes \ue200cite\ue202turn9search0\ue201" }] }),
      ]).size,
    ).toBe(0)
  })

  test("conflicting refs remain ambiguous across independent calls regardless of order", () => {
    const newer = { ...native, results: [{ url: second, snippet: "<cite|turn0search0>" }] }
    for (const items of [
      [native, newer],
      [newer, native],
      [native, newer, native],
      [{ ...native, results: [...native.results, ...newer.results] }, native],
    ]) {
      for (const parts of [
        items.map((item) => tool(item)),
        [tool({ backend: "codex", items })],
        items.map((item) => tool(undefined, JSON.stringify(item))),
      ]) {
        const links = references(parts)
        expect(links.has("turn0search0")).toBe(false)
        expect(links.get("turn0search1")).toBe(second)
        expect(citations("<cite|turn0search0>", links)).toBe("(turn0search0)")
      }
    }
    expect(references([tool(native), tool(native)]).get("turn0search0")).toBe(first)
  })

  test("malformed, unsafe, compacted, and unrelated tool data cannot supply links", () => {
    for (const value of [null, [], "bad", {}, { type: "web_search_call", results: "bad" }])
      expect(references([tool(value)]).size).toBe(0)
    for (const href of [
      "javascript:alert(1)",
      "file:///tmp/test",
      "https://user:pass@example.com",
      "https://exa\nmple.com",
      "https://trusted.example\\@attacker.example/",
      "https://example.com/path\\file",
      "https://",
    ]) {
      expect(references([tool({ ...native, results: [{ url: href, snippet: "<cite|turn0search0>" }] })]).size).toBe(0)
    }
    expect(references([tool(undefined, "not JSON")]).size).toBe(0)
    expect(references([{ ...tool(native), tool: "read" }]).size).toBe(0)
    const part = tool(native)
    if (part.state.status === "completed") part.state.time.compacted = 2
    expect(references([part]).size).toBe(0)
  })
})

describe("citation Markdown", () => {
  const links = references([tool(native)])
  test("renders ASCII and conventional markers as standard Markdown hyperlinks", () => {
    for (const value of ["<cite|turn0search0>", "<cite|turn0search0|>", "\ue200cite\ue202turn0search0\ue201"]) {
      expect(citations(`IANA ${value}.`, links)).toBe(`IANA [1](${first}).`)
    }
  })

  test("handles multiple refs, adjacent tokens, repeated refs, and unknown refs", () => {
    for (const value of [
      "<cite|turn0search0|turn0search1|turn9search3>",
      "\ue200cite\ue202turn0search0\ue202turn0search1\ue202turn9search3\ue201",
    ]) {
      expect(citations(value, links)).toBe(`[1](${first}) [2](${second}) (turn9search3)`)
    }
    expect(citations("<cite|turn0search0><cite|turn0search0>", links)).toBe(`[1](${first})[1](${first})`)
    expect(citations("<cite|not-a-ref>", links)).toBe("<cite|not-a-ref>")
  })

  test("numbers by first visible appearance, reuses exact URLs, and resets per answer", () => {
    const refs = new Map([...links, ["turn1view0", first]])
    const text = "`<cite|turn0search0>` <cite|turn9search3|turn0search1|turn1view0|turn0search0>"
    expect(citations(text, refs)).toBe(
      `\`<cite|turn0search0>\` (turn9search3) [1](${second}) [2](${first}) [2](${first})`,
    )
    expect(citations("<cite|turn0search0>", refs)).toBe(`[1](${first})`)
  })

  test("appended streaming markers keep earlier numbers across every partial suffix", () => {
    const head = "<cite|turn0search1> then <cite|turn0search0> "
    const expected = `[1](${second}) then [2](${first}) `
    for (const token of ["<cite|turn0search1|turn0search0>", "\ue200cite\ue202turn0search1\ue202turn0search0\ue201"]) {
      for (let i = 0; i < token.length; i++) {
        expect(citations(head + token.slice(0, i), links, true)).toBe(expected)
      }
      expect(citations(head + token, links, true)).toBe(`${expected}[1](${second}) [2](${first})`)
    }
  })

  test("buffers every incomplete streaming suffix without swallowing surrounding text", () => {
    for (const value of ["<cite|turn0search0>", "\ue200cite\ue202turn0search0\ue201"]) {
      for (let i = 1; i < value.length; i++) expect(citations(`Text ${value.slice(0, i)}`, links, true)).toBe("Text ")
      expect(citations(value, links, true)).toBe(`[1](${first})`)
    }
    expect(citations("Text <cite|turn0search0", links)).toBe("Text <cite|turn0search0")
  })

  test("preserves code, existing links, escaped tokens, and surrounding Markdown", () => {
    for (const value of [
      "`<cite|turn0search0>`",
      "``a ` <cite|turn0search0>``",
      "```txt\n<cite|turn0search0>\n```",
      "~~~\n<cite|turn0search0>\n~~~",
      "```\n<cite|turn0search0>",
      "    <cite|turn0search0>\n",
      "\t<cite|turn0search0>\n",
      "  \t<cite|turn0search0>\n",
      "> ~~~txt\n> <cite|turn0search0>\n> ~~~",
      "> > ~~~\n> > <cite|turn0search0>\n> > ~~~~",
      "> ~~~\n> > literal quote\n> <cite|turn0search0>\n> ~~~",
      "> ~~~\n> <cite|turn0search0>",
      "> \t<cite|turn0search0>\n",
      "[<cite|turn0search0>](https://example.com)",
      "[label [<cite|turn0search0>]](https://example.com/a(b))",
      "![<cite|turn0search0>](https://example.com/image.png)",
      "[<cite|turn0search0>][source]\n\n[source]: https://example.com",
      "\\<cite|turn0search0>",
    ]) {
      expect(citations(value, links, true)).toBe(value)
    }
    expect(citations("**Bold** <cite|turn0search0>\n- item", links)).toBe(`**Bold** [1](${first})\n- item`)
  })

  test("longer closing fences end code and shorter fences do not", () => {
    for (const char of ["`", "~"]) {
      for (const prefix of ["", "> ", "> > "]) {
        const code = `${prefix}${char.repeat(4)}\n${prefix}${char.repeat(3)}\n${prefix}<cite|turn0search0>\n${prefix}${char.repeat(5)}\n`
        expect(citations(`${code}<cite|turn0search0>`, links, true)).toBe(`${code}[1](${first})`)
      }
    }
    const code = "> ~~~\n> <cite|turn0search0>\n"
    expect(citations(`${code}<cite|turn0search0>`, links)).toBe(`${code}[1](${first})`)
  })

  test("backticks use matching run lengths and backslashes inside code are literal", () => {
    const code = "`code\\`"
    expect(citations(`${code} <cite|turn0search0>`, links)).toBe(`${code} [1](${first})`)
    expect(citations("``<cite|turn0search0>` `` <cite|turn0search0>", links)).toBe(
      `\`\`<cite|turn0search0>\` \`\` [1](${first})`,
    )
  })

  test("preserves fences in bullet, numbered, nested, and quoted list containers", () => {
    for (const char of ["`", "~"]) {
      for (const [marker, prefix] of [
        ["- ", "  "],
        ["+ ", "  "],
        ["* ", "  "],
        ["1. ", "   "],
        ["1) ", "   "],
        ["12) ", "    "],
        ["123456789. ", "           "],
        ["  -   ", "      "],
        ["-\t", "\t"],
        ["- - ", "    "],
        ["- - - ", "      "],
        ["1. + ", "     "],
        ["- 12) ", "      "],
        ["> - ", ">   "],
        ["- > ", "  > "],
        ["> 1. > - ", ">    >   "],
      ]) {
        for (const token of ["<cite|turn0search0>", "\ue200cite\ue202turn0search0\ue201"]) {
          for (const info of ["", "txt"]) {
            const code = `${marker}${char.repeat(3)}${info}\n${prefix}${token}\n${prefix}${char.repeat(3)}\n\n`
            for (const streaming of [false, true]) {
              expect(citations(`${code}Outside ${token}`, links, streaming)).toBe(`${code}Outside [1](${first})`)
            }
          }
        }
      }
    }
  })

  test("tracks continuation indentation before and after nested list fences", () => {
    for (const char of ["`", "~"]) {
      for (const [head, prefix] of [
        ["- item\n", "  "],
        ["10. item\n\n", "    "],
        ["- outer\n  2) inner\n\n", "     "],
        ["> - outer\n>   - inner\n>\n", ">     "],
      ]) {
        const code = `${head}${prefix}${char.repeat(4)}\n${prefix.trimEnd()}\n${prefix}${char.repeat(3)}\n${prefix}<cite|turn0search0>\n${prefix}${char.repeat(5)}\n`
        expect(citations(`${code}${prefix}<cite|turn0search0>\nOutside <cite|turn0search0>`, links)).toBe(
          `${code}${prefix}[1](${first})\nOutside [1](${first})`,
        )
      }
    }
  })

  test("unterminated list fences end on container exit, not literal nested markers", () => {
    for (const char of ["`", "~"]) {
      for (const tail of ["Outside ", "- sibling ", "1. sibling "]) {
        const code = `- ${char.repeat(3)}\n  - ${char.repeat(3)}\n  > literal quote\n  <cite|turn0search0>\n`
        expect(citations(`${code}${tail}<cite|turn0search0>`, links)).toBe(`${code}${tail}[1](${first})`)
      }
      const code = `- outer\n  - ${char.repeat(3)}\n    <cite|turn0search0>\n`
      expect(citations(`${code}  Parent <cite|turn0search0>`, links)).toBe(`${code}  Parent [1](${first})`)
      expect(citations(`- ${char.repeat(3)}\n  <cite|turn0search0>\n\n  <cit`, links, true)).toBe(
        `- ${char.repeat(3)}\n  <cite|turn0search0>\n\n  <cit`,
      )
    }
  })

  test("rejects backslash URLs even when passed directly to the Markdown adapter", () => {
    expect(
      citations("<cite|turn0search0>", new Map([["turn0search0", "https://trusted.example\\@attacker.example/"]])),
    ).toBe("(turn0search0)")
  })

  test("adversarial unmatched delimiters stay responsive during streaming deltas", () => {
    const start = performance.now()
    for (const size of [25_000, 100_000, 400_000]) {
      const text = "[".repeat(size)
      for (let i = 0; i < 8; i++) {
        expect(citations(text, links, true)).toBe(text)
        expect(citations(`${text}<cit`, links, true)).toBe(text)
        expect(citations(`${text}<cite|turn0search0>`, links, true)).toBe(`${text}[1](${first})`)
      }
    }
    expect(performance.now() - start).toBeLessThan(2000)
  })

  test("escapes Markdown destination delimiters from stored URLs", () => {
    expect(citations("<cite|turn0search0>", new Map([["turn0search0", "https://example.com/a(b)?q=[x]|y"]]))).toBe(
      "[1](https://example.com/a%28b%29?q=%5Bx%5D%7Cy)",
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

type Target = {
  postMessage(data: string): void
  onmessage: ((this: Worker, evt: MessageEvent<unknown>) => unknown) | null
}

describe("rpc", () => {
  test("waits for the listener before sending requests", async () => {
    const sent: string[] = []
    const target: Target = {
      postMessage(data) {
        sent.push(data)
      },
      onmessage: null,
    }
    const client = Rpc.client<{ ping(input: string): string }>(target)
    const result = client.call("ping", "hello")

    await Promise.resolve()
    expect(sent).toEqual([])

    target.onmessage!.call({} as Worker, new MessageEvent("message", { data: JSON.stringify({ type: "rpc.ready" }) }))
    await Promise.resolve()
    expect(sent).toHaveLength(1)

    const request = JSON.parse(sent[0])
    target.onmessage!.call(
      {} as Worker,
      new MessageEvent("message", { data: JSON.stringify({ type: "rpc.result", id: request.id, result: "world" }) }),
    )
    await expect(result).resolves.toBe("world")
  })

  test("rejects errors returned by the listener", async () => {
    const sent: string[] = []
    const target: Target = {
      postMessage(data) {
        sent.push(data)
      },
      onmessage: null,
    }
    const client = Rpc.client<{ ping(input: string): string }>(target)
    target.onmessage!.call({} as Worker, new MessageEvent("message", { data: JSON.stringify({ type: "rpc.ready" }) }))
    const result = client.call("ping", "hello")
    await Promise.resolve()

    const request = JSON.parse(sent[0])
    target.onmessage!.call(
      {} as Worker,
      new MessageEvent("message", { data: JSON.stringify({ type: "rpc.error", id: request.id, error: "failed" }) }),
    )
    await expect(result).rejects.toThrow("failed")
  })
})

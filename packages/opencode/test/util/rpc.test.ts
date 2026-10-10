import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import { tmpdir } from "../fixture/fixture"

type Target = {
  postMessage(data: string): void
  onmessage: ((this: Worker, evt: MessageEvent<unknown>) => unknown) | null
}

describe("rpc", () => {
  test("rejects startup and future calls when a real worker fails before ready", async () => {
    await using dir = await tmpdir()
    const file = `${dir.path}/worker.ts`
    await Bun.write(file, 'throw new Error("startup failed")')
    const worker = new Worker(file)
    const client = Rpc.client<{ ping(input: string): string }>(worker)
    try {
      await expect(client.call("ping", "hello")).rejects.toThrow("startup failed")
      await expect(client.call("ping", "again")).rejects.toThrow("startup failed")
    } finally {
      worker.terminate()
    }
  })

  test("rejects pending and future calls when a ready worker crashes", async () => {
    await using dir = await tmpdir()
    const file = `${dir.path}/worker.ts`
    await Bun.write(
      file,
      `
      onmessage = () => { throw new Error("worker crashed") }
      postMessage(JSON.stringify({ type: "rpc.ready" }))
    `,
    )
    const worker = new Worker(file)
    const client = Rpc.client<{ ping(input: string): string }>(worker)
    try {
      await expect(client.call("ping", "hello")).rejects.toThrow("worker crashed")
      await expect(client.call("ping", "again")).rejects.toThrow("worker crashed")
    } finally {
      worker.terminate()
    }
  })

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

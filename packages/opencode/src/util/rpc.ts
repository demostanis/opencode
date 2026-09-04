export namespace Rpc {
  type Definition = {
    [method: string]: (input: any) => any
  }

  export function listen(rpc: Definition) {
    onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.request") {
        try {
          const result = await rpc[parsed.method](parsed.input)
          postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
        } catch (error) {
          postMessage(
            JSON.stringify({
              type: "rpc.error",
              error: error instanceof Error ? error.message : String(error),
              id: parsed.id,
            }),
          )
        }
      }
    }
    postMessage(JSON.stringify({ type: "rpc.ready" }))
  }

  export function emit(event: string, data: unknown) {
    postMessage(JSON.stringify({ type: "rpc.event", event, data }))
  }

  export function client<T extends Definition>(target: {
    postMessage: (data: string) => void | null
    onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  }) {
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
    const listeners = new Map<string, Set<(data: any) => void>>()
    const ready = Promise.withResolvers<void>()
    let id = 0
    target.onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.ready") ready.resolve()
      if (parsed.type === "rpc.result") {
        const call = pending.get(parsed.id)
        if (call) {
          call.resolve(parsed.result)
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.error") {
        const call = pending.get(parsed.id)
        if (call) {
          call.reject(new Error(parsed.error))
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.event") {
        const handlers = listeners.get(parsed.event)
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.data)
          }
        }
      }
    }
    return {
      async call<Method extends keyof T>(
        method: Method,
        input: Parameters<T[Method]>[0],
      ): Promise<ReturnType<T[Method]>> {
        await ready.promise
        const key = id++
        return new Promise((resolve, reject) => {
          pending.set(key, { resolve, reject })
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: key }))
        })
      },
      on<Data>(event: string, handler: (data: Data) => void) {
        let handlers = listeners.get(event)
        if (!handlers) {
          handlers = new Set()
          listeners.set(event, handlers)
        }
        handlers.add(handler)
        return () => {
          handlers!.delete(handler)
        }
      },
    }
  }
}

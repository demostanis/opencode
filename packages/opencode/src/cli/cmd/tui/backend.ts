import { Owner } from "./owner"
import type { EventSource } from "./context/sdk"

export type Backend = {
  id: string
  url: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}

export async function resolve(input: {
  sessionID: string
  directory: string
  backend: Backend
  owner?: Pick<Owner.Info, "id">
  find?: typeof Owner.find
}) {
  const info = await (input.find ?? Owner.find)(input.sessionID)
  if (!info || info.id === input.owner?.id) return input.backend
  return {
    id: `${info.id}:${input.directory}`,
    url: info.url,
    directory: input.directory,
    headers: Owner.headers(info),
  }
}

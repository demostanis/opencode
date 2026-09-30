import { SearchIndex } from "./search-index"
import { Rpc } from "@/util/rpc"

let index: SearchIndex
const notify = (indexing: boolean) => Rpc.emit("status", { indexing })
export const rpc = {
  init(input: { source: string; cache: string }) {
    index = new SearchIndex(input.source, input.cache)
    const ready = index.ready
    index.refresh(false, notify).catch((err) => Rpc.emit("failure", String(err)))
    return { ready }
  },
  async ensure() {
    await index.refresh(true, notify)
    while (!index.ready) {
      await Bun.sleep(100)
      await index.refresh(true, notify)
    }
  },
  refresh() {
    index.refresh(false, notify).catch((err) => Rpc.emit("failure", String(err)))
  },
  update(ids: string[]) {
    if (ids.length) index.update(ids)
  },
}
Rpc.listen(rpc)

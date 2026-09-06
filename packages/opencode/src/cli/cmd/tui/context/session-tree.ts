export async function tree<T extends { id: string; parentID?: string }>(
  session: T,
  get: (id: string) => Promise<T>,
  children: (id: string) => Promise<T[]>,
) {
  const sessions = new Map([[session.id, session]])
  let root = session
  while (root.parentID && !sessions.has(root.parentID)) {
    root = await get(root.parentID)
    sessions.set(root.id, root)
  }
  const visited = new Set<string>()
  async function visit(id: string): Promise<void> {
    if (visited.has(id)) return
    visited.add(id)
    await Promise.all(
      (await children(id)).map(async (child) => {
        sessions.set(child.id, child)
        await visit(child.id)
      }),
    )
  }
  await visit(root.id)
  return [...sessions.values()]
}

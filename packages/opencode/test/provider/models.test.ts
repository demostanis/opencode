import { expect, test } from "bun:test"
import { ModelsDev } from "../../src/provider/models"

test.each([
  { id: "gpt-6-sol", input: 2, output: 10, read: 0.2, write: 2.5 },
  { id: "gpt-6-luna", input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
])("includes $id in the OpenAI catalog", async (entry) => {
  const catalog = await ModelsDev.get()
  const model = catalog.openai.models[entry.id]
  expect(model).toMatchObject({
    id: entry.id,
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    cost: { input: entry.input, output: entry.output, cache_read: entry.read, cache_write: entry.write },
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning: true,
    tool_call: true,
  })
  expect(ModelsDev.Model.safeParse(model).success).toBe(true)
})

import { expect, test } from "bun:test"
import { ModelsDev } from "../../src/provider/models"
import { tmpdir } from "../fixture/fixture"

test.each([
  {
    id: "abliterated-model",
    name: "Abliterated Model",
    context: 262_144,
    output: 262_134,
    image: true,
    input: 1,
    price: 3,
    read: 0.1,
  },
  {
    id: "abliterated-model-large",
    name: "Abliterated Large",
    context: 1_000_000,
    output: 999_990,
    image: false,
    input: 3,
    price: 5,
    read: 0.3,
  },
  {
    id: "abliterated-model-large-v2",
    name: "Abliterated Large v2",
    context: 1_000_000,
    output: 999_990,
    image: false,
    input: 3,
    price: 5,
    read: 0.3,
  },
  {
    id: "abliterated-model-large-flash",
    name: "Abliterated Large Flash",
    context: 1_048_576,
    output: 262_144,
    image: true,
    input: 1,
    price: 2,
    read: 0.1,
  },
])("includes $id in the built-in abliteration catalog", async (entry) => {
  const catalog = await ModelsDev.get()
  expect(catalog.abliteration).toMatchObject({
    id: "abliteration",
    name: "abliteration.ai",
    env: ["ABLITERATION_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.abliteration.ai/v1",
  })
  expect(Object.keys(catalog.abliteration.models)).toHaveLength(4)
  expect(catalog.abliteration.models[entry.id]).toMatchObject({
    id: entry.id,
    name: entry.name,
    limit: { context: entry.context, output: entry.output },
    cost: { input: entry.input, output: entry.price, cache_read: entry.read },
    modalities: { input: entry.image ? ["text", "image"] : ["text"], output: ["text"] },
    attachment: entry.image,
    reasoning: true,
    temperature: true,
    tool_call: true,
  })
  expect(ModelsDev.Provider.safeParse(catalog.abliteration).success).toBe(true)
})

test("includes abliteration without a remote catalog", async () => {
  await using tmp = await tmpdir({
    init: (dir) => Bun.write(`${dir}/models.json`, "{}"),
  })
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { ModelsDev } = await import("./src/provider/models")
    console.log(JSON.stringify((await ModelsDev.get()).abliteration))
  `,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, OPENCODE_MODELS_PATH: `${tmp.path}/models.json`, OPENCODE_DISABLE_MODELS_FETCH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const result = await new Response(proc.stdout).json()
  expect(await proc.exited).toBe(0)
  expect(ModelsDev.Provider.safeParse(result).success).toBe(true)
  expect(Object.keys(result.models)).toHaveLength(4)
})

test.each([
  { id: "gpt-6-sol", input: 2, output: 10, read: 0.2, write: 2.5 },
  { id: "gpt-6.1-sol", input: 2, output: 10, read: 0.2, write: 2.5 },
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() && !value.trimStart().startsWith("data:") ? value : undefined
}

export function image(input: Record<string, unknown>, metadata: Record<string, unknown>, title?: string) {
  const files = (Array.isArray(metadata.files) ? metadata.files : []).map(record)
  const prompt = text(input.prompt) ?? text(metadata.prompt) ?? files.map((file) => text(file.prompt)).find(Boolean)
  const revised = [
    text(input.revised_prompt),
    text(metadata.revisedPrompt),
    ...files.map((file) => text(file.revisedPrompt)),
  ]
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index)
  const settings = [
    ["action", "Action"],
    ["model", "Model"],
    ["background", "Background"],
    ["output_format", "Format"],
    ["quality", "Quality"],
    ["size", "Size"],
    ["output_compression", "Compression"],
    ["moderation", "Moderation"],
  ].flatMap(([key, label]) => {
    const value = input[key]
    if (typeof value === "number" && Number.isFinite(value)) return [`${label}: ${value}`]
    const content = text(value)
    return content ? [`${label}: ${content}`] : []
  })
  const refs = Array.isArray(input.reference_images)
    ? input.reference_images
    : input.reference_image === undefined
      ? []
      : [input.reference_image]
  const name =
    text(title) ??
    text(metadata.title) ??
    files.map((file) => text(file.shortName)).find(Boolean) ??
    text(input.short_name)

  return {
    title: name ? `Image generation: ${name}` : "Image generation",
    prompt,
    request: !prompt && !revised.length ? text(metadata.request) : undefined,
    revised,
    settings,
    refs: refs
      .filter((value): value is string => typeof value === "string")
      .map((value) => text(value) ?? "Embedded image"),
    files: files.flatMap((file) => {
      const path = text(file.path)
      return path ? [path] : []
    }),
  }
}

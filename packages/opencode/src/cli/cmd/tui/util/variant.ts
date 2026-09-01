export namespace Variant {
  export const ULTRA = "ultra"
  export const LABEL = "Ultra"
  export const FRAMES = 33

  export function list(input?: Record<string, unknown>) {
    return Object.keys(input ?? {}).filter((variant) => variant !== ULTRA)
  }

  export function supports(input: Record<string, unknown> | undefined, value: string) {
    return Object.hasOwn(input ?? {}, value)
  }

  export function available(agent: string) {
    return agent === "build"
  }

  export function label(value?: string) {
    return value === ULTRA ? LABEL : value
  }

  export function gradient(frame: number, index: number) {
    const progress = frame / (FRAMES - 1)
    const center = -2 + progress * (LABEL.length + 3)
    return Math.exp(-Math.pow(index - center, 2) / 1.3)
  }

  export function load(input?: Record<string, unknown>, mode?: Record<string, unknown>) {
    const entries = Object.entries(input ?? {})
    return {
      variant: Object.fromEntries(
        entries.map(([key, value]) => [
          key,
          value === ULTRA ? undefined : typeof value === "string" ? value : undefined,
        ]),
      ) as Record<string, string | undefined>,
      ultra: {
        ...Object.fromEntries(entries.flatMap(([key, value]) => (value === ULTRA ? [[key, true]] : []))),
        ...Object.fromEntries(Object.entries(mode ?? {}).filter((entry) => typeof entry[1] === "boolean")),
      } as Record<string, boolean | undefined>,
    }
  }

  export function next(input: string[], current?: string) {
    if (!current) return input[0]
    const index = input.indexOf(current)
    if (index === -1 || index === input.length - 1) return undefined
    return input[index + 1]
  }
}

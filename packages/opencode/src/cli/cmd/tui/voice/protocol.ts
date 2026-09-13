import { z } from "zod"

export const Limits = { text: 32_768, id: 256, message: 2_048, line: 262_144, queue: 524_288, commands: 128 } as const

const text = z.string().max(Limits.text)
const id = z.string().min(1).max(Limits.id)

export const VoiceEvent = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("state"), state: z.enum(["starting", "waiting", "listening", "speaking", "off"]) })
    .strict(),
  z.object({ type: z.literal("transcript"), role: z.enum(["user", "assistant"]), text }).strict(),
  z.object({ type: z.literal("delegate"), id, text: text.min(1) }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(Limits.message) }).strict(),
])
export type VoiceEvent = z.infer<typeof VoiceEvent>

export const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("mute") }).strict(),
  z.object({ type: z.literal("suspend") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("tool"), id, name: z.literal("stop_listening") }).strict(),
  z.object({ type: z.literal("wake") }).strict(),
  z.object({ type: z.literal("context"), text }).strict(),
  z.object({ type: z.literal("result"), id, text, final: z.boolean() }).strict(),
])
export type Command = z.infer<typeof Command>

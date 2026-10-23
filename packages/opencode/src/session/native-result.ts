import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { PartID } from "./schema"
import type { MessageV2 } from "./message-v2"
import { NativeImage } from "./native-image"

export async function nativeResult(part: MessageV2.ToolPart, output: unknown, name?: string) {
  if (
    part.tool === "image_generation" &&
    typeof output === "object" &&
    output !== null &&
    "result" in output &&
    typeof output.result === "string"
  ) {
    const fields = NativeImage.fields(output)
    const title =
      NativeImage.label(name) ?? NativeImage.label(fields.revised_prompt ?? fields.prompt) ?? "Generated image"
    const file = path.join(
      Global.Path.data,
      "generated_images",
      part.sessionID.replace(/[^A-Za-z0-9_-]/g, "_"),
      `${part.callID.replace(/[^A-Za-z0-9_-]/g, "_")}.png`,
    )
    await Filesystem.write(file, Buffer.from(output.result, "base64"))
    return {
      title,
      output: `Generated image: ${file}`,
      metadata: {
        native: output,
        files: [
          {
            path: file,
            mime: "image/png",
            shortName: title,
            ...(fields.prompt ? { prompt: fields.prompt } : {}),
            ...(fields.revised_prompt ? { revisedPrompt: fields.revised_prompt } : {}),
          },
        ],
        truncated: false,
      },
      attachments: [
        {
          id: PartID.ascending(),
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "file" as const,
          mime: "image/png",
          filename: path.basename(file),
          // Keep the base64 only in native, where replay needs the original provider result.
          url: pathToFileURL(file).href,
        },
      ],
    }
  }
  return {
    title: part.tool === "websearch" ? "Web search" : part.tool,
    output: typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
    metadata: { native: output },
  }
}

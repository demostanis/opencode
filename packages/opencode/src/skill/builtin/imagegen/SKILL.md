---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when opencode should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Generate images

Create and edit raster assets for your project.

---

## Choose the tool

- Use local `image_generate` by default for all providers, including OpenAI. Its original implementation is unchanged since `68fe00a0fe`; it uses Codex/ChatGPT auth and does not require `OPENAI_API_KEY`.
- Experimental native `image_generation` is opt-in only through `OPENCODE_EXPERIMENTAL_NATIVE_IMAGE_GENERATION=1` or `true`; unset means off, and global `OPENCODE_EXPERIMENTAL` does not enable it. Native also requires OpenAI Responses and applicable tool permissions.
- For transparent images, request a genuinely transparent background and preserve the generated alpha. Do not switch to an older model just for transparency.
- Supply edit targets and references using the selected tool's flow below. Filenames, prompt text, and `Input images` scaffolding do not attach image bytes.
- Do not describe or rely on OS temp as the default destination. Generated files are saved under opencode's `generated_images` data directory, and native output includes the saved path.
- Do not describe or rely on a destination-path argument on the built-in tool. If a specific location is needed, generate first and then move or copy the selected output.
- If the user names a destination, move or copy the selected output there.
- If the image is meant for the current project, move or copy the final selected image into the workspace before finishing.
- If the image is only for preview or brainstorming, the underlying file can remain at the default generated-images path.
- Never leave a project-referenced asset only at the default generated-images path.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

---

## Attach experimental native inputs

Opt-in experimental native `image_generation` uses image attachments in the conversation, not local-tool reference arguments. User image uploads provide attachments; use `read` to attach raster files, and convert SVG sources to raster before reading them.

For native follow-up edits, the previous generated image is replayed into context. Use `read` for an explicit target or reference when it is ambiguous or not already in context, and clearly identify each image's role in the prompt.

- Native calls have no `short_name` argument; the title agent's model (session-title model) automatically generates sidebar names in parallel only for opt-in native images. These names are sidebar metadata, not image-generation orchestration.
- Use only arguments exposed by the native tool for model, size, or other settings. Do not invent arguments or copy local-tool settings into native calls.
- Known captured completion fields include `revised_prompt`, `action`, `background`, `output_format`, `quality`, and `size`. The original prompt and model are not necessarily captured; these observations are not a complete wire schema.

---

## Attach local inputs

Local `image_generate` requires reference tool arguments for edits and reference-driven generation, even if images are already visible in the conversation. References may be local PNG, JPEG, GIF, or WebP paths; HTTPS image URLs; or matching `data:image/<format>;base64` URLs.

The calling agent supplies `short_name` as sidebar name metadata for the original local tool. The configured `lightweight_model` handles image-generation orchestration, not the title model.

Before every local edit call, including follow-up iterations, attach the image being edited:

- For exactly one input image, use `reference_image: "<path-or-url>"`.
- For two or more input images, use `reference_images: ["<edit-target>", "<other-reference>"]`.
- Choose the tool-argument order first. For edits, put the primary edit target first unless the user requires another order. Number `Image 1`, `Image 2`, and later prompt labels from that final order, then state each image's role.
- Never provide both `reference_image` and `reference_images` in one call.
- Do not call an edit with neither argument. If the source is not available, locate it or ask the user for it instead of recreating it from a text description.
- Attach style, composition, or subject references for new-image generation through the same arguments; prompt text alone does not provide their image data either.
- For each follow-up edit, replace the prior edit target with the latest generated output and reattach it using `reference_image`, or place it first in `reference_images` before any still-needed supporting references. Each tool call is independent.

Local single-image edit:

```json
{
  "prompt": "Replace only the background with a warm sunset gradient. Keep the product and its edges unchanged.",
  "short_name": "sunset-background",
  "reference_image": "/absolute/path/product.png"
}
```

Local multi-image edit:

```json
{
  "prompt": "Image 1 is the edit target. Apply the lighting and palette from Image 2 while preserving Image 1's subject and composition.",
  "short_name": "relit-product",
  "reference_images": ["/absolute/path/product.png", "/absolute/path/style.jpg"]
}
```

---

## Select raster tasks

- Generate a new image, such as concept art, a product shot, a cover, or a website hero.
- Generate a new image using one or more reference images for style, composition, or mood.
- Edit an existing image, such as inpainting, lighting or weather transformations, background replacement, object removal, compositing, or transparent-background cutouts.
- Produce many assets or variants for one task.

---

## Prefer editable assets

- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo.
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas.
- Making a small project-local asset edit when the source file already exists in an editable native format.
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap.

---

## Decide the intent

Think about two separate questions:

1. Intent: is this a new image or an edit of an existing image?
2. Execution strategy: is this one asset or many assets/variants?

Intent:

- If the user wants to modify an existing image while preserving parts of it, treat the request as edit.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as generate.
- If the user provides no images, treat the request as generate.

Execution strategy:

- For many assets or variants, issue one built-in call per requested asset or variant.
- For many distinct assets, do not use one prompt as a substitute for separate prompts. Distinct assets need distinct built-in calls.
- Assume the user wants a new image unless they clearly ask to change an existing one.

---

## Follow the workflow

1. Decide the intent: generate or edit.
2. Decide whether the output is preview-only or meant to be consumed by the current project.
3. Decide the execution strategy: single asset or repeated built-in calls.
4. Collect inputs up front: prompt(s), exact text, constraints/avoid list, and any source or reference images.
5. Use local `image_generate` by default, or experimental native `image_generation` only when explicitly enabled and eligible; supply inputs using its attachment flow above and identify each image's role explicitly.
6. If an edit source is unavailable, locate it or ask the user rather than recreating it from a text description.
7. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use image generation rather than substituting SVG/HTML/CSS placeholders.
8. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
9. Augment the prompt based on specificity: preserve detailed prompts, and only add tasteful details to generic prompts when it materially improves output quality.
10. Call the selected tool with only its exposed arguments.
11. Inspect outputs and validate subject, style, composition, text accuracy, invariants, and avoid items.
12. Iterate with a single targeted change using the latest output via local reattachment or, for opt-in experimental native calls, context replay, then re-check.
13. For preview-only work, report the generated path.
14. For project-bound work, move or copy the selected artifact into the workspace and update any consuming code or references.
15. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only.
16. Report final saved path(s), the prompt or prompt set you supplied, and which tool was used. If reporting a captured `revised_prompt`, label it as revised rather than the original prompt; requested model IDs are forwarded, not verification of the returned image's model.

---

## Preserve transparency

Ask the selected tool for a genuinely transparent background and preserve its alpha. Do not default to chroma-key generation or local background removal.

Default sequence:

1. Request real alpha transparency in the prompt, using only settings exposed by the selected tool.
2. Use PNG or WebP, not JPEG, to preserve alpha.
3. Validate actual alpha values, not just an RGBA mode or a checkerboard-looking preview. Check transparent background regions and plausible subject opacity; partial alpha is expected for smooth edges and translucent materials.
4. For complex cutouts, inspect the result over contrasting backgrounds for halos, opaque holes, and lost detail. An alpha channel alone does not prove cutout quality.
5. If the output is opaque or flawed, retry with a targeted prompt or edit using the generated image as a reference. Report persistent limitations rather than silently switching models or removing the background locally.
6. Save the original alpha PNG/WebP in the project if the asset is project-bound. Do not flatten it onto a preview background.

Prompt transparent requests like this:

```text
Isolate the requested subject on a genuinely transparent background with real alpha, not a painted checkerboard or solid color.
Preserve fine edges, empty holes, and partial transparency in translucent materials.
Keep the subject fully in frame with generous padding. No backdrop, floor, text, or watermark unless requested.
```

---

## Refine the prompt

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, add tasteful augmentation only when it will materially improve the result.

Allowed augmentations:

- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:

- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

---

## Classify the task

Generate:

- `photorealistic-natural` — candid/editorial lifestyle scenes with real texture and natural lighting.
- `product-mockup` — product/packaging shots, catalog imagery, merch concepts.
- `ui-mockup` — app/web interface mockups and wireframes; specify the desired fidelity.
- `infographic-diagram` — diagrams/infographics with structured layout and text.
- `scientific-educational` — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- `ads-marketing` — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- `productivity-visual` — slide, chart, workflow, and data-heavy business visuals.
- `logo-brand` — logo/mark exploration, vector-friendly.
- `illustration-story` — comics, children's book art, narrative scenes.
- `stylized-concept` — style-driven concept art, 3D/stylized renders.
- `historical-scene` — period-accurate/world-knowledge scenes.

Edit:

- `text-localization` — translate/replace in-image text, preserve layout.
- `identity-preserve` — try-on, person-in-scene; lock face/body/pose.
- `precise-object-edit` — remove/replace a specific element.
- `lighting-weather` — time-of-day/season/atmosphere changes only.
- `background-extraction` — transparent background or clean cutout.
- `style-transfer` — apply reference style while changing subject/scene.
- `compositing` — merge one or more reference images with matched lighting and perspective.
- `sketch-to-render` — drawing/line art to photoreal render.

---

## Structure the prompt

Use this labeled spec as prompt scaffolding:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: Image 1 — <role>; Image 2 — <role>; Image 3 — <role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:

- `Asset type` and `Input images` are prompt scaffolding only; supply actual images through the selected tool's attachment flow above.
- `Scene/backdrop` refers to the visual setting, not only output transparency behavior.
- Keep prompts short and focused.
- For edits, explicitly list invariants such as `change only X; keep Y unchanged`.
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

---

## Adapt these examples

Generation example:

```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

Edit example:

```text
Use case: precise-object-edit
Asset type: product photo background replacement
Input images: Image 1 — edit target
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

---

## Improve the result

- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography plus placement.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, refer to each image by its supplied order (`Image 1`, `Image 2`) and state its role.
- Make precedence explicit when images conflict, such as `use Image 1 for subject identity and Image 2 for lighting and palette`.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.

---

## Configure local calls

These settings apply to the default local `image_generate`, not experimental native `image_generation`:

- Omit `model` for lightweight `gpt-image-2.5-flare` generation and edits by default, or select it explicitly.
- Explicitly select `model: "gpt-image-2.5-sunburst"` only for precision, detailed premium output, or demanding edits; Flare remains the default.
- Treat `gpt-image-2` and `gpt-image-1.5` as optional compatibility fallbacks, not defaults. Ask before switching to an older model unless the user requested it.
- Use `quality: low` for fast drafts, thumbnails, and quick iterations.
- Use `quality: medium`, `high`, or `auto` for final assets, dense text, diagrams, identity-sensitive edits, or high-resolution outputs.
- Square images are typically fastest to generate. Use `1024x1024` for fast square drafts.
- Popular sizes include `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, and `auto`.
- For 2.5 models, omit `background` or leave it `auto`; if set to `transparent`, the local tool adds a transparency instruction to the prompt and sends `background=auto` to the backend.

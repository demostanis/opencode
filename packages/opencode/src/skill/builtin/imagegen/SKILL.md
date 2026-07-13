---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when opencode should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill

Generates or edits images for the current project, for example website assets, game assets, UI mockups, product mockups, wireframes, logo exploration, photorealistic images, or infographics.

## Top-level rules

- Use the built-in `image_generate` tool by default for normal image generation requests. It uses Codex/ChatGPT auth and does not require `OPENAI_API_KEY`.
- For editing or reference-driven work, set `reference_images` to an ordered list of one or more local PNG, JPEG, GIF, or WebP image paths; HTTPS image URLs; or matching `data:image/<format>;base64` URLs. `reference_image` remains available for one image; never provide both arguments.
- Do not describe or rely on OS temp as the default destination. Built-in outputs are saved under opencode's generated-images data directory.
- Do not describe or rely on a destination-path argument on the built-in tool. If a specific location is needed, generate first and then move or copy the selected output.
- If the user names a destination, move or copy the selected output there.
- If the image is meant for the current project, move or copy the final selected image into the workspace before finishing.
- If the image is only for preview or brainstorming, the underlying file can remain at the default generated-images path.
- Never leave a project-referenced asset only at the default generated-images path.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

## When to use

- Generate a new image, such as concept art, a product shot, a cover, or a website hero.
- Generate a new image using one or more reference images for style, composition, or mood.
- Edit an existing image, such as inpainting, lighting or weather transformations, background replacement, object removal, compositing, or transparent-background cutouts.
- Produce many assets or variants for one task.

## When not to use

- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo.
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas.
- Making a small project-local asset edit when the source file already exists in an editable native format.
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap.

## Decision tree

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

## Workflow

1. Decide the intent: generate or edit.
2. Decide whether the output is preview-only or meant to be consumed by the current project.
3. Decide the execution strategy: single asset or repeated built-in calls.
4. Collect inputs up front: prompt(s), exact text, constraints/avoid list, and optional reference images.
5. Number input images by their supplied order and label each role explicitly: reference, edit target, style, composition, or supporting insert.
6. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use `image_generate` rather than substituting SVG/HTML/CSS placeholders.
7. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
8. Augment the prompt based on specificity: preserve detailed prompts, and only add tasteful details to generic prompts when it materially improves output quality.
9. Use the built-in `image_generate` tool.
10. Inspect outputs and validate subject, style, composition, text accuracy, invariants, and avoid items.
11. Iterate with a single targeted change, then re-check.
12. For preview-only work, report the generated path.
13. For project-bound work, move or copy the selected artifact into the workspace and update any consuming code or references.
14. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only.
15. Always report final saved path(s), the final prompt or prompt set, and that built-in image generation was used.

## Transparent image requests

Transparent-image requests should use built-in image generation first. If true model-native transparency is not available or is unreliable, create a removable chroma-key source image and then convert the key color to alpha locally.

Default sequence:

1. Generate the requested subject on a perfectly flat solid chroma-key background.
2. Choose a key color that is unlikely to appear in the subject: default `#00ff00`, use `#ff00ff` for green subjects, and avoid `#0000ff` for blue subjects.
3. Move or copy the selected source image into the workspace or `tmp/imagegen/`.
4. Remove the chroma key with a local image-processing tool available in the project or environment.
5. Validate that the output has an alpha channel, transparent corners, plausible subject coverage, and no obvious key-color fringe.
6. Save the final alpha PNG/WebP in the project if the asset is project-bound.

Prompt transparent requests like this:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

## Prompt augmentation

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

## Use-case taxonomy

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

## Shared prompt schema

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

- `Asset type` and `Input images` are prompt scaffolding. Pass the images through `reference_images` in the same order.
- `Scene/backdrop` refers to the visual setting, not only output transparency behavior.
- Keep prompts short and focused.
- For edits, explicitly list invariants such as `change only X; keep Y unchanged`.
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

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

## Prompting best practices

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

## Model guidance

- Use `gpt-image-2` by default.
- Use `gpt-image-1.5` only when the user explicitly requests it or when its behavior is needed for a specific image-generation feature.
- Use `quality: low` for fast drafts, thumbnails, and quick iterations.
- Use `quality: medium`, `high`, or `auto` for final assets, dense text, diagrams, identity-sensitive edits, or high-resolution outputs.
- Square images are typically fastest to generate. Use `1024x1024` for fast square drafts.
- Popular sizes include `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, and `auto`.

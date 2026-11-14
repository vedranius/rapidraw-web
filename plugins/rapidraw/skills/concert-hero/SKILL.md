---
name: concert-hero
description: "Concert and festival photograph with clean stage light, protected highlights, readable faces and a warm gold/teal story. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Concert Hero"
  triggers: "concert, koncert, festival, stage, pozornica, bina, bend, singer, pjevač, svirka"
  rapidraw-commands: "photo.inspect, photo.auto-tone, photo.auto-lens, photo.auto-straighten, photo.histogram, photo.denoise, photo.ai-mask, photo.prompt-style, settings.patch, photo.crop"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `photo.auto-tone`, `photo.auto-lens`, `photo.auto-straighten`, `photo.histogram`, `photo.denoise`, `photo.ai-mask`, `photo.prompt-style`, `settings.patch`, `photo.crop`.
<!-- /mcp -->

# Concert Hero

Use this for live music, clubs, festivals and theatre.

1. Inspect the photo and the histogram. Stage light is usually clipped, so do
   not trust the camera JPEG.
2. If the file is high-ISO (ISO 3200+) and noisy, denoise first with AI at
   35–55. Do not over-denoise faces or fabric.
3. Auto-tone only as a baseline. Then pull highlights back until the lit face
   and white shirts keep detail. Lift shadows enough to read the performer,
   never enough to reveal coloured haze as grey mud.
4. Keep the stage colour story: warm gold/amber key light, teal or magenta
   backlight. Do not neutralise the colour cast completely — it is the scene.
5. Local mask on the performer: +0.10 to +0.25 EV, shadows +8–18, clarity
   +5–12, slight warmth. Keep the background darker.
6. Finish with contrast 8–20, saturation -3 to +8, grain 5–18, halation 8–25
   only when practical lights are visible. Avoid heavy vignette on a dark stage.
7. Verify the histogram: median roughly 0.20–0.55 for a low-key concert, no
   more than 1–2% pure white clipping, shadows not crushed into a black blob.

Never use daylight white balance, HDR merge, panorama or focus stack on a
single live frame.

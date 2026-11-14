---
name: editorial-colour
description: "Magazine-style colour with a clear palette, clean skin and intentional contrast. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Editorial Colour"
  triggers: "editorial, magazin, fashion, moda, campaign, kampanja, colorful, colour, cinematic, filmski, teal and orange"
  rapidraw-commands: "photo.inspect, photo.auto-tone, photo.histogram, photo.prompt-style, photo.ai-mask, settings.patch, photo.crop"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `photo.auto-tone`, `photo.histogram`, `photo.prompt-style`, `photo.ai-mask`, `settings.patch`, `photo.crop`.
<!-- /mcp -->

# Editorial Colour

1. Inspect the image and choose one colour story. Do not mix teal/orange,
   pastel and neon in one grade.
2. Auto-tone, then set contrast 12–28, highlights -15 to -30, shadows +5 to
   +18. Protect skin and white fabric.
3. Use a prompt style with an explicit reference: "editorial fashion, warm
   highlights, cool shadows, teal and orange", "pastel 1960s editorial",
   "high-key beauty", "neon night editorial".
4. Add a subject mask with +0.08–0.16 EV and clarity -3 to +5. Add a background
   mask with -0.1 to -0.3 EV if it competes.
5. HSL: reduce competing greens/yellows by 5–15 saturation; do not remove all
   colour from a scene that needs context.
6. Finish with vignette -10 to -22, grain 0–12. Halation only for practical
   lights or a deliberate film look.
7. Check the histogram and skin. Saturation is not a substitute for contrast.

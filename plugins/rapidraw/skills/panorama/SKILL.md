---
name: panorama
description: "Stitch overlapping frames and finish the panorama without stretching the edges. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Panorama"
  triggers: "panorama, pano, panorama, stitch, spajanje, široki kadar, wide shot, 360"
  rapidraw-commands: "photo.inspect, photo.panorama, photo.auto-tone, photo.auto-lens, photo.histogram, settings.patch, photo.crop, library.refresh"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `photo.panorama`, `photo.auto-tone`, `photo.auto-lens`, `photo.histogram`, `settings.patch`, `photo.crop`, `library.refresh`.
<!-- /mcp -->

# Panorama

Use only when two or more overlapping frames cover one wide scene.

1. Do not correct lens distortion before stitching; the stitcher needs the
   original geometry. Auto lens correction is applied to the saved panorama.
2. Stitch with `photo.panorama` and wait for the saved path.
3. Inspect the result for a curved horizon, repeated subjects or black gaps.
   If the horizon is bent, correct it before cropping; do not hide it with a
   crop unless the user asks.
4. Finish: auto-tone, highlights -10 to -25, shadows +5 to +18, contrast
   5–15, vibrance 3–10. Keep the sky and ground exposure consistent.
5. Crop only to remove empty borders, not to change the intended composition.
6. Verify the histogram and report the saved path.

Never use panorama for a single frame or for an exposure bracket.

---
name: focus-stack
description: "Merge a focus bracket into a sharp macro or product image, then clean up the result. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Focus Stack"
  triggers: "focus stack, focus stacking, fokus, stack, makro, macro, product, proizvod, dubina polja, depth of field"
  rapidraw-commands: "photo.inspect, photo.focus-stack, photo.auto-tone, photo.histogram, photo.ai-mask, settings.patch, photo.crop, library.refresh"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `photo.focus-stack`, `photo.auto-tone`, `photo.histogram`, `photo.ai-mask`, `settings.patch`, `photo.crop`, `library.refresh`.
<!-- /mcp -->

# Focus Stack

Use only on two or more frames with the same framing but different focus
distances.

1. Confirm identical dimensions and orientation.
2. Merge with `photo.focus-stack`; the saved TIFF is next to the first frame.
3. Inspect for focus halos, ghosted edges or a soft frame. If a frame is
   misaligned, the stack may need to be redone; do not hide it with clarity.
4. Finish gently: auto-tone, highlights -10 to -25, shadows +5 to +15,
   clarity 0–8, sharpness 5–12, saturation -2 to +5.
5. Do not apply grain or heavy halation to a macro/product image.
6. Verify the histogram and report the saved file path.

Never stack a hand-held burst with different compositions or an HDR bracket.

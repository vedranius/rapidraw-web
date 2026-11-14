---
name: social-export
description: "Export a clean, correctly sized JPEG set for Instagram, web or client review. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Social Export"
  triggers: "export, izvoz, izvezi, instagram, social, web, jpeg, client, klijent, resize, veličina"
  rapidraw-commands: "photo.inspect, photo.histogram, photo.crop, library.export, library.refresh"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `photo.histogram`, `photo.crop`, `library.export`, `library.refresh`.
<!-- /mcp -->

# Social Export

1. Confirm the output folder. If none is supplied and the user has not set a
   preset, ask for it instead of exporting to a random location.
2. Apply the intended crop first: 4:5 or 1:1 for feed, 9:16 for stories,
   16:9 for web hero. Do not crop the subject's hands or head off.
3. Export JPEG quality 82–92, long edge 2048 for feed, 1080 for stories,
   2560 for web. Keep metadata unless asked to strip GPS.
4. Never export an unedited or accidentally underexposed frame. Verify the
   histogram first.
5. Report the folder and how many files were written.

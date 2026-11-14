---
name: cull-burst
description: "Content-aware culling of a burst or event set with composition, light, expression and technical quality in mind. Edits the photo in RapidRAW through the rapidraw MCP server."
metadata:
  title: "Cull Burst"
  triggers: "cull, culling, selekcija, odaberi, izbaci, burst, serija, best of, najbolje"
  rapidraw-commands: "photo.inspect, library.cull, library.rate, library.flag, library.refresh"
---

<!-- mcp -->
> RapidRAW Web recipe. Use the `rapidraw` MCP server: `rapidraw_status`, then `rapidraw_get_edit` and
> `rapidraw_preview` of the photo, then run the steps below with `rapidraw_run` (command ids such as
> `photo.ai-mask`; parameters in `rapidraw_commands`) or slider changes with `rapidraw_apply_adjustments`.
> Check with `rapidraw_preview` and refine. `rapidraw_undo` reverts a run. Ask before exporting.
> Commands this recipe uses: `photo.inspect`, `library.cull`, `library.rate`, `library.flag`, `library.refresh`.
<!-- /mcp -->

# Cull Burst

Use on a real burst or event set, never on a single unrelated folder.

1. Run `library.cull` on the selected paths.
2. Read the suggestions as advice, not truth. The ranking already considers
   composition, lighting, subject/expression and technical sharpness.
3. Keep the strongest frame of each moment. Do not keep three near-identical
   frames just because all are sharp.
4. Prefer the frame with the best expression and readable face over a slightly
   sharper frame with a blink or awkward gesture.
5. Flag picks/rejects or set stars only when the user asked for that action.
   Otherwise present the suggestions and let the photographer decide.
6. Never delete files during culling unless the user explicitly asks.

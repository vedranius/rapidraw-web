---
name: photo-studio
description: "Decide per request whether a photo job goes to RapidRAW Web (RAW development, global and masked edits, denoise, culling, batch export) or to PhotoCraft (layers, composites, double exposure, merging several photos, text, creative effects), and hand files between them without losing quality or metadata. Use when a request mixes RAW editing with creative or layered work, or names PhotoCraft."
metadata:
  title: "Photo studio: RapidRAW Web + PhotoCraft"
  mcp-only: "true"
---

# One studio, two engines

Two MCP servers work together:

- `rapidraw` (RapidRAW Web): the RAW developer. Non-destructive, GPU, whole shoots as headless jobs.
- `photocraft` (PhotoCraft, open-source layered editor by Storytold, started as
  `photocraft-cli mcp`, headless by default): layers, masks, blend modes, filters, text, composites. Set it up with
  `rrweb/photocraft/setup.sh` (see AI_MCP.md, "PhotoCraft").

Start every job with `rapidraw_status` and, if the job may need layers, PhotoCraft's `session_list`. If
`photocraft` is missing, say so once, do everything RapidRAW can do, and offer the setup script for the rest.
Never imitate a layered composite with RapidRAW sliders.

## Who does what

| The user asks for | Engine | How |
| --- | --- | --- |
| Develop a RAW: exposure, white balance, tone, colour, HSL, grading, curves | RapidRAW | `rapidraw_apply_adjustments` / `rapidraw_process` |
| Denoise, lens correction, crop, straighten | RapidRAW | `photo.denoise`, `photo.auto-lens`, `photo.crop` |
| Local edits on a person, face, sky or background | RapidRAW | AI masks (`rapidraw_ai_mask`, `photo.ai-mask`) |
| Cull, rate, flag a shoot; batch the same look over many photos | RapidRAW | `concert-processing`, `concert-best-of` |
| HDR, panorama, focus stack of frames from one camera position | RapidRAW | `hdr-bracket`, `panorama`, `focus-stack` |
| Black and white, film grain, glow, halation, vignette on one photo | RapidRAW | sliders, `documentary-noir` |
| Double exposure, combining two or more different photos | PhotoCraft | layers + blend modes + masks |
| Cut out a performer, new or blurred background, collage, triptych | PhotoCraft | `select.subject`, layer masks, `doc_place` |
| Motion or zoom blur on part of the photo, light streaks, flares, glitch, painting looks | PhotoCraft | filters on a duplicated layer with a mask |
| Text, logo, poster, cover, story frame with a band name | PhotoCraft | `doc_new`, type and shape commands, layer styles |
| A layered master to edit again later (PSD / .pcraft) | PhotoCraft | `doc_save` |
| Social sizes of a finished composite | PhotoCraft (single files) or RapidRAW `social-export` (many developed photos) | |

When one request needs both, the order is always **RapidRAW first, then PhotoCraft**: develop and denoise
the RAW, then build on the developed pixels. Never send a RAW to PhotoCraft for a composite; its RAW
filter is a fallback, not the developer. If the user later wants a different colour on the base photo,
change it in RapidRAW, export again and replace the layer in PhotoCraft (`doc_replace_smart_object` on
the Smart Object), so the composite keeps its masks and effects.

## The hand-off

1. **Export from RapidRAW for PhotoCraft:** `rapidraw_export` with `format: "tiff"` (16-bit, sRGB, with
   EXIF, IPTC and XMP), no `longEdge` (full size) unless the user asked for a size, into a hand-off folder
   that PhotoCraft may read, e.g. `<shoot>/_studio/in`. Confirm the folder once with the user
   (`allowRisky`). JPEG is never a hand-off format: it is 8-bit and the blend modes band in dark stage areas.
2. **Open in PhotoCraft:** `doc_open {path}` for the base photo, `doc_place {path}` for every other photo
   (each becomes a Smart Object layer that can be replaced later). `doc_inspect` shows the layer ids.
3. **Work in layers, never on the base pixels.** Duplicate before filters (`layer.duplicate`), set blend
   and opacity with `layer.setProps {layer, blend, opacity}` (opacity 0..1, blend names such as `Screen`,
   `Multiply`, `Overlay`, `SoftLight`, `LinearDodge`, `Color`, `Luminosity`), limit effects with masks
   (`select.subject` → `layer.layerMask.revealSelection`, or `layer.layerMask.hideSelection`). Use
   `command_batch` for a recipe, `render_preview {max_side: 1600}` to look, and `edit.undo` to step back.
   `command_list {filter: "filter."}` shows every filter and its parameters; do not guess parameters.
4. **Save the master and the deliverable:** paths are relative to the write root (`"cover.pcraft"`, not
   `"out/cover.pcraft"`). `doc_save {path: "<name>.pcraft"}` (or `.psd` for other apps),
   then `doc_export` to `.tif` (16-bit stays 16-bit) or `.jpg` (`quality` 90–95 for web). PhotoCraft writes
   only below its write root. A `.pcraft` is large (10–30 MB at 2048 px); keep it only for frames that
   will be edited again.
5. **Metadata:** an opened photo keeps its EXIF, ICC and XMP in PhotoCraft's JPEG and TIFF exports; a
   composite made with `doc_new` has none. Check with `exiftool -s -Make -Model -DateTimeOriginal -Artist
   -Copyright <file>`; if they are missing, copy them from the RapidRAW TIFF of the base photo with
   `exiftool -overwrite_original -TagsFromFile <base>.tif -all:all -ImageSize= <file>`. Add the credit the
   user wants (`-Artist`, `-Copyright`) to every deliverable.
6. **Back to the library (optional):** the finished TIFF or JPEG in `_studio/out` can be rated and flagged in
   RapidRAW like any photo (`rapidraw_set_library`), so the shoot's picks and the creative versions sit side by side.

## Rules

- Ask before overwriting anything and before exporting a whole shoot; single previews need no question.
- Keep composites honest: never put a performer into a scene or a crowd they were not in and present it as
  a real moment. Creative composites (double exposure, posters, collages) are fine; say they are composites
  when the user publishes them as reportage.
- A concert gallery stays a gallery: one consistent look over all the photos (RapidRAW), and only a few hero
  frames get PhotoCraft treatment (a cover, a poster, a social teaser). The `stage-looks` skill has the looks
  and the effect recipes.
- Call `rapidraw_preview` one at a time: parallel previews time out.
- Heavy PhotoCraft filters on a 26 MP 16-bit file take time: test on `image.duplicate` resized to 2000 px
  first, then run the final recipe on the full-size document.

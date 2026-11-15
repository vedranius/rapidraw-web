---
name: stage-looks
description: "Concert looks and creative effects that need layers: zoom-burst or spin edges around a sharp performer, glowing light beams, extra face grit, double exposures, gallery covers, posters and story frames. Combines the Stage Fire & Ice grade in RapidRAW Web with PhotoCraft layer recipes. Use for 'make it look like a rock magazine gallery', 'zoom burst', 'double exposure', 'cover for the gallery', 'poster with the band name'."
metadata:
  title: "Stage looks: RapidRAW grade + PhotoCraft effects"
  mcp-only: "true"
---

# Stage looks

Read `photo-studio` first: it decides the engine and describes the hand-off (RapidRAW 16-bit TIFF →
PhotoCraft → `.pcraft` master + JPEG). This skill holds the looks and the recipes.

## 1. The base grade always comes from RapidRAW

Every photo of the gallery gets the **Stage Fire & Ice** grade (`rapidraw_skills {id: "stage-fire-ice"}`)
through `rapidraw_process` (one call per band, the same `adjustments`, `perPhoto` only for exposure). The
grade alone already carries the look: two-colour light (fire orange-red and ice cyan), low key with a soft
black floor, warm highlights with glow, gritty faces, a deep vignette and an optional zoom-burst edge
(`motionBlurType: "zoom"`). Most photos of a gallery need nothing else.

Starting patch for `rapidraw_process` / `rapidraw_apply_adjustments` (tune exposure per photo):

```json
{
  "contrast": 25, "highlights": -50, "whites": -15, "shadows": 15, "blacks": -20,
  "temperature": 8, "vibrance": 20, "saturation": 8,
  "hsl": {
    "reds": {"hue": 10, "saturation": 15, "luminance": 0}, "oranges": {"hue": 0, "saturation": 20, "luminance": 5},
    "yellows": {"hue": -50, "saturation": -10, "luminance": 0}, "greens": {"hue": 100, "saturation": -50, "luminance": 0},
    "aquas": {"hue": 15, "saturation": 20, "luminance": 0}, "blues": {"hue": -50, "saturation": 15, "luminance": 0},
    "purples": {"hue": -80, "saturation": -40, "luminance": 0}, "magentas": {"hue": 60, "saturation": -10, "luminance": 0}
  },
  "colorGrading": {"balance": 10, "blending": 50,
    "shadows": {"hue": 20, "saturation": 5, "luminance": 0}, "midtones": {"hue": 25, "saturation": 8, "luminance": 0},
    "highlights": {"hue": 35, "saturation": 25, "luminance": 0}},
  "clarity": 30, "structure": 20, "sharpness": 30, "dehaze": 10,
  "glowAmount": 20, "halationAmount": 18,
  "grainAmount": 12, "grainSize": 25,
  "vignetteAmount": -50, "vignetteMidpoint": 30, "vignetteFeather": 70,
  "motionBlurType": "zoom", "motionBlurAmount": 15
}
```

Leave out `motionBlur*` for wide crowd shots and for photos where the performer is not near the centre;
those get the PhotoCraft edge (recipe A) with the centre on the performer instead. Smartphone photos: half
the clarity and sharpness (the phone already sharpened), grain 5–8, no extra denoise.

Gallery rules: all photos landscape 3:2 at 2000–2048 px on the long edge for the web, performer near the
centre, no frames, borders or burned-in text in gallery photos (credit goes into the metadata and the
caption). Composites and text are for covers, posters and social posts only.

## 2. PhotoCraft recipes

Work on the 16-bit TIFF from RapidRAW. Every recipe runs as one `command_batch` (or step by step with
`command_run`) and ends with `render_preview {max_side: 1600}`. Coordinates are document pixels; read the
size with `doc_inspect`. Parameters below are the engine's own; `command_list {filter: "<id>"}` shows the
full list. Opacity in `layer.setProps` is 0..1; in layer styles and groups it is 0..100.

### A. Zoom-burst or spin edge around a sharp performer

When: hero frames, the performer off-centre, or a stronger swirl than RapidRAW's zoom gives.

```json
[{"id": "layer.duplicate", "params": {}},
 {"id": "filter.blur.radialBlur", "params": {"method": "zoom", "amount": 16, "quality": "best", "centerX": 0.5, "centerY": 0.42}},
 {"id": "select.rect", "params": {"x": 1700, "y": 600, "width": 2600, "height": 2600, "ellipse": true, "feather": 260}},
 {"id": "layer.layerMask.hideSelection", "params": {}},
 {"id": "select.deselect", "params": {}},
 {"id": "layer.setProps", "params": {"name": "Zoom burst", "opacity": 0.9}}]
```

- `centerX`/`centerY` (0..1) and the ellipse go on the performer's face or chest; the feather is about 5–8 %
  of the long edge. `method: "spin"` with `amount` 6–12 gives the swirl variant.
- Use `select.subject` instead of the ellipse when the performer must stay sharp to the fingertips.
- A second, weaker copy (`amount` 30, opacity 0.4) only for very busy light rigs.

### B. Glowing beams and bloom

When: haze and beams look flat after the grade.

```json
[{"id": "select.colorRange", "params": {"select": "highlights"}},
 {"id": "layer.new.layerViaCopy", "params": {}},
 {"id": "filter.blur.gaussianBlur", "params": {"radius": 40}},
 {"id": "layer.setProps", "params": {"name": "Beam glow", "blend": "screen", "opacity": 0.45}}]
```

Radius about 1–2 % of the long edge. If the faces glow too, add a mask:
`select.subject` → `layer.layerMask.hideSelection`.

### C. Face and metal grit

When: a close-up should look rougher than the clarity slider allows.

```json
[{"id": "layer.duplicate", "params": {}},
 {"id": "filter.other.highPass", "params": {"radius": 4}},
 {"id": "layer.setProps", "params": {"name": "Grit", "blend": "overlay", "opacity": 0.5}}]
```

Then `select.subject` → `layer.layerMask.revealSelection` so only the performer gets it. Never on babies,
weddings or portraits that should flatter.

### D. Double exposure (performer + lights or crowd)

When: a cover or poster; never inside a reportage gallery without saying it is a composite.

1. `doc_open` the performer (base), then `select.subject` and `select.saveSelection {"name": "performer"}`.
2. `doc_place {path: "<lights or crowd>.tif"}`: a Smart Object layer above the base.
3. `layer.setProps {blend: "screen", opacity: 0.7}` (or `linearDodge` for hot lights, `multiply` for a
   dark silhouette fill).
4. `select.loadSelection {"name": "performer"}` → `layer.layerMask.hideSelection` keeps the face clean;
   `select.loadSelection` + `layer.layerMask.revealSelection` puts the second photo inside the silhouette
   instead (the classic double exposure, on a dark or plain background).
5. Optional: `filter.blur.gaussianBlur {radius: 3}` on the placed layer so the two photos do not fight.

### E. Gallery cover or triptych

```text
doc_new {width: 2048, height: 1365, background: black}
doc_place   band photo 1, 2, 3  (scale so each fills a third; center x = 341, 1024, 1707)
select.rect + layer.layerMask.revealSelection on each so the thirds do not overlap
type.create {x: 1024, y: 1250, text: "KAMELOT · BOOGALOO · 13.11.2026", size: 64, color: "#ffffff", align: "center", font: "Oswald"}
layer.layerStyle.dropShadow {opacity: 60, size: 18, distance: 0}
```

### F. Social story or square

`doc_new {width: 1080, height: 1920}` (or 1080×1350 for Instagram 4:5) → `doc_place` the photo twice:
the lower copy `filter.blur.gaussianBlur {radius: 60}` + `layer.setProps {opacity: 0.6}` as a background,
the upper copy at full width in the middle; the band name with `type.create` at the top. Export JPEG at
quality 90 next to the `.pcraft` master.

## 3. Checks before handing over

- `render_preview` of the finished file next to the RapidRAW version: the face is sharp, the edge effect
  does not cut into hands or the microphone, the glow does not wash out the blacks.
- Histogram of the export still matches the grade: darkest 1 % above 0, at most 1 % pure white.
- Metadata (`photo-studio`, step 5): camera, date, credit. Name files `<event>-<band>-<nn>-<recipe>.jpg`.

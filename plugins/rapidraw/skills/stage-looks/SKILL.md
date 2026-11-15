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
  "exposure": 0.3, "contrast": 25, "highlights": -25, "whites": 0, "shadows": 30, "blacks": -5,
  "temperature": 8, "vibrance": 5, "saturation": -10,
  "hsl": {
    "reds": {"hue": 30, "saturation": -25, "luminance": 0}, "oranges": {"hue": 0, "saturation": 10, "luminance": 5},
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
  "vignetteAmount": -65, "vignetteMidpoint": 25, "vignetteFeather": 70,
  "motionBlurType": "zoom", "motionBlurAmount": 15
}
```

Add a luma curve point `{x: 0, y: 10}` (black floor) in the editor or with `settings.patch`; tested on Fujifilm
RAFs this patch lands the median at about 20–25 of 255 with no clipping, so raise exposure per photo when the
performer is dark. RapidRAW's zoom blur is always centred on the frame: keep it only when the face is in the
central third.

Leave out `motionBlur*` for wide crowd shots and for photos where the face is outside the central third;
those get the PhotoCraft edge (recipe A) with the centre on the performer instead. Smartphone photos: half
the clarity and sharpness (the phone already sharpened), grain 5–8, no extra denoise.

Gallery rules: all photos landscape 3:2 at 2000–2048 px on the long edge for the web, performer near the
centre, no frames, borders or burned-in text in gallery photos (credit goes into the metadata and the
caption). Composites and text are for covers, posters and social posts only.

## 2. PhotoCraft recipes

Work on the 16-bit TIFF from RapidRAW. Every recipe runs as one `command_batch` (or step by step with
`command_run`) and ends with `render_preview {max_side: 1600}`. Numbers below are for 2048 px photos; scale radii, feathers and
expands with the long edge (×3 at 6000 px). Coordinates are document pixels; read the
size with `doc_inspect`. Parameters below are the engine's own; `command_list {filter: "<id>"}` shows the
full list. Opacity in `layer.setProps` is 0..1; in layer styles and groups it is 0..100.

### A. Zoom-burst or spin edge around a sharp performer

When: hero frames, the performer off-centre, or a stronger swirl than RapidRAW's zoom gives.

```json
[{"id": "layer.duplicate", "params": {"name": "Zoom burst"}},
 {"id": "filter.blur.radialBlur", "params": {"method": "zoom", "amount": 10, "quality": "best", "centerX": 0.35, "centerY": 0.4}},
 {"id": "layer.select", "params": {"name": "Background"}},
 {"id": "select.subject", "params": {}},
 {"id": "select.modify.expand", "params": {"radius": 25}},
 {"id": "select.modify.feather", "params": {"radius": 45}},
 {"id": "layer.select", "params": {"name": "Zoom burst"}},
 {"id": "layer.layerMask.hideSelection", "params": {}}]
```

- `centerX`/`centerY` (0..1) go on the performer's face. The subject is selected on the sharp layer
  ("Background"), expanded and feathered because Select Subject often misses hands, guitars and legs; check
  the preview. Masking commands clear the selection themselves: never follow them with `select.deselect`
  (it fails with "no selection" and stops the batch).
- `method: "spin"` with `amount` 6–8 gives the swirl (5–6 when the subject mask is incomplete).
- Wide shots: an ellipse instead of the subject, `select.rect {x, y, width, height, ellipse: true,
  feather: 120}` around the stage centre.
- Tested: zoom 10 with the subject mask takes the edge/centre sharpness from 0.46 to 0.29, inside the range
  of the reference galleries (0.15–0.37); zoom 16 with only an ellipse smears outstretched hands.

### B. Glowing beams and bloom

When: haze and beams look flat after the grade.

```json
[{"id": "select.colorRange", "params": {"select": "highlights"}},
 {"id": "layer.new.layerViaCopy", "params": {}},
 {"id": "filter.blur.gaussianBlur", "params": {"radius": 50}},
 {"id": "layer.setProps", "params": {"name": "Beam glow", "blend": "screen", "opacity": 0.35}}]
```

Radius 2–3 % of the long edge. Screen 0.35, or `softLight` 0.8 for a safer version; screen 0.45 and more
pushes clipping over 0.5 %, so measure it. Prefer RapidRAW's `glowAmount` and use this only on flat hazy
beams. If the faces glow too, add a mask:
`select.subject` → `layer.layerMask.hideSelection`.

### C. Face and metal grit

When: a close-up should look rougher than the clarity slider allows.

```json
[{"id": "layer.duplicate", "params": {}},
 {"id": "filter.other.highPass", "params": {"radius": 3}},
 {"id": "layer.setProps", "params": {"name": "Grit", "blend": "overlay", "opacity": 0.8}}]
```

Then `select.subject` → `layer.layerMask.revealSelection` so only the performer gets it. Never on babies,
weddings or portraits that should flatter.

### D. Double exposure (performer + lights or crowd)

When: a cover or poster; never inside a reportage gallery without saying it is a composite.

1. `doc_open` the performer (base), then `select.subject`, `select.modify.expand {radius: 25}`,
   `select.modify.feather {radius: 45}` and `select.saveSelection {"name": "performer"}`.
2. `doc_place {path: "<lights or crowd>.tif"}`: a Smart Object layer above the base.
3. Calm the placed photo first (`image.adjustments.hueSaturation` or `desaturate`, darker), then
   `layer.setProps {blend: "screen", opacity: 0.45}` (0.4–0.5; 0.7 buries the performer; `linearDodge` for
   hot lights, `multiply` for a dark silhouette fill).
4. `select.loadSelection {"channel": "performer"}` → `layer.layerMask.hideSelection` keeps the face clean;
   `select.loadSelection {"channel": "performer"}` + `layer.layerMask.revealSelection` puts the second photo inside the silhouette
   instead (the classic double exposure, on a dark or plain background).
5. Optional: `filter.blur.gaussianBlur {radius: 3}` on the placed layer so the two photos do not fight.

### E. Gallery cover or triptych

```text
doc_new {width: 2048, height: 1365, background: "black"}
doc_place   band photo 1, 2, 3  scale = 100 × canvas height / photo height (100 for 2048 px exports),
            center [x, 682] with x moved so each face sits inside its third (about 341, 1024, 1707)
select.rect + layer.layerMask.revealSelection on each so the thirds do not overlap
type.create {x: 1024, y: 1250, text: "KAMELOT · BOOGALOO · 13.11.2026", size: 64, color: "#ffffff", align: "center", font: "<installed font>"}
layer.layerStyle.dropShadow {opacity: 60, size: 18, distance: 0}
```

`type.create` warns and falls back when the font is missing: pick one from `fc-list : family` (on a plain
Linux install DejaVu Sans or Noto Sans). Check every third in the preview: a plain centre crop can cut the
singer's face off.

### F. Social story or square

`doc_new {width: 1080, height: 1920, background: "black"}` (or 1080×1350 for Instagram 4:5; the default
white background washes the blurred copy out) → `doc_place` the photo twice:
the lower copy `filter.blur.gaussianBlur {radius: 60}` + `layer.setProps {opacity: 0.6}` as a background,
the upper copy at full width in the middle; the band name with `type.create` at the top. Export JPEG at
quality 90 next to the `.pcraft` master.

## 3. Checks before handing over

- `render_preview` of the finished file next to the RapidRAW version: the face is sharp, the edge effect
  does not cut into hands or the microphone, the glow does not wash out the blacks.
- Histogram of the export still matches the grade: darkest 1 % above 0, at most 1 % pure white.
- Metadata (`photo-studio`, step 5): camera, date, credit. Name files `<event>-<band>-<nn>-<recipe>.jpg`.

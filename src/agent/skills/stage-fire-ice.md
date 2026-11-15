---
name: Stage Fire & Ice
description: Bold rock and metal concert grade: stage light collapsed into two colours (fire orange-red and ice cyan), low key with a soft black floor, warm highlights with glow, gritty faces, a deep tunnel vignette and a zoom-burst edge.
triggers: fire and ice, vatra i led, orange teal, narančasto plavo, metal, rock, heavy, zoom burst, tunel, stage look, pavić, pavic, ravnododna
allowed-tools: photo.inspect, photo.histogram, photo.denoise, photo.ai-mask, settings.patch, photo.crop
---

# Stage Fire & Ice

A loud, stylised live-music look measured from published rock and metal galleries (about a hundred
photos, 2026). It is a gallery look: put the same base on every photo of a set and only adjust exposure
per photo. Ask before using it on weddings, portraits or reportage that should look natural.

What it is, in numbers (8-bit sRGB of the finished photo):
- Only two colour families survive: red to orange (0–60°) and cyan-teal (180–210°). Yellow, green, blue
  and purple light is moved into one of them. About a tenth of the pixels sit at full saturation.
- Low key: median luma 22–45 of 255. Blacks have a floor (darkest 1 % at 4–7), so they are deep but not a
  flat blob; under 1 % of the frame is crushed unless it is a crowd silhouette.
- Highlights are protected and warm: under 0.5 % clipped, the brightest 1 % at 210–240, lights roll off
  into cream and orange with a glow instead of hard white.
- Edges are about a third as bright as the centre (strong vignette) and much softer than the centre (zoom
  or spin blur), so the performer sits in a lit tunnel. Keep the subject near the centre when cropping.
- Faces and fabric are crunchy: strong mid-frequency clarity and structure, crisp sharpening, fine grain
  kept. Skin follows the light (orange under warm light, cyan-grey under cold light); it is not corrected.

## Steps

1. Denoise first if the photo is ISO 3200+ (AI 30–45 or BM3D), but leave fine grain: this look adds grain
   back. Lens correction on; keep the wide-angle curvature unless the user dislikes it.
2. Tone: contrast +20..30, highlights -20..-30, whites 0, shadows +25..30, blacks -5, and a luma curve
   point {x: 0, y: 10} so the blacks keep their floor; exposure +0.3..0.4 or per photo until the
   performer reads and the median sits around 0.10–0.18. Never push brightness above +0.5.
3. Colour collapse with `hsl` (hue ±100 = ±60°): yellows {hue -50, saturation -10}, greens
   {hue 100, saturation -50}, aquas {hue 15, saturation 20}, blues {hue -50, saturation 15},
   purples {hue -80, saturation -40}, magentas {hue 60, saturation -10}, reds {hue 30, saturation -25},
   oranges {saturation 10, luminance 5}. Then saturation -10, vibrance +5, temperature +5..10. Red stage
   light must turn red-orange, not pure red, and only a small part of the frame may sit at full saturation.
   Check the preview: blue and purple beams must come out cyan-teal, white and amber light cream-orange.
4. Grading: `colorGrading` highlights {hue 35, saturation 25}, midtones {hue 25, saturation 8},
   shadows {hue 20, saturation 5}, balance +10. Shadows stay near neutral; the teal comes from the lights.
5. Detail: clarity +25..35, structure +15..25, sharpness +25..35, dehaze +5..15 to give haze body
   (lower it if haze turns grey), grain 8–15, size 20–30.
6. Light: glowAmount 15–25 and halationAmount 15–25 when lights are in the frame.
7. Edge: vignetteAmount -60..-65, midpoint 25, feather 60–75 (on a bright backdrop the vignette cannot reach
   the look; leave it). Zoom-burst edge in RapidRAW: motionBlurType "zoom", motionBlurAmount 10–15. Its
   centre is always the frame centre, so use it only when the face is in the central third; otherwise, and
   for a spin swirl, do it in PhotoCraft (the `stage-looks` skill of the Claude Code plugin).
8. Face: a face mask with clarity +10, exposure +0.1..0.2 only when the singer is lost; no skin smoothing.
9. Verify on the histogram: no more than 1 % pure white, darkest 1 % not at 0, the performer readable.

Do not use this look for black and white. Do not turn it into an HDR look: the shadows must stay dark.

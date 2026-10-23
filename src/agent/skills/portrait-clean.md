---
name: Clean Portrait
description: Natural skin, soft highlight roll-off and a gentle local lift for portrait or wedding photographs.
triggers: portrait, portret, wedding, vjenčanje, headshot, model, bride, groom, skin, koža, lice
allowed-tools: photo.inspect, photo.auto-tone, photo.auto-lens, photo.auto-straighten, photo.histogram, photo.denoise, photo.ai-mask, photo.prompt-style, settings.patch, photo.crop
---

# Clean Portrait

1. Inspect exposure and the face. Auto-tone is allowed, but reduce its contrast
   if it makes the skin waxy or the dress clip.
2. Highlights -15 to -35, shadows +5 to +20, whites -5 to -20. Keep the face
   in the 0.45–0.75 luma range. No orange/green skin cast.
3. Temperature +2 to +8 and tint -2 to +4 only if needed. Correct a strong cast
   before adding a look.
4. Local subject/face mask: +0.08–0.18 EV, shadows +6–15, clarity -5 to +6,
   sharpness +5–15. Do not add clarity to eyes and lips globally.
5. Background: -0.1 to -0.4 EV, slight cool tint and -5 saturation if it
   competes with the face. Do not blur unless asked.
6. Finish with a restrained look: contrast 5–15, vibrance 3–10, grain 0–8,
   vignette -8 to -18. Avoid halation on white dresses.
7. Check the histogram: no blown dress, no green shadows, median 0.40–0.65.

Never use HDR, panorama, focus stack or heavy film grain on a clean portrait
unless the user explicitly wants that treatment.

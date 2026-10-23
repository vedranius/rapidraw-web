---
name: High ISO Rescue
description: Recover a noisy high-ISO frame without destroying detail, then keep the colour believable.
triggers: denoise, odšumi, noise, šum, high iso, iso 6400, grain, zrno, clean up, očisti
allowed-tools: photo.inspect, photo.denoise, photo.auto-tone, photo.histogram, photo.ai-mask, settings.patch
---

# High ISO Rescue

1. Inspect EXIF ISO and the histogram. Do not denoise ISO 100–400 unless the
   user explicitly asks; it removes detail for no reason.
2. For ISO 1600–12800 use AI denoise 30–55. For extreme noise use 55–70 and
   accept a softer file rather than a plastic one.
3. After denoising, open the saved file. Add sharpness 8–20 and clarity 0–8
   sparingly. Raise luma noise reduction only if colour speckle remains.
4. Rebalance tone after denoise: shadows +5 to +20, highlights -10 to -25.
   Keep the median 0.30–0.60.
5. If colour noise remains, colorNoiseReduction 15–35. Do not desaturate the
   whole image to hide it.
6. Finish with a restrained grade. Grain is optional and should be low because
   the source already has grain.
7. Report that a new file was created; do not claim the original was changed.

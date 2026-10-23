---
name: Panorama
description: Stitch overlapping frames and finish the panorama without stretching the edges.
triggers: panorama, pano, panorama, stitch, spajanje, široki kadar, wide shot, 360
allowed-tools: photo.inspect, photo.panorama, photo.auto-tone, photo.auto-lens, photo.histogram, settings.patch, photo.crop, library.refresh
---

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

---
name: HDR Bracket
description: Merge a real exposure bracket, then produce a natural result without the flat HDR look.
triggers: hdr, bracket, bracketing, ekspozicije, tri exposure, merge, spajanje, blown sky, pregorelo nebo
allowed-tools: photo.inspect, photo.hdr, photo.auto-tone, photo.histogram, photo.ai-mask, settings.patch, photo.auto-straighten, photo.crop, library.refresh
---

# HDR Bracket

Only use this on two or more frames of the same scene at different exposures.
If the frames are not a bracket, do not merge them.

1. Keep the bracket in exposure order. Confirm identical framing/size.
2. Merge with `photo.hdr`. The result is saved next to the first frame.
3. Open the saved result and inspect the histogram. A merged file often needs
   less exposure than the darkest frame but more than the brightest.
4. Natural HDR: highlights -15 to -35, shadows +10 to +30, whites -5 to -20,
   blacks -5 to +10, contrast 5–15. Stop before halos appear at the horizon.
5. If the sky is still blown, add a sky mask at -0.3 to -0.6 EV and -8 to -20
   highlights. If the foreground is muddy, lift it locally instead of raising
   global shadows.
6. Do not add strong saturation, clarity or grain. The goal is a clean, wide
   tonal range that still looks photographic.
7. Verify median 0.35–0.60, highlight clipping under 1%, shadow clipping under
   2%. Report the saved file path.

Never merge a panorama or focus stack as HDR unless the user says those frames
are exposure brackets.

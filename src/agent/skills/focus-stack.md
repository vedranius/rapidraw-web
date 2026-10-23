---
name: Focus Stack
description: Merge a focus bracket into a sharp macro or product image, then clean up the result.
triggers: focus stack, focus stacking, fokus, stack, makro, macro, product, proizvod, dubina polja, depth of field
allowed-tools: photo.inspect, photo.focus-stack, photo.auto-tone, photo.histogram, photo.ai-mask, settings.patch, photo.crop, library.refresh
---

# Focus Stack

Use only on two or more frames with the same framing but different focus
distances.

1. Confirm identical dimensions and orientation.
2. Merge with `photo.focus-stack`; the saved TIFF is next to the first frame.
3. Inspect for focus halos, ghosted edges or a soft frame. If a frame is
   misaligned, the stack may need to be redone; do not hide it with clarity.
4. Finish gently: auto-tone, highlights -10 to -25, shadows +5 to +15,
   clarity 0–8, sharpness 5–12, saturation -2 to +5.
5. Do not apply grain or heavy halation to a macro/product image.
6. Verify the histogram and report the saved file path.

Never stack a hand-held burst with different compositions or an HDR bracket.

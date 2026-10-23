---
name: Documentary Noir
description: Black-and-white documentary or concert look with deep but readable blacks and controlled grain.
triggers: black and white, crno bijelo, monochrome, bw, noir, documentary, dokumentarno, tri-x, t-max
allowed-tools: photo.inspect, photo.auto-tone, photo.histogram, photo.prompt-style, settings.patch, photo.ai-mask
---

# Documentary Noir

1. Inspect the histogram and protect the highlights first. A black-and-white
   conversion cannot recover a blown face.
2. Use `photo.prompt-style` with a black-and-white documentary prompt. If the
   user named a film stock, include it (Tri-X 400, T-Max 400, Ilford HP5).
3. If hand-building: saturation -100, contrast 15–35, shadows -5 to +10,
   blacks -5 to +15, clarity 5–15.
4. Local subject mask +0.1 EV and shadows +5–12 if the face is dark.
5. Grain 12–30, size 20–40. Keep grain out of the deepest blacks.
6. Check that shadows still hold texture. A black frame with one white face is
   not documentary noir.
7. Do not add sepia or a colour LUT unless asked.

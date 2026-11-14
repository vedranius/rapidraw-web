---
name: Concert Best Of
description: Pick the best N photos of a concert or event folder, edit them consistently, denoise the high-ISO ones and flag them as picks.
triggers: best of, najbolj, odaberi, select the best, top 50, picks, picked, izbor, highlights, koncert, concert
allowed-tools: library.cull, library.flag, library.rate, library.tag, photo.inspect, photo.histogram, photo.auto-tone, photo.denoise, photo.prompt-style, photo.style-profile, settings.patch
---

# Concert Best Of

Use this when the photographer wants a selection from a whole shoot ("the best 50 from the concert"), edited
and marked, not one photo.

1. **Find the shoot.** List the folder (with AI clients: `rapidraw_list_images`, `recursive` if the shoot has
   subfolders). Confirm the folder and the count with the photographer if more than one folder could match.
2. **Rank, don't browse.** Score the whole set with content-aware culling (AI clients: `rapidraw_rank` with the
   folder and `top` = the requested number; in the app: `library.cull`). It drops near-duplicates of a burst
   (keeps the best frame) and soft frames, and ranks by composition, light, sharpness and subject. Only look
   at previews of borderline candidates (`rapidraw_preview`, `maxEdge` 768), never of every photo.
3. **Check the selection.** Prefer variety: different songs, musicians, wide and close shots. If the top list
   is dominated by one moment, swap a few for the next ranked frames of other scenes.
4. **Edit the picks as one set** (all paths in one command so the look matches):
   - `photo.auto-tone` on all picks first;
   - `photo.denoise` only where needed: ISO 3200 and above with `method: "ai"`, intensity about 35 at 3200,
     50 at 6400, 65 at 12800+; ISO 1600 at 20 to 25 only if the shadows were lifted; never on clean low-ISO
     files;
   - one coherent look: `photo.prompt-style` (e.g. "clean concert colour, protected stage highlights,
     natural skin") or a saved style with `photo.style-profile`;
   - fix outliers afterwards with `settings.patch` (exposure, highlights, whites) on single photos.
5. **Mark them.** Flag the picks with `library.flag` `pick` (AI clients: `rapidraw_set_library` with
   `flag: "pick"`), optionally a tag like the event name. Do not reject the rest unless asked.
6. **Verify.** Preview three or four picks (brightest, darkest, highest ISO) and correct with small patches.
   Report how many were analysed, picked, denoised, and anything that failed. Do not export unless asked.

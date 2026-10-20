# AI culling i AI Style (content-aware obrada)

Ovaj dokument opisuje AI sloj dodan u `rapidraw-web` fork: raspoznavanje sadržaja
fotografije i automatsku obradu prema tom sadržaju (culling + stilovi/LUT-ovi).

> Kratko: aplikacija **već** ima CLIP model koji tagira sadržaj svake slike
> (`src-tauri/src/tagging.rs`, tagovi se spremaju u `.rrdata` sidecar). Novi AI
> sloj se na to nadograđuje i **ne pokreće novu inferenciju** tijekom cullinga ili
> obrade — koristi postojeće tagove, pa je jednako brz.

---

## 1. Kako uključiti razumijevanje sadržaja

1. **Settings → Tagging → „AI Tagging"** uključi (prvi put skine CLIP model).
2. Otvori folder s fotografijama — background indexer prolazi kroz slike i u
   svaku `.rrdata` datoteku upisuje tagove (npr. `concert`, `stage lighting`,
   `musician`, `crowd`, `dramatic`).
3. Tek tada AI zna _što_ gleda. Bez ovoga AI sloj radi, ali nema signala.

Vokabular je proširen koncertnim pojmovima (`src-tauri/src/tagging_utils/candidates.rs`):
musician, band, guitarist, singer, drummer, stage, stage lighting, spotlight,
smoke machine, laser lights, mosh pit, headbanging, crowd surfing, festival crowd…

---

## 2. AI culling score (odabir najboljeg kadra)

Radi u postojećem **Cull** dijalogu (desni klik na selekciju → _Cull_).

- Klasična kvaliteta (oštrina / centriranost / ekspozicija / **boja**) spaja se sa
  **semantičkom ocjenom** iz CLIP tagova (npr. `portrait`/`face`/`musician` i
  `concert`/`stage` podižu ocjenu, `motion blur`/`noise` snižavaju).
- Težine klasičnog dijela: **oštrina 0.35, centriranost 0.30, ekspozicija 0.25,
  boja 0.10**. Ekspozicija više nije samo „kazna za clipping": mjeri se medijan
  svjetline (široki prihvatljivi raspon, da noćni/koncertni kadar ne bude kažnjen
  samo zato što je namjerno mračan) plus udio crnih i izbijeljenih piksela.
- **Boja** se mjeri kroz zasićenost i _colourfulness_ (Hasler–Süsstrunk), pa
  sivi/blijedi kadar dobije malo nižu ocjenu od kadra koji stvarno nosi boju.
- **Šum**: ISO ≥ 1600/3200/6400/12800 daje mali penal (0.05–0.18), jer visoki
  ISO jede detalj. U dijalogu se ispod `AI` ocjene prikazuje `E` (exposure
  quality), `C` (color quality) i ISO, da je odluka provjerljiva.
- Semantička ocjena vrednuje i **kompoziciju i svjetlo**: tagovi kao
  `rule of thirds`, `leading lines`, `framing`, `symmetry`, `reflection`,
  `depth of field`, `golden hour`, `soft light` daju mali pozitivan doprinos, pa
  „dobar kadar" i lijepo svjetlo blago podižu `aiScore` (ne samo oštrina).
- Rezultat je `aiScore`. **Najbolja fotka iz bursta bira se po `aiScore`**, ne
  samo po oštrini, a grupe su sortirane najbolje-prve.
- Ako slika nema tagova, `aiScore` se svodi na klasičnu kvalitetu (bez izobličenja).

Implementacija: `src-tauri/src/culling.rs`; UI: `src/components/modals/CullingModal.tsx`.

---

## 3. AI Style (stilovi, LUT-ovi, boje prema sadržaju)

Otvara se desnim klikom na selekciju → **AI Style** (ili u editoru → _Productivity_
→ _AI Style_). Ima tri kartice:

### Profiles

Popis stilova. Ugrađeni „žanrovski" stilovi dolaze s aplikacijom i automatski se
podudaraju po sadržaju:

| Profil                     | LUT (film emulacija) | Aktivira se na                                                          |
| -------------------------- | -------------------- | ----------------------------------------------------------------------- |
| Concert — Dark & Punchy    | K-Vision 500T        | metal/rock concert, guitarist, drummer, mosh pit, smoke machine…        |
| Concert — Warm Stage       | K-Gold 200           | acoustic/classical concert, saxophone, piano, violin, vocalist…         |
| Concert — Neon / EDM       | K-Vision 500T        | dj, club/arena concert, laser lights, light show, neon…                 |
| Concert — Monochrome       | —                    | monochrome, black and white, silhouette, low-key, stage…                |
| Festival — Bright & Vivid  | K-Ektar 100          | festival, festival crowd, confetti, pyrotechnics…                       |
| Portrait — Natural & Soft  | K-Portra 400         | portrait, candid, face, smile, person, couple, family…                  |
| Wedding — Airy & Bright    | F-Pro 400H           | wedding, couple, celebration, flowers, cake, dancing…                   |
| Golden Hour — Warm Glow    | K-Gold 200           | golden hour, sunset, sunrise, dusk, sun, backlighting…                  |
| Landscape — Vivid Nature   | K-Ektar 100          | landscape, mountains, forest, lake, waterfall, sky, coast…              |
| Night — Neon & Moody       | K-Vision 500T        | night, neon, cityscape, stars, long exposure, moon…                     |
| Cinematic — Teal & Orange  | K-Vision 250D        | city, street, car, architecture, night, neon…                           |
| Sports — Crisp Action      | K-Ektar 100          | sports, running, cycling, swimming, stadium, arena…                     |
| Wildlife — Detail & Color  | K-Ektar 100          | wildlife, animal, bird, eagle, tiger, deer, fox…                        |
| Street — High-Contrast B&W | —                    | street, urban, architecture, monochrome, candid…                        |
| Food — Warm & Appetizing   | K-Gold 200           | food, meal, dish, pizza, sushi, coffee, wine…                           |

**Kako su stilovi napravljeni.** Svaki stil je kombinacija ugrađene filmske LUT
emulacije (30–55 % jačine) i pažljivo odabranog gradinga: HSL mixer (kože,
zelenilo, neon), tro-smjerno color grading (shadows/midtones/highlights), point
krivulja (S-krivulja ili filmic fade) te vignette/grain/glow gdje ima smisla.
**Nijedan stil ne ubacuje fiksnu ekspoziciju** — fotografije su već eksponirane, a
stari profil s `+6 EV` je bio glavni krivac za „sve je preeksponirano".

Automatski prolaz dodatno prilagođava ton po slici na osnovu tagova: `low-key` /
`dark` / `night` lagano diže sjene, `high-key` / `bright` čuva highlighte, a
`backlighting` / `silhouette` dobiva lift sjena. Zato ista serija ne izgleda kao
15 identičnih kopija.

Kod podudaranja, generički tagovi (`concert`, `stage`, `musician`, `person`…)
vrijede **upola** manje od specifičnih (`saxophone`, `mosh pit`, `dj`, `neon`…).
Tako koncert sa saksofonom završi na _Warm Stage_, a ne na _Dark & Punchy_.

Odabereš profil, podesiš **Intensity** (0–100 %) i klikneš _Apply to N images_.
Primjena ide kroz postojeći `apply_adjustments_to_paths` (merge u `.rrdata` +
osvježavanje thumbnaila). Intenzitet skalira „look" vrijednosti, a krivulje
blenda prema identiteti.

### Matches

Prikazuje koja je fotografija automatski prepoznata i **kojem** stilu pripada
(score + tagovi koji su pogodili). Tu je i **Match threshold** te gumb
**Auto-apply AI** koji svakoj slici primijeni najbolje podudaran stil.
Ako uključiš _„Use selected profile for unmatched images"_, slike bez
podudaranja dobiju odabrani profil kao fallback.

### Learn

Ovo je dio koji radi ono što si opisao (npr. „Iron Maiden look"):

1. Odabereš fotografije koje je netko **već uredio** (idealno isti bend/event).
2. Izračuna se **prosjek** njihovih `.rrdata` adjustmenta (kontrast, HSL, color
   grading, krivulje, clarity/grain…) — i, ako je korišten, **LUT** koji se
   najčešće pojavljuje. Ekspozicija se **ne** usrednjava jer je per-foto stvar
   (renderer već radi baseline exposure).
3. To postane **StyleProfile** koji se spremi i kasnije primjenjuje jednim klikom.

Dobiveni profil dobiva `detectTags` iz najčešćih tagova izvornih slika, pa se
automatski veže na sličan sadržaj.

### Per-image adaptacija (svjetlina i boje)

Stil se **ne** primjenjuje kao fiksni blob na sve slike. Za svaku fotografiju se
analizira njezin keširani 480 px preview (`photo_analysis.rs`) i izmjeri:

- medijan svjetline, 5./95. percentil, kontrast (std. devijacija),
- udio crnih i izbijeljenih piksela,
- prosječna zasićenost i _colourfulness_,
- cast (toplo/hladno, zeleno/magenta) i omjer kutova prema centru (vinjeta),
- ISO iz sidecara (šum).

Iz tih brojeva `adapt_look_to_photo()` prije primjene prilagodi look:

- **Ekspozicija**: look ima *raspon* prihvatljivog medijana (koncert 0.085–0.55,
  portret 0.15–0.70, vjenčanje 0.20–0.75). Unutar raspona se ekspozicija **ne
  dira**; samo gotovo crni kadrovi (< floor) dobiju lift do +0.6 EV, a pregoreni
  (> ceiling) korekciju do −0.5 EV. Ako slika već ima izbijeljene highlighte
  (>1 %), lift se blokira.
- **Highlighti/sjene**: koncertni/„night" lookovi čuvaju izbijena stage svjetla
  i ne dižu zdrobljene sjene (trigger je clip > 3 % / 6 %), dok portretni i
  neutralni lookovi normalno recovering (clip > 0.5 % / 1 %).
- **Kontrast**: blago gore na mliječnim/ravnim kadrovima, blago dolje na već
  kontrastnim.
- **Zasićenost**: na već neon-zasićenoj sceni pozitivna saturacija/vibrance se
  smanjuju (do ~45 %), da boje ne „izgore".
- **LUT**: blend se smanjuje na 80–90 % kad slika već nosi puno boje.
- **Šum**: na ISO ≥ 1600 smanjuje se clarity/structure/sharpness i dodaje
  luma/color noise reduction.
- **Vinjeta**: ne udvostručuje se ako su kutovi već tamni.
- **White balance**: samo za neutralne/portretne stilove i samo kod izraženog
  casta (nikad za neon/stage-light scene ni tople lookove), s malim capom.

Rezultat: ista „Iron Maiden" ili filmska receptura izgleda različito na
nedovoljno eksponiranoj, preeksponiranoj i već zasićenoj fotografiji — što je i
bio cilj. Analiza se kešira po putanji + mtime; ako thumbnail još ne postoji,
look se primijeni s tvorničkim vrijednostima.

**Kalibracija na stvarnim fotkama.** Rasponi nisu izmišljeni: uspoređeno je 72
izvezenih (uređenih) koncertnih fotografija s njihovim izvornim previewima.
Rezultat: medijan svjetline se u prosjeku **ne mijenja** (EV 0.00), zasićenost i
colourfulness također ostaju gotovo identični, a fotograf zadržava izbijena
stage svjetla i blago zdrobljene sjene. Zato adaptacija čuva izgled umjesto da
sve gura u srednje sive tonove. Testovi (`real_library_adaptation`,
`real_library_edit_targets`, `real_culling_scores`) su `#[ignore]` i vrte se
lokalno:

```bash
cd src-tauri
cargo test --lib real_library_adaptation -- --ignored --nocapture
cargo test --lib real_library_edit_targets -- --ignored --nocapture
cargo test --lib real_culling_scores -- --ignored --nocapture
```

---

## 4. Bend-specifičan look (npr. Iron Maiden) — točan radni tok

CLIP sam po sebi **ne prepoznaje ime benda** (to je _named entity recognition_,
ne opis scene). Zato je bend-identitet riješen kroz označavanje + učenje, što je
ujedno i najpouzdanije:

1. Odaberi **cijeli event** (npr. svih 2000 fotki s Iron Maiden koncerta).
2. **AI Style → Learn →** upiši subject „Iron Maiden" → klikni
   _Assign artist_ (doda tag `user:artist:iron-maiden` na sve odabrane slike).
3. Na istom tabu upiši ime profila („Iron Maiden — dark metal") i klikni
   _Learn from N images_ (uči iz tvojih već uređenih fotki).
4. Spremi profil.
5. Na svakom sljedećem koncertu: odaberi fotke → **AI Style → Matches →
   Auto-apply AI**. Slike označene kao Iron Maiden dobiju **točno taj** profil
   (hard-match 1.0), a ostale automatski padaju na žanrovske stilove.

Time AI „zna" i sadržaj (žanr/scenu preko CLIP-a) i specifičan bend (preko
tvoje reference + taga), te obrađuje boje/LUT/krivulje u skladu s tim.

---

## 5. Arhitektura

| Sloj                                   | Datoteka                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| Semantičko bodovanje cullinga          | `src-tauri/src/culling.rs`                                   |
| Koncertni vokabular                    | `src-tauri/src/tagging_utils/candidates.rs`                  |
| Style profili, učenje, match, primjena | `src-tauri/src/style_profile.rs`                             |
| Registracija naredbi                   | `src-tauri/src/lib.rs`                                       |
| UI                                     | `src/components/modals/AIStyleModal.tsx`, `CullingModal.tsx` |
| Tipovi / Invokes                       | `src/components/ui/AppProperties.tsx`                        |
| Modal state                            | `src/store/useUIStore.ts`                                    |
| Kontekstni izbornici                   | `src/hooks/useAppContextMenus.ts`                            |

Tauri naredbe: `list_style_profiles`, `save_style_profile`, `delete_style_profile`,
`derive_style_profile_from_paths`, `assign_artist_to_paths`,
`match_style_profiles_for_paths`, `apply_style_profile_to_paths`,
`auto_style_paths_with_ai`.

Korisnički profili se spremaju u `<app data>/style_profiles/style_profiles.json`.

---

## 6. Ograničenja (iskreno)

- **Automatsko prepoznavanje imena benda ne postoji** offline bez dodatne baze
  logotipa/OCR-a ili VLM-a. Rješenje je označavanje eventa + učenje iz tvojih
  referenci (vidi §4).
- **„Najbolji kadar"** je i dalje djelomično subjektivan (izraz lica, trenutak).
  AI daje jak _shortlist_ i bira najboljeg u burstu, ali ne zamjenjuje u potpunosti
  tvoju procjenu.
- Modeli (CLIP/SAM) traže prethodno preuzimanje i imaju svoje licence — provjeri
  prije komercijalne distribucije. Fork je AGPL-3.0.

## 7. Mogući sljedeći koraci

- **VLM sloj** (npr. Florence-2 / Qwen-VL preko postojećeg `ai_connector`
  ComfyUI/cloud hooka) za opis scene i prijedlog edita.
- **OCR logotipa** + baza bendova za automatski prijedlog imena benda.
- **Detekcija lica/očiju** za precizniji culling portreta.
- Automatska obrada već pri **importu** (postavka „auto-edit on import").

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
3. Tek tada AI zna *što* gleda. Bez ovoga AI sloj radi, ali nema signala.

Vokabular je proširen koncertnim pojmovima (`src-tauri/src/tagging_utils/candidates.rs`):
musician, band, guitarist, singer, drummer, stage, stage lighting, spotlight,
smoke machine, laser lights, mosh pit, headbanging, crowd surfing, festival crowd…

---

## 2. AI culling score (odabir najboljeg kadra)

Radi u postojećem **Cull** dijalogu (desni klik na selekciju → *Cull*).

- Klasična kvaliteta (oštrina / centriranost / ekspozicija) spaja se sa
  **semantičkom ocjenom** iz CLIP tagova (npr. `portrait`/`face`/`musician` i
  `concert`/`stage` podižu ocjenu, `motion blur`/`noise` snižavaju).
- Rezultat je `aiScore`. **Najbolja fotka iz bursta bira se po `aiScore`**, ne
  samo po oštrini, a grupe su sortirane najbolje-prve.
- Ako slika nema tagova, `aiScore` se svodi na klasičnu kvalitetu (bez izobličenja).

Implementacija: `src-tauri/src/culling.rs`; UI: `src/components/modals/CullingModal.tsx`.

---

## 3. AI Style (stilovi, LUT-ovi, boje prema sadržaju)

Otvara se desnim klikom na selekciju → **AI Style** (ili u editoru → *Productivity*
→ *AI Style*). Ima tri kartice:

### Profiles
Popis stilova. Ugrađeni „žanrovski" stilovi dolaze s aplikacijom i automatski se
podudaraju po sadržaju:

| Profil | Aktivira se na |
|---|---|
| Concert — Dark & Punchy | concert, live music, metal/rock concert, stage, guitarist, headbanging… |
| Concert — Warm Stage | acoustic concert, singer, saxophone, piano, audience… |
| Festival — Bright & Vivid | festival, festival crowd, neon, light show, confetti… |

Odabereš profil, podesiš **Intensity** (0–100 %) i klikneš *Apply to N images*.
Primjena ide kroz postojeći `apply_adjustments_to_paths` (merge u `.rrdata` +
osvježavanje thumbnaila). Intenzitet skalira „look" vrijednosti, a krivulje
blenda prema identiteti.

### Matches
Prikazuje koja je fotografija automatski prepoznata i **kojem** stilu pripada
(score + tagovi koji su pogodili). Tu je i **Match threshold** te gumb
**Auto-apply AI** koji svakoj slici primijeni najbolje podudaran stil.
Ako uključiš *„Use selected profile for unmatched images"*, slike bez
podudaranja dobiju odabrani profil kao fallback.

### Learn
Ovo je dio koji radi ono što si opisao (npr. „Iron Maiden look"):

1. Odabereš fotografije koje je netko **već uredio** (idealno isti bend/event).
2. Uporkovi se **prosjek** njihovih `.rrdata` adjustmenta (ekspozicija, kontrast,
   HSL, color grading, krivulje) — i, ako je korišten, **LUT** koji se najčešće
   pojavljuje.
3. To postane **StyleProfile** koji se spremi i kasnije primjenjuje jednim klikom.

Dobiveni profil dobiva `detectTags` iz najčešćih tagova izvornih slika, pa se
automatski veže na sličan sadržaj.

---

## 4. Bend-specifičan look (npr. Iron Maiden) — točan radni tok

CLIP sam po sebi **ne prepoznaje ime benda** (to je *named entity recognition*,
ne opis scene). Zato je bend-identitet riješen kroz označavanje + učenje, što je
ujedno i najpouzdanije:

1. Odaberi **cijeli event** (npr. svih 2000 fotki s Iron Maiden koncerta).
2. **AI Style → Learn →** upiši subject „Iron Maiden" → klikni
   *Assign artist* (doda tag `user:artist:iron-maiden` na sve odabrane slike).
3. Na istom tabu upiši ime profila („Iron Maiden — dark metal") i klikni
   *Learn from N images* (uči iz tvojih već uređenih fotki).
4. Spremi profil.
5. Na svakom sljedećem koncertu: odaberi fotke → **AI Style → Matches →
   Auto-apply AI**. Slike označene kao Iron Maiden dobiju **točno taj** profil
   (hard-match 1.0), a ostale automatski padaju na žanrovske stilove.

Time AI „zna" i sadržaj (žanr/scenu preko CLIP-a) i specifičan bend (preko
tvoje reference + taga), te obrađuje boje/LUT/krivulje u skladu s tim.

---

## 5. Arhitektura

| Sloj | Datoteka |
|---|---|
| Semantičko bodovanje cullinga | `src-tauri/src/culling.rs` |
| Koncertni vokabular | `src-tauri/src/tagging_utils/candidates.rs` |
| Style profili, učenje, match, primjena | `src-tauri/src/style_profile.rs` |
| Registracija naredbi | `src-tauri/src/lib.rs` |
| UI | `src/components/modals/AIStyleModal.tsx`, `CullingModal.tsx` |
| Tipovi / Invokes | `src/components/ui/AppProperties.tsx` |
| Modal state | `src/store/useUIStore.ts` |
| Kontekstni izbornici | `src/hooks/useAppContextMenus.ts` |

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
  AI daje jak *shortlist* i bira najboljeg u burstu, ali ne zamjenjuje u potpunosti
  tvoju procjenu.
- Modeli (CLIP/SAM) traže prethodno preuzimanje i imaju svoje licence — provjeri
  prije komercijalne distribucije. Fork je AGPL-3.0.

## 7. Mogući sljedeći koraci

- **VLM sloj** (npr. Florence-2 / Qwen-VL preko postojećeg `ai_connector`
  ComfyUI/cloud hooka) za opis scene i prijedlog edita.
- **OCR logotipa** + baza bendova za automatski prijedlog imena benda.
- **Detekcija lica/očiju** za precizniji culling portreta.
- Automatska obrada već pri **importu** (postavka „auto-edit on import").

# RapidRAW AI Editor — naredbe, skillovi i sve postavke

Ovaj dokument opisuje novi sloj u `rapidraw-web` forku: **AI Editor** koji
prirodnim jezikom upravlja cijelim RapidRAW-om. Za razliku od „AI Style" kartice
koja bira gotov izgled, AI Editor može pokrenuti **bilo koju postavku ili
operaciju**: ton, krivulje, HSL, color grading, maske, AI maske, RAW denoise,
HDR, panoramu, focus stacking, krop, lens correction, LUT, grain, halation, AI
depth blur, relight, fog, metapodatke, culling i izvoz.

> Ključna podjela: **model samo planira**, lokalni RapidRAW izvršava. Model ne
> dobiva piksele i ne može izmisliti naredbu. Svaki korak mora koristiti točan
> ID iz kataloga; nepoznati ID-jevi se odbijaju i prikazuju korisniku.

---

## 1. Gdje se nalazi

- Desni klik na fotografiju → **Productivity → AI Editor (any command)**
- Desni klik na selekciju u biblioteci → **Productivity → AI Editor**
- Gumb **štapića** u zaglavlju desnog adjustment panela
- AI Editor ima četiri kartice: **AI Editor**, **Skills**, **Commands** i
  **AI provider**

AI Editor radi nad trenutnom selekcijom. Ako je odabrana jedna fotografija,
naredbe se odnose na nju; ako je odabrano više, batch naredbe (`settings.patch`,
auto-tone, auto-lens, denoise, style, export…) rade na cijeloj selekciji.
Krop, AI maske i pojedinačne lokalne korekcije rade na aktivnoj fotografiji.

---

## 2. Kako izgleda jedan ciklus

1. Upišeš npr. `Odšumi ISO 6400, zaštiti svjetla, podigni pjevača +0.2 EV i daj
topli koncertni look bez plastike.`
2. AI Editor pošalje modelu: tvoj tekst, odabranu fotografiju, EXIF, trenutne
   adjustmente, izmjereni histogram i **cijeli katalog naredbi**.
3. Model vrati JSON plan, npr. `photo.inspect` → `photo.denoise` →
   `photo.auto-tone` → `photo.ai-mask` → `photo.prompt-style`.
4. Prije izvršenja RapidRAW spremi snapshot sidecara. Plan se izvršava korak po
   korak, s vidljivim statusom, trajanjem i porukom svakog koraka.
5. Ako korak padne, plan se zaustavlja i greška je eksplicitna. Nema tihog
   nastavljanja na pogrešnoj fotografiji.
6. Ako plan sadrži rizičan korak (`library.export`, `settings.reset` ili
   `app.setting`), auto-run se zaustavlja i traži da ga ručno odobriš gumbom
   **Run**. Tako prompt injection iz EXIF-a ili naziva datoteke ne može sam
   pokrenuti izvoz ili reset.
7. **Undo plan** vraća sidecare na stanje prije plana. Datoteke koje su nastale
   operacijama (denoise/HDR/panorama/stack/export) ostaju na disku i to je
   jasno napisano u UI-u.

Nakon denoisea, HDR-a, panorame, focus stackinga ili negativa, sljedeći koraci
automatski rade na **novonastalom rezultatu**, ne na izvornim kadrovima. Ako
model ponovno navede izvorne putanje, izvršni sloj ih preusmjeri na rezultat.
Isto vrijedi i za `photo.select`: nakon ručnog odabira fotografije sljedeći
koraci rade na toj fotografiji, ne na staroj selekciji.

---

## 3. Katalog naredbi

Potpuni popis s parametrima je u kartici **Commands** i u
`src/agent/catalog.ts`. Kategorije:

### Inspekcija

- `photo.inspect` — putanja, dimenzije, EXIF, trenutni adjustmenti, maske,
  histogram
- `photo.select` — otvori točno zadanu fotografiju i postavi je kao radni target
- `photo.histogram` — medijan, 5./95. percentil, clipping, zasićenje i upozorenja

### Ton, boja i detalji

- `settings.patch` — **univerzalna** naredba: merge bilo kojeg skupa adjustment
  ključeva, uključujući `curves`, `hsl`, `colorGrading`, `masks`, `lens*`,
  `transform*`, `fog*`, `relight*`, `lensBlur*`
- `settings.set` — jedna vrijednost po dotted putanji, npr.
  `hsl.reds.saturation`
- `settings.reset` — reset cijelog uređivanja ili jedne sekcije
- `photo.auto-tone` — sadržajno automatsko izlaganje
- `photo.style-profile` — spremljeni RapidRAW stil po imenu/ID-u
- `photo.prompt-style` — look iz opisa, s osam varijanti i histogram guardom
- `photo.lut` — učitanje `.cube` LUT-a s diska
- `photo.preset` — spremljeni preset
- `photo.copy-settings` — kopiranje postavki na drugu selekciju

Svi ključevi i fotografski rasponi su u referenci na dnu kartice **Commands**.
`settings.patch` odbija nepoznate ključeve (npr. `texture`), umjesto da ih tiho
zanemari; kod `texture` poruka upućuje na ispravni `structure`.

### Geometrija i objektiv

- `photo.auto-lens` — lensfun profil (distorzija, TCA, vinjeta)
- `photo.auto-straighten` — horizont i vertikale
- `photo.crop` — omjer (`1:1`, `4:5`, `3:2`, `16:9`…), rotacija, orijentacija
- `photo.flip` — horizontalno/vertikalno zrcaljenje

### Maske i AI svjetlo

- `photo.ai-mask` — subject, sky, foreground ili depth maska + lokalne korekcije
- `photo.mask-adjust` — izmjena postojeće maske po imenu/ID-u
- `photo.ai-lens-blur` — depth-based blur
- `photo.ai-relight` — relight s normal mapom
- `photo.ai-fog` — depth fog

### RAW operacije

- `photo.denoise` — AI/BM3D/RAW9 denoise, sprema novi TIFF/PNG
- `photo.hdr` — spajanje exposure bracketa
- `photo.panorama` — spajanje preklapajućih kadrova
- `photo.focus-stack` — spajanje focus bracketa
- `photo.negative` — skenirani negativ u pozitiv

### Biblioteka i izvoz

- `library.rate`, `library.flag`, `library.color`, `library.tag`, `library.exif`
- `library.cull` — sadržajni culling; otvara postojeći pregledni dijalog i **ne**
  primjenjuje odbačene bez odluke fotografa
- `library.export` — JPEG/PNG/TIFF, kvaliteta, long edge, apsolutna izlazna mapa ili `originalFolder` (pored izvora)
- `library.refresh`
- `app.setting` — bilo koja persisted `AppSettings` vrijednost
- `history.undo`, `history.redo`

`library.export`, `settings.reset` i `app.setting` su označeni kao rizični u
planu. AI ih ne poziva spontano; samo na eksplicitan zahtjev. Export čeka
stvarni `export-complete`/`export-error` događaj i kreira odredišnu mapu prije
poziva, pa „Completed" znači da je datoteka doista zapisana.

Scope guard: kod isključivo izvoznih, metadata ili culling naredbi uklanja
dodatne korake koje je model sam dodao (npr. auto-tone ili 1:1 krop uz
„izvezi JPEG") i to navodi u sažetku plana. Ako tražiš i obradu, npr. „izvezi
i daj topli look", guard ne uklanja traženu obradu.

---

## 4. Skillovi

Skill je Markdown recept s YAML frontmatterom:

```markdown
---
name: Concert Hero
description: Concert photograph with protected highlights and warm stage light.
triggers: concert, koncert, festival, stage, bina
allowed-tools: photo.inspect, photo.auto-tone, photo.histogram, photo.denoise,
  photo.ai-mask, photo.prompt-style, settings.patch
---

# Concert Hero

1. Inspect the histogram.
2. Denoise high-ISO RAW before grading.
3. ...
```

Ugrađeni skillovi (`src/agent/skills/`):

| Skill            | Namjena                                          |
| ---------------- | ------------------------------------------------ |
| Concert Hero     | koncert/festival, zaštićena svjetla, topli stage |
| Clean Portrait   | prirodna koža, mekana svjetla                    |
| HDR Bracket      | prirodan HDR bez haloa                           |
| Panorama         | šavovi, horizont, završna obrada                 |
| Focus Stack      | makro/proizvod, fokus kroz cijeli kadar          |
| High ISO Rescue  | denoise bez plastike                             |
| Documentary Noir | crno-bijelo s čitljivim sjenama                  |
| Editorial Colour | magazinski color grade                           |
| Social Export    | krop i izvoz za mreže                            |
| Cull Burst       | sadržajna selekcija serije                       |

Kartica **Skills** omogućuje:

- odabir skilla za sljedeću naredbu (chip se vidi uz histogram)
- **New skill** — vlastiti recept, triggers i allowed tools
- **Import SKILL.md** — uvoz Markdown datoteke s frontmatterom
- brisanje vlastitih skillova

Vlastiti skillovi se spremaju lokalno u `localStorage`
(`rapidraw.editAgent.customSkills.v1`) i ne napuštaju računalo. Skill je
smjernica modelu i lokalnom planeru; nije proizvoljni kod i ne može zaobići
katalog naredbi.

---

## 5. AI provider

Podržana su tri načina:

1. **Ollama (lokalno)** — `http://127.0.0.1:11434`, preporučeno
   `qwen2.5-coder:7b`; model se drži topao 15 minuta.
2. **OpenAI-compatible** — bilo koji `/chat/completions` endpoint: OpenAI,
   OpenRouter, LM Studio, vLLM, OpenCode gateway i slično.
3. **Anthropic Messages API (Claude)**.

Konfiguracija se sprema u `settings.json` (`promptAi`) i dijeli se s AI Style
karticom. API ključ je opcionalan za lokalne OpenAI-compatible servere.

**Važno:** AI provider je samo planer. Render, LUT, maske, histogram guard i
sve pixel operacije ostaju lokalne. Zato isti plan daje isti rezultat bez obzira
na provider.

Ako provider nije dostupan ili poziv padne, AI Editor to **eksplicitno prikaže**
u razgovoru i koristi deterministički lokalni planer. Lokalni planer ne
pretvara se da je AI; njegov plan je označen kao `local plan`. Lokalni fallback
koristi puni recept samo za skill koji si eksplicitno odabrao; inače izvršava
samo konkretne naredbe iz teksta (npr. denoise, krop, export), bez automatskog
„uljepšavanja" cijele fotografije.

---

## 6. Sigurnost i undo

- Snapshot sidecara prije plana (`snapshot_sidecars`)
- Undo plan (`restore_sidecars`) vraća sve editirane sidecare
- Generirane datoteke se ne brišu automatski
- `settings.patch` validira ključeve
- Plan prikazuje rizične korake
- Culling ne primjenjuje odluke sam
- Izvoz traži apsolutnu mapu ili eksplicitni `originalFolder`
- AI ne može izvršiti shell naredbu ni proizvoljni kod; može birati samo iz
  allow-liste `AGENT_TOOL_IDS`
- EXIF, nazivi datoteka i skill tekst tretiraju se kao podaci, ne kao upute

---

## 7. Testiranje i razvoj

```bash
cd src-tauri && cargo test --lib
cd src-tauri && cargo fmt --check
npm run typecheck
npm run build
RR_PLAIN=1 ./rrweb/build.sh
systemctl --user restart rapidraw-web
```

Ključne datoteke:

- `src-tauri/src/edit_agent.rs` — planner command, validacija JSON plana
- `src-tauri/src/prompt_ai.rs` — `complete_json` za Ollama/OpenAI/Claude
- `src/agent/catalog.ts` — katalog naredbi i referenca svih adjustment ključeva
- `src/agent/executor.ts` — izvršavanje, merge, validacija, file redirection
- `src/agent/planner.ts` — AI planer i deterministički lokalni fallback
- `src/agent/skills.ts` — loader/parser skillova
- `src/agent/skills/*.md` — ugrađeni recepti
- `src/components/modals/EditAgentModal.tsx` — UI, plan preview, log, undo

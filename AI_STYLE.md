# AI culling i AI Style (content-aware obrada)

Ovaj dokument opisuje AI sloj dodan u `rapidraw-web` fork: raspoznavanje sadržaja
fotografije i automatsku obradu prema tom sadržaju (culling + stilovi/LUT-ovi).

> Kratko: aplikacija **već** ima CLIP model koji tagira sadržaj svake slike
> (`src-tauri/src/tagging.rs`, tagovi se spremaju u `.rrdata` sidecar). Novi AI
> sloj se na to nadograđuje i **ne pokreće novu CLIP inferenciju** tijekom
> cullinga ili obrade — koristi postojeće tagove, pa je jednako brz. Jedini
> opcionalni LLM poziv je tumačenje teksta u kartici **Describe** (lokalni
> Ollama); on ne dira tagove, culling ni render, samo pripremi fotografski brief
> za lokalni colour engine.

---

## 1. Kako uključiti razumijevanje sadržaja

1. **Settings → Tagging → „AI Tagging"** uključi (prvi put skine CLIP model).
   Ako je folder već otvoren, indeksiranje tog foldera kreće odmah; inače kreće
   pri sljedećem otvaranju foldera.
2. Background indexer prolazi kroz slike i u svaku `.rrdata` datoteku upisuje
   tagove (npr. `concert`, `stage lighting`, `musician`, `crowd`, `dramatic`).
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
  ISO jede detalj. U dijalogu se ispod `AI` ocjene prikazuje `Q` (quality),
  `S` (semantic/content), `E` (exposure quality), `C` (color quality) i ISO;
  hover na taj redak otvara puni raspis (sharpness, centering, exposure, colour,
  quality, content), da je odluka provjerljiva.
- Semantička ocjena vrednuje i **kompoziciju i svjetlo**: tagovi kao
  `rule of thirds`, `leading lines`, `framing`, `symmetry`, `reflection`,
  `depth of field`, `golden hour`, `soft light` daju mali pozitivan doprinos, pa
  „dobar kadar" i lijepo svjetlo blago podižu `aiScore` (ne samo oštrina).
- Rezultat je `aiScore`. **Najbolja fotka iz bursta bira se po `aiScore`**, ne
  samo po oštrini, a grupe su sortirane najbolje-prve.
- Ako slika nema tagova, `aiScore` se svodi na klasičnu kvalitetu (bez izobličenja).
- **Style keepers**: gumb u podnožju dijaloga primijeni odabranu akciju na
  odbačene (reject / rating / delete) i zatim otvori **AI Style** samo s
  preživjelima. Time je cijeli tok „pregledaj burst → zadrži najbolje →
  primijeni adaptirani look" jedan klik, bez ručnog ponovnog selektiranja.

Implementacija: `src-tauri/src/culling.rs`; UI: `src/components/modals/CullingModal.tsx`.

---

## 3. AI Style (stilovi, LUT-ovi, boje prema sadržaju)

Otvara se desnim klikom na selekciju → **AI Style** (ili u editoru → _Productivity_
→ _AI Style_). Ima četiri kartice:

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
blenda prema identiteti. Na **0 %** se ne piše nijedan ključ — fotografija ostaje
točno kakva je bila (inače bi nulirani tonalni ključevi pregazili postojeći
sidecar).

Iznad popisa stilova je **živi preview odabranog profila** na prvoj odabranoj
fotografiji (isti GPU render + per-image adaptacija kao kod primjene). Gumb
**Before** držiš da vidiš bazu bez looka; preview se ponovno renderira kad
odabereš drugi profil ili promijeniš Intensity. Tako ugrađeni i naučeni stil
možeš prosuditi prije nego što ga primijeniš na cijelu selekciju.

Nakon primjene toast sadrži **Undo**: sidecari se prije pisanja snime u memoriju
(`snapshot_sidecars`), a Undo ih vraća (`restore_sidecars`) — uključujući brisanje
sidecara koji prije primjene nije postojao. Radi za Profile, Describe i
Auto-apply, pa možeš slobodno isprobavati lookove. Batch apply sada **čeka** da
se svi sidecari doista upišu i da se thumbnaili ponovno iscrtaju prije nego što
prikaže toast, pa Undo ne može biti pregazen ni upisom ni zaostalim renderom
koji je još čitao look. Undo zatim ponovno generira thumbnaile vraćenih slika,
tako da knjižnica odmah pokaže staro stanje umjesto zadnjeg looka. Na **0 %**
intenziteta Apply uopće ne zapisuje ništa (frontend prikaže poruku „Intensity is
0 — nothing to apply.").

### Matches

Prikazuje koja je fotografija automatski prepoznata i **kojem** stilu pripada
(score + tagovi koji su pogodili). Tu je i **Match threshold** te gumb
**Auto-apply AI** koji svakoj slici primijeni najbolje podudaran stil.
Ako uključiš _„Use selected profile for unmatched images"_, slike bez
podudaranja dobiju odabrani profil kao fallback.

Kad se modal otvori **s odabranim fotografijama**, prvo se prikaže ova kartica
(bez selekcije otvara se _Profiles_), jer je to najbrži put: vidiš što je AI
prepoznao i možeš odmah primijeniti. Iz culling dijaloga (gumb **Style keepers**)
isti tok dobiva samo preživjele fotografije, pa nema ručnog ponovnog selektiranja.

**Auto-apply** ide kroz isti `build_look_overlay` kao pojedinačna primjena, pa
neuređene fotografije dobiju auto baseline i kompenzaciju, a uređene zadržavaju
svoj razvoj. (Prije ovoga auto-pass je zaobilazio baseline i neuređene slike su
ostajale pre tamne.)

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

### Describe (opišeš look → dobiješ 4 varijante)

Kartica **Describe** pretvara slobodan opis u gotove stilove. Napišeš npr.
_„moody teal and orange concert look, soft highlights, subtle grain"_ ili
_„mračni koncert, tirkizno i narančasto, zrnato"_ i klikneš **Generate 4 looks**.
Ispod polja su i **primjeri** (uključujući hrvatski); klik ih upiše u polje pa
možeš odmah doraditi opis.

Tu je i **Quick ingredients** ploča: čipovi za subjekt, mood, svjetlo i filmski
stock jednim klikom dodaju točan engleski izraz koji interpreter razumije, a
drugi klik ga uklanja. **Surprise me** odabere jednu od kuriranih, međusobno
usklađenih kombinacija i odmah generira četiri varijante. Zadnjih šest opisa
pamti se lokalno (**Recent prompts**), pa se možeš vraćati na njih.

Generator ima **dva sloja**:

1. **AI interpret** (opcionalno): lokalni Ollama model pročita cijeli opis i
   pretvori ga u kratak fotografski brief — npr. _„1950s, glam rock, concert,
   portrait"_. To je pravi jezični sloj: AI povezuje „Freddy Mercury / Queen" s
   glam rockom, dekadu s erom i slične sinonime koje konačni rječnik ne mora
   znati napamet.
2. **Colour engine** (lokalno, deterministički): iz tog briefa gradi četiri
   varijante, bira LUT, HSL i split tone te sve ostavlja kao normalne, editabilne
   slidere. AI **ne renderira piksele**; zato je preview brz i ponovljiv, a look
   možeš odmah doraditi u _Edit_.

AI je uključen kad je Ollama dostupan; u kartici Describe postoji checkbox
**AI interpret** s imenom modela (trenutno preferira `qwen2.5-coder:7b`).
Ako Ollama nije pokrenut, model ne odgovori ili checkbox isključiš, koristi se
isti lokalni rječnik kao fallback. UI tada pokaže _„Local interpreter (AI
unavailable)"_. Generirani profili s AI briefom nose **AI** badge i u opisu pišu
_„AI interpreted: …"_, pa se točno vidi što je model zaključio. AI brief se
filtrira: iz njega se uzimaju era/artist/subjekt/film stock, a generički
finišni pojmovi („high contrast", „deep blacks", „halation") se ne dodaju drugi
put jer su već dio odabrane ere/reference. Tvoja vlastita eksplicitna riječ
(„extra high contrast") i dalje se normalno parsira.

Lokalni rječnik prepoznaje engleski i hrvatski vokabular za subjekt (concert,
wedding, portrait, landscape, food, street, night, festival, sports, wildlife,
architecture, product, car), mood (cinematic, moody/dark, airy/bright, teal &
orange, vintage (i Polaroid/disposable), modern, natural, punchy, soft/dreamy,
matte, B&W/noir/sepia, neon, golden hour, warm, cool, earthy, muted…), filmske
stockove (Portra, Ektar, Gold, Fuji 400H, Cinestill 250D, Vision 500T,
Ilford/Tri-X), finiš (grain, vignette, halation/glow, clarity/detail, dehaze) i
modifikatore (_subtle_, _strong_, _extreme_). Posebno su razrađene **era** i
**artist/reference** kombinacije:

- **1950s** → topao Gold 200, blago podignuta crna, fini grain, zaštićeni
  highlighti i topli skin tonovi.
- **Glam Rock** (Queen / Freddie Mercury) → zlatni i jantarni highlighti, duboka
  crna, spotlight kontrast, halation i bogati crveni/žuti tonovi. Plavi stage
  wash se svjesno povlači.
- Redoslijed je **subjekt → portrait modifier → mood → era → reference →
  eksplicitni film stock**, pa „50s portrait concert with Freddie Mercury"
  završi kao **1950s Glam Rock Portrait**, a ne kao plavi koncertni look.
- Kod plavo osvijetljenog koncerta `adapt_look_to_photo()` dodatno izmjeri
  stvarni red/blue cast i doda toplinu samo onoliko koliko slici treba (vidi
  § „Per-image adaptacija"); dnevna 1950s fotografija ne dobiva taj dodatak.

Dobiješ četiri varijante istog intenta — **Balanced**, **Soft**, **Bold**,
**Film** — koje se razlikuju u kontrastu, clarityju, grain/fadeu i jačini LUT-a.
**Balanced** nosi oznaku **Recommended** jer je najsigurniji izbor za prosječnu
fotografiju; ostale varijante su svjesno izraženije. Svaka kartica ima **pravi
GPU preview** na prvoj odabranoj fotografiji (900 px, isti adjustmenti +
per-image adaptacija koje će se primijeniti), pa ne moraš pogađati kako će
izgledati. Kad se generiraju, modal sam skrola do kartica.

Iznad svakog previewa je gumb **Before**: dok ga držiš, vidiš istu fotografiju
**bez** looka (s tvojim postojećim sidecarom), a na gumbu piše **After**. Time
možeš uživo usporediti boju i tonalitet prije primjene. Baza i četiri looka
renderiraju se u **jednom** pozivu (`preview_style_profiles` sada vraća
`{ base, looks }`), pa se RAW dekodira samo jednom.

> **Napomena o previewu:** RAW baza je linearni `Rgb32F`. `DynamicImage::thumbnail`
> iz `image` cratea nije namijenjen float slikama — njegov rounding dodatak doda
> ~0.5 svakom kanalu i preview ispadne bijel. Zato se sve float slike
> downscaleaju kroz `downscale_for_analysis` (`resize_exact`), a integer slike
> zadržavaju brzi box filter. Isti helper koristi i culling, pa su i perceptual
> hash i oštrina računati na ispravnoj slici.

> **Napomena o brightnessu:** klizač **Brightness** u editoru radi u rasponu
> **−5…+5** (stopovi), dok contrast, saturation i boje koriste −100…100.
> Generator je nekoć pisao mood vrijednost (−7) izravno u profil, što je render
> skoro potpuno zacrnilo. Sada se intent dijeli s 10 (npr. −7 → −0.7), a
> `clamp_look_adjustments` ne dopušta da bilo koji profil (uključujući naučene
> i korisničke) izađe iz −5…+5.

- **Apply** primjenjuje look na cijelu selekciju bez spremanja u biblioteku;
  toast nudi **Undo** (snapshot prije pisanja).
- **Save** ga sprema u _Profiles_ (isti `id`, ponovni save ažurira postojeći).
- **Edit** otvara 8 klizača (contrast, brightness, saturation, temperature,
  highlights, shadows, grain, vignette); rasponi prate generator pa se Bold
  kontrast i crno-bijela zasićenost otvaraju na točnoj poziciji. Brightness
  klizač je −5…+5 s korakom 0.1, isto kao u editoru. Preview se osvježi kad
  pustiš klizač, a kartica izgubi kvačicu „spremljeno" jer se spremljena kopija
  više ne podudara.
- **Intensity** skalira cijeli look prije primjene.

Ako opis nema prepoznatih pojmova, generator ipak vrati blagi _Natural_ look
(contrast +6, vibrance +5, clarity +4) umjesto greške. Nepoznate riječi se
zanemaruju. Ograničenje opisa je 600 znakova.

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
- **Plavo stage svjetlo (1950s / Glam Rock)**: ako je izmjereni `cast_rb`
  negativan (hladna/plava scena), dodaje se do +14 temperature, malo tinta i
  brightnessa te se dodatno smanjuje zasićenje `blues`/`aquas` kanala. Time
  crveni i zlatni tonovi na koži ostanu čitljivi i pod plavim LED reflektorima.
  Na neutralnoj/dnevnoj fotografiji se taj dodatak ne aktivira; ostaje samo
  bazna toplina recepta.
- **White balance**: samo za neutralne/portretne stilove i samo kod izraženog
  casta (nikad za neon/stage-light scene ni tople lookove), s malim capom.

Rezultat: ista „Iron Maiden" ili filmska receptura izgleda različito na
nedovoljno eksponiranoj, preeksponiranoj i već zasićenoj fotografiji — što je i
bio cilj. Analiza se kešira po putanji + mtime; ako thumbnail još ne postoji,
look se primijeni s tvorničkim vrijednostima.

**Auto baseline za neuređene fotografije.** RAW render bez sidecara često je
1–2 EV tamniji od kamera JPEG-a koji vidiš u biblioteci, pa bi sam look ispao
poddimenzioniran. Zato se za fotografije **bez ijednog sidecar adjustmenta**
(ne i za one koje samo imaju tagove/flag) prije looka izračuna auto tonal
baseline na istom linearnom 900 px renderu koji ide u GPU: `perform_auto_analysis`
vrati exposure/shadows/highlights/whites/blacks, a uzima se 70 % exposurea i
shadow lifta te 50 % whites/blacks (contrast, clarity i vibrance ostaju looku).
Baseline se dodaje **aditivno** na look i uključuje `activeTools.basic`. Isti
`build_look_overlay()` koristi preview i batch apply, pa ono što vidiš u
karticama je točno ono što se upiše u sidecar.

Sam baseline nije dovoljan za agresivne „moody" lookove: negativan brightness,
kontrast i zdrobljene crne na tamnom RAW-u pojedu lift. Zato se uz baseline radi
i **kompenzacija looka** (samo za neuređene fotografije): negativan brightness
vraća se s ~1.3× + 0.35 EV, a negativne sjene/crne s ~0.8× / 0.3×. Boja, LUT,
kontrast, vinjeta i grain ostaju netaknuti, pa look i dalje nosi mood. Za DSCF5001
baseline je exposure +0.55 EV / shadows +26, a finalni „moody teal & orange"
Balanced sidecar ima exposure **1.81**, shadows **30.2**, brightness **−0.7**,
K-Vision 500T 46 % — subjekt je jasno osvijetljen, pozornica ostaje mračna.
Uređene fotografije (DSCF1131 s exposure 0.6) ne dobivaju baseline ni
kompenzaciju da se ne bi dvaput posvijetlile; one zadržavaju svoj postojeći
razvoj, a look samo mijenja grading.

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
| Prompt → 4 looka (lokalni colour engine) | `src-tauri/src/prompt_style.rs`                           |
| AI interpret (Ollama)                  | `src-tauri/src/prompt_ai.rs`                                 |
| Registracija naredbi                   | `src-tauri/src/lib.rs`                                       |
| UI                                     | `src/components/modals/AIStyleModal.tsx`, `CullingModal.tsx` |
| Tipovi / Invokes                       | `src/components/ui/AppProperties.tsx`                        |
| Modal state                            | `src/store/useUIStore.ts`                                    |
| Kontekstni izbornici                   | `src/hooks/useAppContextMenus.ts`                            |

Tauri naredbe: `list_style_profiles`, `save_style_profile`, `delete_style_profile`,
`derive_style_profile_from_paths`, `assign_artist_to_paths`,
`match_style_profiles_for_paths`, `apply_style_profile_to_paths`,
`auto_style_paths_with_ai`, `generate_style_candidates`,
`get_prompt_ai_status`, `apply_custom_style_profile`, `preview_style_profiles`.

Korisnički profili se spremaju u `<app data>/style_profiles/style_profiles.json`.

---

## 6. Ograničenja (iskreno)

- **Automatsko prepoznavanje imena benda ne postoji** offline bez dodatne baze
  logotipa/OCR-a ili VLM-a. Rješenje je označavanje eventa + učenje iz tvojih
  referenci (vidi §4).
- **„Najbolji kadar"** je i dalje djelomično subjektivan (izraz lica, trenutak).
  AI daje jak _shortlist_ i bira najboljeg u burstu, ali ne zamjenjuje u potpunosti
  tvoju procjenu.
- **Describe** s uključenim _AI interpret_ razumije slobodniji jezik, ali AI
  samo prevodi opis u fotografski brief; konačni grade i dalje gradi lokalni
  engine. Bez Ollame (ili s isključenim checkboxom) radi kurirani rječnik, pa
  neobične formulacije mogu promašiti; tada pomogne konkretniji opis (npr.
  „teal shadows, orange highlights, Portra, grain").
- **Generator drži** contrast/blacks u rasponu bliskom naučenom profilu (do
  +26/−18 prije varijanti) kako jaki „moody" opisi ne bi srušili svijetle
  RAW-ove u crno. Za ekstremniji izgled koristi **Bold** ili ručno doradi u
  **Edit**.
- Modeli (CLIP/SAM) traže prethodno preuzimanje i imaju svoje licence — provjeri
  prije komercijalne distribucije. Fork je AGPL-3.0.

## 7. Mogući sljedeći koraci

- **VLM sloj** (npr. Florence-2 / Qwen-VL preko postojećeg `ai_connector`
  ComfyUI/cloud hooka) za opis scene i prijedlog edita.
- **OCR logotipa** + baza bendova za automatski prijedlog imena benda.
- **Detekcija lica/očiju** za precizniji culling portreta.
- Automatska obrada već pri **importu** (postavka „auto-edit on import").
- **Progress bar** za auto-pass/apply na velikim selekcijama (trenutno spinner).
- **Undo i za culling apply** (AI Style undo već postoji; culling flags se za sada
  vraćaju ručno).
- **Brži baseline** (keširanje izmjerenog auto baselinea po putanji + mtime) da
  auto-pass na stotinama neuređenih RAW-ova ne dekodira svaki dvaput.

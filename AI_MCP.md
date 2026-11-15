# RapidRAW Web kao MCP server za AI

RapidRAW Web je **MCP server** (Model Context Protocol). Bilo koja AI aplikacija koja podržava MCP (Claude Code,
Claude Desktop, Cursor, VS Code, Windsurf, Codex, Gemini CLI…) može kroz njega potpuno uređivati fotografije u
RapidRAW-u: pregledati biblioteku, pogledati render fotografije, mijenjati bilo koji slider i pokretati sve
naredbe AI Editora (maske, AI maske, denoise, HDR, panorama, focus stacking, krop, lens, stilovi, LUT, preseti,
ocjene, oznake, culling i izvoz). Uz server dolaze **skillovi**: recepti za tipične situacije (koncert, portret,
HDR, panorama, visoki ISO, noir, editorial, izvoz za mreže, culling) koje AI može slijediti.

Sve je nedestruktivno: promjene idu u sidecar datoteke, originali se nikad ne mijenjaju, a svako pokretanje ima
undo.

---

## 1. Brzi početak

1. Pokreni **RapidRAW Web Bridge** kao i inače (server je uključen automatski, na istom portu: `http://<server>:8780/mcp`).
2. U RapidRAW Webu otvori **AI Editor → AI clients (MCP)**. Tamo su adresa, token i gotove konfiguracije za
   kopiranje za svaki AI klijent.
3. Ostavi RapidRAW Web otvoren u pregledniku: naredbe AI Editora (`rapidraw_run`) izvršavaju se u tom tabu, pa
   vidiš svaku promjenu uživo. Pregled, čitanje i slideri rade i bez otvorenog taba.

### Claude Code (preporučeno: plugin sa svim skillovima)

```bash
claude plugin marketplace add vedranius/rapidraw-web
claude plugin install rapidraw@rapidraw-web
```

ili unutar Claude Codea: `/plugin marketplace add vedranius/rapidraw-web`, pa `/plugin install rapidraw@rapidraw-web`.
Plugin dodaje MCP vezu i sve skillove odjednom; ažurira se s `claude plugin marketplace update rapidraw-web`.
Ako RapidRAW Web nije na istom računalu, prije pokretanja postavi:

```bash
export RAPIDRAW_MCP_URL=http://192.168.1.20:8780/mcp
export RAPIDRAW_MCP_TOKEN=<token iz AI Editor → AI clients>
```

Samo MCP server, bez plugina:

```bash
claude mcp add --transport http rapidraw http://localhost:8780/mcp --header "Authorization: Bearer <token>"
```

### Claude Desktop, Codex, Gemini CLI i drugi stdio klijenti

```json
{ "mcpServers": { "rapidraw": { "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:8780/mcp", "--header", "Authorization:Bearer <token>"] } } }
```

(Claude Desktop: *Settings → Developer → Edit Config*. Treba Node.js. Za `http://` adresu na drugom računalu
dodaj `--allow-http`.) Skillove za Claude.ai / Claude Desktop preuzmi kao `.zip` u **AI clients → Download skills**
i učitaj u *Settings → Capabilities → Skills*.

### Cursor, VS Code, Windsurf i drugi HTTP klijenti

```json
{ "mcpServers": { "rapidraw": { "url": "http://localhost:8780/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

---

## 2. Alati

| Alat | Što radi | Treba otvoren tab |
|---|---|---|
| `rapidraw_status` | radi li RapidRAW, biblioteka, opterećenje servera, poslovi, vision model, koji model za koji posao | ne |
| `rapidraw_list_images` | fotografije u mapi (ocjena, zastavica, boja, tagovi, RAW, uređeno), po stranicama i s filtrima (`flag`, `color`, `minRating`, `ext`, `pathsOnly`) | ne |
| `rapidraw_get_edit` | trenutno uređivanje, samo vrijednosti različite od zadanih (malo tokena) | ne |
| `rapidraw_preview` | render s GPU-a kao JPEG (`maxEdge`), može prikazati i patch bez spremanja | ne |
| `rapidraw_apply_adjustments` | deep-merge patcha bilo kojih adjustmenta (slideri, krivulje, HSL, color grading, maske); vrijednosti izvan raspona se odbijaju | ne |
| `rapidraw_process` | **posao**: maske, denoise po izmjerenom šumu, export, automatska provjera i jedan popravak svake fotke | ne |
| `rapidraw_analyze` | **posao**: šum svake fotke i koliko bi trajala svaka od 4 brzine | ne |
| `rapidraw_export` | **posao**: export sa spremljenim uređivanjima i provjerom datoteka | ne |
| `rapidraw_ai_mask` | **posao**: AI maska (subjekt, lice, nebo, prednji plan, tekst) na mnogo fotki, ista maska se zamjenjuje | ne |
| `rapidraw_ai_review` | **posao**: jeftini vision model na serveru (Claude Haiku ili Gemini Flash) ocjenjuje granične fotke | ne |
| `rapidraw_job` | stanje posla, `wait` (do 50 s), `cancel`, `resume`, `undo`, `list` | ne |
| `rapidraw_rank` | boduje cijelu mapu AI cullingom (kompozicija, svjetlo, oštrina, scena), izbacuje duplikate iz burstova i mutne, vraća najboljih N s ISO-m | ne |
| `rapidraw_set_library` | oznaka pick/reject, zvjezdice, boja, tagovi za više fotki odjednom (`includePairs`: i JPG para RAW-a) | ne |
| `rapidraw_commands` | katalog naredbi AI Editora i (s `reference: true`) svi ključevi i rasponi | ne |
| `rapidraw_run` | plan naredbi AI Editora, korak po korak, sa snapshotom za undo (`async`: vraća jobId) | **da** |
| `rapidraw_undo` | vraća sidecare na stanje prije `rapidraw_run` | **da** |
| `rapidraw_skills` | popis skillova ili cijeli recept jednog skilla | ne |
| `rapidraw_install_skills` | instalira skillove s gita ili URL-a na server | ne |

Skillovi su dostupni i kao **MCP prompti** (u Claude Codeu npr. `/mcp__rapidraw__concert-hero`) i kao resursi
(`rapidraw://skills/<id>`, `rapidraw://reference/adjustments`).

Primjer: *"Otvori zadnji koncert iz biblioteke, odšumi, podigni pjevača +0.3 EV maskom subjekta, topliji look,
pokaži mi prije i poslije."* AI tada zove `rapidraw_list_images` → `rapidraw_preview` → `rapidraw_run`
(`photo.denoise`, `photo.ai-mask`, `photo.prompt-style`) → `rapidraw_preview`.

Primjer za cijelo snimanje: *"Pregledaj sve fotke s koncerta u mapi Koncerti/2026-11-08, odaberi najboljih 50,
obradi ih ujednačeno, napravi denoise gdje je ISO visok i označi ih kao picked."* AI tada koristi skill
`concert-best-of`: `rapidraw_rank` (top 50) → `rapidraw_run` na svih 50 (`photo.auto-tone`, `photo.denoise` samo za
visoki ISO, `photo.prompt-style`) → `rapidraw_set_library` s `flag: "pick"` → nekoliko `rapidraw_preview` za
provjeru. Analiza velike mape traje (svaka datoteka se dekodira), pa je za stotine RAW-ova normalno nekoliko minuta.

### Sigurnost

- Rizični koraci (`library.export`, `settings.reset`, `app.setting`) odbijaju se bez `allowRisky: true`, pa ih AI
  mora izričito zatražiti (i pitati tebe).
- Putanje izvan mapa s fotografijama se odbijaju; nepoznate naredbe i nepoznati adjustment ključevi također.
- **Token**: programi na istom računalu ne trebaju token. Sve ostalo (drugo računalo, reverse proxy ili tunel
  poput `tailscale serve` ili cloudflared, preglednik) treba `Authorization: Bearer <token>` (ili `?token=`).
  Token se generira pri prvom pokretanju i čuva u konfiguraciji relaya; zadaje se s `RR_MCP_TOKEN`.
  `RR_MCP_REQUIRE_TOKEN=1` traži token uvijek, `RR_MCP=0` isključuje server.
- Web stranice ne mogu doći do servera (provjera `Origin`).

---

## 3. Skillovi

Skill je Markdown datoteka s frontmatterom (`name`, `description`), isti format kao Agent Skills (`SKILL.md`).
RapidRAW ih koristi na dva mjesta: u AI Editoru u aplikaciji i kroz MCP za vanjske AI klijente.

- Ugrađeni recepti su u `src/agent/skills/*.md`; `node rrweb/mcp/generate.mjs` iz njih radi
  `plugins/rapidraw/skills/<id>/SKILL.md` (Claude Code plugin) i `rrweb/relay/mcp-data.json` (server). CI
  provjerava da su usklađeni.
- **Instalacija iz aplikacije**: *AI Editor → AI clients → Install / update all RapidRAW skills* instalira sve
  skillove iz ovog repozitorija (ponovni klik ih ažurira). U polje se može upisati i bilo koji drugi izvor:
  `owner/repo`, `https://github.com/owner/repo/tree/main/skills`, bilo koji git URL (`https://`, `ssh://`) ili
  izravan URL `.md` datoteke. Traže se sve `SKILL.md` datoteke i `.md` datoteke u `skills/` mapama.
- Instalirani skillovi spremaju se na serveru (`<konfiguracija relaya>/skills`), vide se u kartici *Skills* AI
  Editora (oznaka *installed*), kao MCP prompti, i zamjenjuju ugrađeni skill istog imena.
- AI klijent ih može instalirati i sam: `rapidraw_install_skills`.

Vlastiti skill za AI klijente:

```markdown
---
name: wedding-soft
description: Mekan, svijetao vjenčani look sa zaštitom kože.
metadata:
  title: "Wedding Soft"
  triggers: "vjenčanje, wedding, mladenka"
  rapidraw-commands: "photo.inspect, photo.auto-tone, photo.ai-mask, settings.patch"
---

1. Pregledaj fotografiju i histogram...
```

---

## 4. Obrada cijelog snimanja (headless poslovi)

Sve teže radi na serveru, bez preglednika, kao **posao**: alat odmah vrati `jobId`, a `rapidraw_job
{action: "wait"}` čeka do 50 s po pozivu (ispod timeouta AI klijenata). Istovremeno radi jedan teški posao, do 6
ih čeka u redu; ako je red pun, odgovor je "busy" s vremenom za ponovni pokušaj. Poslovi se pamte u
`<konfiguracija>/mcp-jobs.json`: nakon restarta prekinuti posao se nastavlja s `action: "resume"` (samo s fotkama
koje nije završio), a `action: "undo"` vraća uređivanja koja je posao promijenio. Dok posao radi, pozadinski AI
posao za druge fotke čeka.

**Četiri brzine** (`mode` u `rapidraw_process`; AI mora pitati koju želiš, `rapidraw_analyze` daje stvarna vremena
za te fotke, a server s vremenom uči svoju brzinu):

| `mode` | Što radi |
|---|---|
| `none` | vrlo brzo: bez denoisea (samo šum boje na jako šumnim fotkama) |
| `bm3d` | brzo: BM3D na svakoj fotki kojoj treba |
| `mixed` | sporije: po fotki prema izmjerenom šumu: ništa za čiste, BM3D za umjeren šum, AI za jak |
| `ai` | vrlo sporo: AI na svakoj fotki kojoj treba |

Čiste fotke nikad ne dobiju AI denoise. Šum se mjeri na renderu bez noise reductiona (Immerkær, razine 0..255 na
2048 px); pragovi su `thresholds: {low: 1.2, high: 3.0}`. Za export manji od fotke AI denoise se radi na dvostrukoj
veličini exporta (`fastDenoise`), ne na punih 26 MP.

**Automatska provjera** svake izvezene datoteke: bijela ili crna slika, "zgnječen" subjekt u sredini, pravilna
mreža (šavovi pločica denoisea), denoise bez učinka. S `autoFix` se fotka jednom popravi (ekspozicija, sjene,
drugi denoise) i izveze ponovno; što ostane, vidi se u `problems` sažetka.

**Delegiranje po vrsti posla.** Server sam šalje svaki posao modelu koji mu odgovara, a glavni model sesije
(npr. Opus u Claude Codeu) čita samo sažetke:

| Posao | Alat | Model (zadano) | Bez AI providera na serveru |
|---|---|---|---|
| culling stotina fotki | `rapidraw_rank` (lokalno, besplatno), pa `rapidraw_ai_review` samo za granične | `cull`: Haiku / Gemini Flash | subagent `photo-culler` |
| plan uređivanja seta | `rapidraw_ai_plan` (3 do 8 uzoraka, plan se provjerava, ništa se ne sprema) | `plan`: Sonnet / Gemini Pro | subagent `edit-planner` |
| fotke koje ni nakon popravka ne prolaze provjeru | `rapidraw_process {rescue: true}` (do `rescueLimit` fotki po poslu) | `rescue`: Opus / Gemini Pro | subagent `photo-rescuer` |

Modeli se mijenjaju s `RR_MODEL_CULL`, `RR_MODEL_PLAN`, `RR_MODEL_RESCUE` ili `"models"` u konfiguraciji relaya.

**Plaća pretplata, ne API.** Zadano server koristi **Claude Code CLI prijavljen tvojim Claude planom** (Pro/Max):
instaliraj `claude` na server i jednom se prijavi (`claude`, pa `/login`). Ako `claude` nije instaliran, koristi
**Gemini CLI** prijavljen Google računom. CLI se pokreće bez ijednog API ključa u okruženju, a ako bi ipak
koristio API ključ (npr. iz svojih postavki), poziv se prekida. Plaćanje po tokenu postoji samo ako ga izričito
odabereš: `RR_AI_PROVIDER=anthropic` uz `ANTHROPIC_API_KEY` ili `RR_AI_PROVIDER=gemini` uz `GEMINI_API_KEY`.
`rapidraw_status` pokazuje providera i `billing` ("subscription" ili "API"). Ako CLI nije na PATH-u servisa,
postavi `RR_CLAUDE_BIN` ili `RR_GEMINI_BIN`. Fotke napuštaju server samo kao previewi do 1024 px (culling 640 px),
i to samo prema odabranom provideru.

Plugin donosi skill `concert-processing` s cijelim postupkom i tri subagenta za klijente bez AI-a na serveru.

**Brzina i opterećenje:**

- AI (ONNX) koristi sve jezgre osim dvije (`RR_AI_THREADS` mijenja broj). Linux servis ima `Nice=5` i
  `CPUWeight=70`, pa desktop i SSH ostaju responzivni.
- NVIDIA GPU za AI denoise i maske: instaliraj `onnxruntime-gpu` (CUDA 12) i pokreni s
  `ORT_DYLIB_PATH=/put/do/libonnxruntime.so`; RapidRAW sam koristi CUDA ako je dostupna (`RR_AI_CUDA=0` isključuje,
  `RR_AI_CUDA_DEVICE` bira karticu).
- Previewi preko MCP-a renderiraju se najviše dva odjednom (`RR_MCP_PREVIEWS`).

---

## 5. PhotoCraft: slojevi, kompoziti i efekti

RapidRAW razvija RAW i radi globalne i maskirane korekcije. Za ono što traži slojeve (dvostruka ekspozicija,
spajanje više fotografija, zoom-burst oko oštrog izvođača, sjaj snopova svjetla, tekst, naslovnice, posteri)
AI klijent koristi i [PhotoCraft](https://github.com/storytold/photocraft), open-source slojevni editor s
vlastitim MCP serverom (`photocraft-cli mcp`, bez prozora). Skill `photo-studio` iz plugina odlučuje kamo ide
koji posao i kako se predaje datoteka; `stage-looks` ima izglede i recepte.

- **Redoslijed je uvijek RapidRAW pa PhotoCraft.** RapidRAW izveze 16-bitni TIFF (sRGB, s EXIF/IPTC/XMP) u
  mapu za predaju, PhotoCraft ga otvori, radi u slojevima i spremi `.pcraft` (ili `.psd`) master i JPEG.
  JPEG se nikad ne koristi kao međukorak (8 bita, trake u tamnim dijelovima pozornice).
- **Postavljanje (Linux):** `rrweb/photocraft/setup.sh --root ~/Pictures --out ~/Pictures/studio`. Koristi
  `photocraft-cli` s PATH-a ili instalira izdanje u `~/.local/opt/photocraft` (bez sudo), pa ga prijavi u Claude
  Code kao MCP server `photocraft`. PhotoCraft čita samo mape iz `--root` i piše samo u `--out`. Postojeći unos
  `photocraft` mijenja tek s `--force`.
- **Metapodaci:** ako izvoz iz PhotoCrafta nema EXIF, skill ga kopira iz RapidRAW TIFF-a s `exiftool`
  (paket `perl-image-exiftool` na Archu/CachyOS-u).
- **Stage Fire & Ice** (`stage-fire-ice`) je ugrađeni look za rock i metal koncerte, izmjeren na stotinjak
  objavljenih koncertnih fotografija: svjetlo svedeno na dvije boje (vatreno narančasto-crvena i ledeno
  cijan), tamni ton s mekim podom crnih, topli svjetli tonovi sa sjajem, hrapava lica, dubok vinjet i
  zoom-burst rub. Radi i u AI Editoru u aplikaciji i kroz MCP (`rapidraw_process` za cijelu galeriju).

---

## 6. Kako radi

```
AI klijent ──MCP (HTTP POST /mcp, JSON-RPC)──▶ relay (rrweb/relay/mcp.mjs)
                                                 ├─▶ bridge (RapidRAW backend, GPU): pregled, čitanje, slideri
                                                 └─▶ otvoreni RapidRAW Web tab (src/agent/McpHost.tsx):
                                                     izvršava naredbe AI Editora (src/agent/executor.ts)
```

Plan izvršava isti kod kao AI Editor u aplikaciji (`executePlan`): snapshot sidecara prije pokretanja,
zaustavljanje na prvoj grešci, preusmjeravanje na novu datoteku nakon HDR-a/panorame/stacka. Ako je otvoreno više
tabova, plan izvršava zadnji aktivni. Za `rapidraw_preview` backend prima novi neobavezni parametar `maxEdge`
(`generate_preview_for_path`), pa AI dobiva sliku od nekoliko stotina KB umjesto punog rendera.

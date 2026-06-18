# CLAUDE.md — PitchPulse

> Questo file viene letto automaticamente da Claude Code all'avvio di ogni sessione.
> Tienilo aggiornato: è la fonte di verità tra una sessione e l'altra, non la chat.

Guida operativa per Claude Code su questo repository. Leggi questo file prima di qualsiasi modifica al pipeline HTML/render.

## Cosa è PitchPulse

Brand di media sportivo (calcio) che produce contenuti video brandizzati e automatizzati per TikTok, Instagram Reels, YouTube Shorts. Focus principale: copertura FIFA World Cup 2026.

La pipeline prende dati di partita strutturati (JSON) e produce due deliverable accoppiati per ogni richiesta:
- una card HTML animata autosufficiente, 1080×1920px
- un file di copy/caption social di accompagnamento

Pipeline: comando Telegram → recupero dati via Perplexity AI → JSON strutturato → Claude genera HTML → render MP4 via HyperFrames su GitHub Actions → upload Dropbox → callback Telegram.

## Architecture

```
Telegram Bot (Railway)
  ├─ /prematch /live /postmatch /teaser → handleMoment()
  ├─ /curiosity → handleCuriosity()
  └─ /highlights → handleHighlights()
       └─ Perplexity AI (sonar-pro) → JSON match data
            └─ Claude (claude-haiku-4-5) → HTML Agent → 2 file (HTML + TXT)
                 └─ GitHub Actions → HyperFrames CLI → render MP4
                      └─ Dropbox (output) → callback Telegram
```

- **Repo attivo**: `it-rainking/PitchPulse` (pubblico)
- **Hosting bot**: Railway — `pitchpulsebot-production.up.railway.app`
- **System prompt HTML Agent**: `bot/prompts/system-html-agent.txt`
- **Handler bot**: `/prematch /live /postmatch /teaser` → `handleMoment()` · `/curiosity` → `handleCuriosity()` · `/highlights` → `handleHighlights()`

## Stato attuale (ultimo aggiornamento: vedi data ultimo commit)

- **Pipeline end-to-end**: confermata funzionante, render completo 450/450 frame
- **Bot**: 6 comandi attivi — `/prematch`, `/live`, `/postmatch`, `/teaser` → `handleMoment()` · `/curiosity` → `handleCuriosity()` · `/highlights` → `handleHighlights()`
- **System prompt HTML Agent**: `bot/prompts/system-html-agent.txt`

### Problemi aperti

1. **Template 36 animazioni PRE-MATCH** (`pitchpulse-prematch-test.html`): discusso e progettato, ma **CONFERMATO: il file non esiste nel repo**. Esiste solo come contenuto scambiato in chat — va ricreato e committato per non perderlo, prima di passare alla review di Nick.

### Da fare

- **PRIORITÀ 1**: il template 36 animazioni PRE-MATCH (`pitchpulse-prematch-test.html`) non esiste ancora come file nel repo — va creato/salvato prima di poterlo far revieware a Nick, altrimenti il lavoro discusso in chat è a rischio perdita
- Review template 36 animazioni (una volta creato) e integrazione regole approvate in `system-html-agent.txt`
- Valutare script `auto-trigger.js` per re-render periodico automatico durante live match (proposto, non costruito)
- Valutare alternative production-grade a endpoint ESPN non ufficiali (candidate: StatsBomb, API-Football, SportRadar)

## Tech Stack

| Layer | Strumento |
|---|---|
| Rendering | HyperFrames CLI (target v0.6.97+), Node 22, FFmpeg, Chromium headless |
| Bot/hosting | Railway (webhook Node/Telegram), GitHub Actions (workflow render) |
| AI generazione HTML | `claude-haiku-4-5` |
| AI dati match | Perplexity `sonar-pro` |
| Storage output | Dropbox (MP4) |
| CDN asset brand | Cloudflare R2 — `pub-3014d0a8aa084b139613f942b5551b02.r2.dev` (logo, font) |
| Dati match | WC26-Tracker (Cloudflare Workers, wrapper API ESPN non ufficiale) — alternative in valutazione |

## Struttura cartelle attesa

```
PitchPulse/
├── audio/PP-prematch.mp3, PP-live.mp3, PP-postmatch.mp3
├── fonts/BebasNeue-Regular.ttf, BarlowCondensed-Bold.ttf, Barlow-Regular.ttf, Barlow-Medium.ttf
├── videos/[filename].mp4
└── [NomeProgetto]/index.html
```

## Output Convention

Ogni richiesta produce sempre due file accoppiati:
- `pitchpulse-[moment]-[TEAMAvsTEAMB].html`
- `pitchpulse-copy-[moment]-[TEAMAvsTEAMB].txt`

Moment supportati: `prematch`, `live`, `postmatch`, `teaser` (sotto-tipi teaser: contenders, groups-of-death, history, players-to-watch, ecc.), `curiosity`, `highlights`

## Critical Rules — HyperFrames (non violare mai)

Queste regole sono state apprese tramite debugging hard-won. Violarle rompe il render o lo rende silenzioso/degradato.

1. **`window.__timelines["composition-id"]`** deve essere un oggetto completo compatibile con GSAP: `duration()`, `time()`, `seek()`, `pause()`, `play()` come **funzioni**, non proprietà numeriche piatte.
2. **Struttura DOM rigida**: `#root` è l'unico figlio diretto di `<body>` (nessun fratello prima o dopo). `<audio>` è il primo figlio di `#root`. Poi i layer di sfondo (`bg-grid`, `bg-glow`, `scanline`), poi `.content-wrapper`. `data-composition-id` sta su `#root` — StaticGuard scansiona questo come primo figlio di `body`; qualsiasi elemento prima causa `root_missing_composition_id`.
3. **Audio**: richiede `data-start` (altrimenti `media_missing_data_start`) e `id` (altrimenti `media_missing_id`, audio silenzioso). Deve essere scaricato localmente prima del render — HyperFrames non risolve URL remoti per il mixing FFmpeg. Mai `display:none` sull'audio (viene skippato dal compiler). `ERR_ABORTED` nei log headless è normale: l'audio è mixato da FFmpeg, non suonato dal browser.
4. **Path asset**: audio e video usano path relativi alla cartella parallela (`../audio/`, `../videos/`); font usano `fonts/` (senza `../`) perché il workflow li copia DENTRO la project directory. Mai path assoluti (`/Users/...` o leading slash come `/audio/...`). Asset statici vanno copiati dentro la project directory prima del render.
5. **Render command**: `npx hyperframes render . --output file.mp4 --format mp4` eseguito dalla directory di progetto contenente `index.html`.
6. **Font**: niente Google Fonts — il renderer è offline/sandboxed. Font locali via `@font-face` con path `fonts/` (il workflow copia i font dentro la project dir), `format('truetype')` per file `.ttf`.
7. **Niente testo con gradiente**: mai `-webkit-text-fill-color: transparent` o `background-clip: text` su numeri grandi/headline — Chromium headless li renderizza in modo inconsistente. Usare `color` + `text-shadow` glow.
8. **JavaScript**: solo lo stub di registrazione timeline è permesso. Zero `requestAnimationFrame`, zero `setInterval`/`setTimeout` — il rAF forza HyperFrames in screenshot mode degradando qualità e velocità. `play()`/`pause()` devono essere no-op.
9. **Pointer-events sui layer decorativi**: mai `pointer-events:none` inline (il linter HyperFrames lo flagga). Raggruppare tutti i bg layer in un wrapper `.bg-layer-wrap` con la regola CSS dedicata.
10. **Video di sfondo**: va in `.bg-layer-wrap` (primo figlio, prima di `.bg-grid`), mai in `.anim-layer`. Richiede `data-start`, `data-duration`, e `muted` obbligatorio (l'audio resta solo su `#bg-audio`).

### Warning non bloccanti (ignorare)

- `audio_src_not_found` / "asset outside project directory": comportamento atteso quando asset vivono in cartelle parallele al progetto — HyperFrames li copia automaticamente nel render output. Il render completa correttamente (450/450 frame) anche con questi warning. Usare `--strict` solo se richiesto esplicitamente.

## Critical Rules — Pipeline / Infra

- **GitHub Actions + HTML raw**: passare HTML tramite `echo` causa errori di sintassi bash. Sempre base64-encode in `bot.js`, decode nel workflow.
- **Schema JSON Perplexity**: costruire come oggetto JS nativo e serializzare con `JSON.stringify()` — mai interpolazione di stringa inline.
- **Cache stale**: HyperFrames/GitHub Actions possono mostrare file di workflow cache obsoleti. Confermare sempre quale file viene effettivamente eseguito a runtime tramite step di debug.

## Conventions

- **Pattern di trigger**: prompt a singola parola (`prematch`, `postmatch`, `live`, `teaser`) o payload JSON strutturati = trigger di task completi. Deliverable pronti per produzione, senza andirivieni.
- **Flusso dati**: prompt Perplexity → JSON strutturato → HTML Agent → MP4. I prompt Perplexity richiedono solo i nomi delle squadre come input manuale; tutti gli altri campi auto-popolati via web search.
- **Stile di iterazione**: bug fixati sequenzialmente in sessione con i log a guidare la diagnosi. Le regole del system prompt vengono formalizzate solo dopo che il debug ne confirma il comportamento corretto.

## Design System

- Canvas: 1080×1920px, 30fps, durata 15s
- Base: navy scuro `#0A0E2A`
- Palette: cyan `#00F5FF`, violetto `#7B2FFF`, accent rosa `#FF2D7A`, oro `#FFD166`
- Varianti moment: LIVE → `#FF3B3B` sostituisce cyan come accent primario; POSTMATCH → oro sostituisce cyan
- Tipografia: Bebas Neue (display) · Barlow Condensed 700 (label) · Barlow 400/500 (body)
- Safe zone: niente contenuto importante nel 15% inferiore (overlay UI TikTok) o nell'8% superiore (status bar)

## Note operative per Claude Code

- Prima di ogni sessione: `git pull` per essere sicuri di partire dalla versione aggiornata del repo, non da una copia locale stale.
- Dopo ogni modifica significativa: commit + push, non lasciare lavoro solo in locale — è l'unico modo per cui questo file e il repo restino la fonte di verità tra una sessione e l'altra.
- Se questo file risulta disallineato con lo stato reale del repo (es. un problema elencato come "aperto" è già stato risolto), aggiornarlo subito come parte del task, non a fine sessione.

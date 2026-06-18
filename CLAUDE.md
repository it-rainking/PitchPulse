# CLAUDE.md — PitchPulse

Guida operativa per Claude Code su questo repository. Leggi questo file prima di qualsiasi modifica al pipeline HTML/render.

## Project Overview

PitchPulse è un brand di sports media (calcio) che produce video short-form automatizzati e brandizzati per TikTok, Instagram Reels e YouTube Shorts, con focus principale sul Mondiale FIFA 2026.

La pipeline prende dati di partita strutturati (JSON) e produce due deliverable accoppiati per ogni richiesta:
- una card HTML animata autosufficiente, 1080×1920px
- un file di copy/caption social di accompagnamento

Flusso completo: comando Telegram bot → recupero dati via Perplexity AI → JSON strutturato → generazione HTML via Claude → render MP4 via HyperFrames su GitHub Actions → upload Dropbox → callback Telegram.

**Stato attuale**: render end-to-end confermato funzionante (450/450 frame).

## Architecture

```
Telegram Bot (Railway)
  └─ /prematch /live /postmatch /teaser → handleMoment()
       └─ Perplexity AI (sonar-pro) → JSON match data
            └─ Claude (claude-haiku-4-5) → HTML Agent → 2 file (HTML + TXT)
                 └─ GitHub Actions → HyperFrames CLI → render MP4
                      └─ Dropbox (output) → callback Telegram
```

- **Repo attivo**: `it-rainking/PitchPulse` (pubblico)
- **Hosting bot**: Railway — `pitchpulsebot-production.up.railway.app`
- **System prompt HTML Agent**: `bot/prompts/system-html-agent.txt`
- **Handler bot**: tutti i comandi instradano su un singolo `handleMoment()`

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

## Output Convention

Ogni richiesta produce sempre due file accoppiati:
- `pitchpulse-[moment]-[TEAMAvsTEAMB].html`
- `pitchpulse-copy-[moment]-[TEAMAvsTEAMB].txt`

Moment supportati: `prematch`, `live`, `postmatch`, `teaser` (sotto-tipi teaser: contenders, groups-of-death, history, players-to-watch, ecc.)

## Critical Rules — HyperFrames (non violare mai)

Queste regole sono state apprese tramite debugging hard-won. Violarle rompe il render o lo rende silenzioso/degradato.

1. **`window.__timelines["composition-id"]`** deve essere un oggetto completo compatibile con GSAP: `duration()`, `time()`, `seek()`, `pause()`, `play()` come **funzioni**, non proprietà numeriche piatte.
2. **Struttura DOM rigida**: `#root` è l'unico figlio diretto di `<body>` (nessun fratello prima o dopo). `<audio>` è il primo figlio di `#root`. Poi i layer di sfondo (`bg-grid`, `bg-glow`, `scanline`), poi `.content-wrapper`. `data-composition-id` sta su `#root` — StaticGuard scansiona questo come primo figlio di `body`; qualsiasi elemento prima causa `root_missing_composition_id`.
3. **Audio**: richiede `data-start` (altrimenti `media_missing_data_start`) e `id` (altrimenti `media_missing_id`, audio silenzioso). Deve essere scaricato localmente prima del render — HyperFrames non risolve URL remoti per il mixing FFmpeg. Mai `display:none` sull'audio (viene skippato dal compiler). `ERR_ABORTED` nei log headless è normale: l'audio è mixato da FFmpeg, non suonato dal browser.
4. **Path asset**: sempre relativi al progetto (`../audio/`, `../fonts/`, `../videos/`), mai assoluti (`/Users/...` o leading slash come `/audio/...`). Asset statici vanno copiati dentro la project directory prima del render.
5. **Render command**: `npx hyperframes render . --output file.mp4 --format mp4` eseguito dalla directory di progetto contenente `index.html`.
6. **Font**: niente Google Fonts — il renderer è offline/sandboxed. Font locali via `@font-face` con path relativi `../fonts/`, `format('woff2')`.
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

## Open Items / Next Steps

- [ ] Testare e confermare la fix dei path audio con leading-slash (rimozione slash iniziali in `system-html-agent.txt`)
- [ ] Revisionare il sistema a 36 animazioni PRE-MATCH (`pitchpulse-prematch-test.html`) e integrare le regole approvate nel system prompt
- [ ] Completare il setup della connessione GitHub repo (fermato allo stadio di raccolta informazioni)
- [ ] Valutare script companion `auto-trigger.js` per re-rendering periodico automatizzato durante partite live (proposto, non costruito)
- [ ] Valutare alternative API dati production-grade a ESPN non ufficiale: StatsBomb, API-Football, SportRadar

## Note

Questo file riflette lo stato del progetto al 18 giugno 2026, basato sulla cronologia delle sessioni precedenti. Aggiornarlo quando vengono chiuse le voci in Open Items o quando emergono nuove regole critiche da debugging.

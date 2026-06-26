const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');
const express = require('express');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const app = express();
app.use(express.json({ limit: '50mb' }));

const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system-html-agent.txt'), 'utf8');

// ── Metricool Bridge: store output renders (persisted to disk) ──
// Key: projectName, Value: { project, dropbox, caption, shareLink, timestamp }
const outputStore = new Map();
const STORE_FILE = path.join(__dirname, 'output-store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) outputStore.set(k, v);
      console.log(`[store] caricati ${outputStore.size} output da disco`);
    }
  } catch (e) { console.error('[store] load error:', e.message); }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(outputStore), null, 2), 'utf8');
  } catch (e) { console.error('[store] save error:', e.message); }
}

loadStore();

// ── Prompt Perplexity: istruzioni statiche per moment ─────
// File esterni in prompts/perplexity/ - contengono solo testo
// con placeholder {{...}}; bot.js fa il replace a runtime.
const PPL_DIR = path.join(__dirname, 'prompts/perplexity');
const PPL_INSTRUCTIONS = {
  common:     fs.readFileSync(path.join(PPL_DIR, 'common-match-instructions.txt'), 'utf8'),
  prematch:   fs.readFileSync(path.join(PPL_DIR, 'prematch-instructions.txt'), 'utf8'),
  live:       fs.readFileSync(path.join(PPL_DIR, 'live-instructions.txt'), 'utf8'),
  postmatch:  fs.readFileSync(path.join(PPL_DIR, 'postmatch-instructions.txt'), 'utf8'),
  teaser:     fs.readFileSync(path.join(PPL_DIR, 'teaser-instructions.txt'), 'utf8'),
  curiosity:  fs.readFileSync(path.join(PPL_DIR, 'curiosity-instructions.txt'), 'utf8'),
  highlights: fs.readFileSync(path.join(PPL_DIR, 'highlights-instructions.txt'), 'utf8'),
  group_hl:   fs.readFileSync(path.join(PPL_DIR, 'group_hl-instructions.txt'), 'utf8')
};

// ── Helper: sostituisce {{PLACEHOLDER}} in un template testuale ──
function fillTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

// ── Helper: spezza un blocco di testo multilinea in array di righe
//    non vuote, per ricostruire l'array prompt.join('\n') esistente ──
function linesOf(text) {
  return text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
}

// ── Helper: normalizza il post text — rimuove intestazioni e applica spaziatura ──
// Elimina header tipo "=== PITCHPULSE ... ===" e tutte le righe di metadati,
// poi applica 2 righe vuote tra i paragrafi.
function formatPostText(text) {
  const headerPatterns = [
    /^===\s*PITCHPULSE/i,
    /^Match:\s/i,
    /^Phase:\s/i,
    /^Venue:\s/i,
    /^Kickoff:\s/i,
    /^Topic:\s/i,
    /^Category:\s/i,
    /^Matchday:\s/i,
    /^Tournament:\s/i,
    /^Group:\s/i,
    /^---\s*TIKTOK/i,
    /^---\s*HASHTAGS/i,
    /^---\s*CAPTION/i,
  ];

  const lines = text.split('\n');
  const cleaned = lines.filter(line => !headerPatterns.some(p => p.test(line.trim())));
  const trimmed = cleaned.join('\n').trim();

  const blocks = trimmed.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return '';

  let hashIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].trimStart().startsWith('#')) { hashIdx = i; break; }
  }

  if (hashIdx <= 0) return blocks.join('\n\n\n');

  const content = blocks.slice(0, hashIdx);
  const hash = blocks.slice(hashIdx).join('\n\n\n');
  return content.join('\n\n\n') + '\n\n\n\n' + hash;
}

// ── Helper: escape literal control chars inside JSON string values ──────────
function escapeStringControlChars(s) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { result += c; escaped = false; continue; }
    if (c === '\\') { result += c; escaped = true; continue; }
    if (c === '"') { result += c; inString = !inString; continue; }
    if (inString) {
      const code = c.charCodeAt(0);
      if (c === '\n') { result += '\\n'; continue; }
      if (c === '\r') { result += '\\r'; continue; }
      if (c === '\t') { result += '\\t'; continue; }
      if (code < 0x20) { result += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    }
    result += c;
  }
  return result;
}

// ── Helper: parse JSON from Perplexity with multi-strategy repair ────────────
// Handles trailing commas and unescaped control chars — both common in AI output.
function parsePerplexityJSON(raw) {
  try { return JSON.parse(raw); } catch (_) {}

  const noTrailing = raw.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(noTrailing); } catch (_) {}

  const escaped = escapeStringControlChars(noTrailing);
  try { return JSON.parse(escaped); } catch (e) {
    console.error('[parsePerplexityJSON] fallito dopo repair:', raw.substring(0, 500));
    throw e;
  }
}

// ── Helper: estrae la domanda di engagement dall'ultimo paragrafo del copy ──
function extractEngagementQuestion(postText) {
  const paragraphs = postText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) return null;
  const last = paragraphs[paragraphs.length - 1];
  return last.startsWith('#') ? null : last;
}

// ── ASSET REGISTRY ────────────────────────────────────────
// Modifica qui per aggiungere/cambiare audio, video e path
const ASSETS = {
  paths: {
    audio: '../audio/',
    fonts: '../fonts/',
    video: '../videos/'
  },
  audio: {
    prematch:   ['PP-prematch.mp3',  'DD-Prematch.mp3'],
    live:       ['PP-live.mp3',      'DD-live.mp3'],
    postmatch:  ['PP-postmatch.mp3', 'DD-postmatch.mp3'],
    teaser:     ['PP-prematch.mp3',  'DD-Prematch.mp3'],
    curiosity:  ['PP-prematch.mp3',  'DD-Prematch.mp3'],
    highlights: ['PP-postmatch.mp3', 'DD-postmatch.mp3'],
    group_hl:   ['PP-postmatch.mp3', 'DD-postmatch.mp3']
  },
  video: [
    'Goal-1.mp4',
    'Goal-2.mp4',
    'Goal-3.mp4',
    'Goal-4.mp4',
    '17744356-357E-4282-9F80-38FF0ACD1CAE.MP4',
    '49BEAB38-39A9-48A5-B472-8DE67B67325E.MP4',
    '85162EB6-EDDF-4F59-8128-A0B15E42A85D.MP4',
    '8D4C0E64-5068-4F4C-AF77-CC4FA2918B7C.MP4',
    'C896A2B6-58B5-492C-A21D-72E943058625.MP4',
    'EEE63D49-A15A-4E4A-963A-4F702B733D14.MP4'      
  ]
};

// ── Helper: path asset completi ───────────────────────────
function getAssetPaths(moment) {
  const pool = ASSETS.audio[moment] || ASSETS.audio.prematch;
  const audioFile = pool[Math.floor(Math.random() * pool.length)];
  const videoFile = ASSETS.video[Math.floor(Math.random() * ASSETS.video.length)];
  return {
    audio_src: ASSETS.paths.audio + audioFile,
    video_src: ASSETS.paths.video + videoFile
  };
}

// ── Helper: costruisce URL Railway aggiungendo lo schema se mancante ──
function buildRailwayUrl(path) {
  const base = RAILWAY_PUBLIC_URL;
  if (!base) return '';
  return base.startsWith('http') ? `${base}${path}` : `https://${base}${path}`;
}

// ── Helper: data corrente formattata ──────────────────────
function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ── Helper: timestamp UTC corrente, per i moment live ─────
function nowUtcLabel() {
  const iso = new Date().toISOString();        // "2026-06-17T21:43:07.123Z"
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// ── Helper: genera copy social strutturato via Claude ─────
async function generateCopy(jsonData, moment, teamA, teamB) {
  const momentLabel = {
    prematch:  'PRE-MATCH',
    live:      'LIVE',
    postmatch: 'POST-MATCH',
    teaser:    'TEASER'
  }[moment] || 'PRE-MATCH';

  const copyPrompt = `You are a social media copywriter for PitchPulse, a football analytics brand targeting 18-28 on TikTok and Instagram Reels.

Write a social copy block for this ${momentLabel} card. Use ONLY data from the JSON below.
Tone: high energy, punchy, data-first, never neutral.
IMPORTANT: do NOT use country flag emoji (regional indicator pairs like 🇺🇸 or 🇧🇷) anywhere — they break on Windows. Use other emoji (⚽🔥💥📊) or plain text instead.

Return ONLY the caption body below, no headers, no labels, no extra text, no hashtags.
Use EXACTLY 2 blank lines between each paragraph:

[caption_hook from JSON - STRICTLY max 12 words, punchy, data-first]


[2-3 lines expanding on key stat or cold_fact. Max 40 words. Data-first.]


[1 question to drive comments - e.g. "Who wins this one? Drop your score below"]

JSON:
${JSON.stringify(jsonData, null, 2)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: copyPrompt }]
      })
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (!data.content || !data.content[0]) throw new Error('Claude copy error');
    return formatPostText(data.content[0].text.trim());
  } catch (err) {
    clearTimeout(timeout);
    return jsonData.caption_hook || '';
  }
}

// ── Perplexity: ricerca curiosità WC2026 ─────────────────
async function getCuriosityData(topic) {
  const today = todayISO();
  const assets = getAssetPaths('curiosity');

  const schema = {
    meta: {
      moment:     'curiosity',
      brand:      'PitchPulse',
      version:    '2.0',
      tournament: 'FIFA World Cup 2026',
      audio_src:  assets.audio_src,
      video_src:  assets.video_src
    },
    curiosity: {
      topic:    'FILL_TOPIC_TITLE',
      category: 'FILL_ONE_OF: RECORD / STORIA / NUMERO / LEGGENDA / STATISTICA'
    },
    headline: {
      eyebrow:     'FILL_SHORT_LABEL',
      value:       'FILL_IMPRESSIVE_NUMBER',
      unit:        'FILL_UNIT_OR_NULL',
      description: 'FILL_COMPELLING_CONTEXT_MAX_3_LINES'
    },
    facts: [
      { emoji: 'FILL_EMOJI', label: 'FILL_SHORT_LABEL', text: 'FILL_SURPRISING_FACT_ONE_SENTENCE' },
      { emoji: 'FILL_EMOJI', label: 'FILL_SHORT_LABEL', text: 'FILL_SURPRISING_FACT_ONE_SENTENCE' },
      { emoji: 'FILL_EMOJI', label: 'FILL_SHORT_LABEL', text: 'FILL_SURPRISING_FACT_ONE_SENTENCE' }
    ],
    cold_fact: {
      emoji: 'FILL_EMOJI',
      label: 'DID YOU KNOW',
      text:  'FILL_MOST_SHOCKING_FACT_ONE_SENTENCE'
    },
    caption_hook: 'FILL_STRICTLY_MAX_12_WORDS_PUNCHY_DATA_FIRST',
    hashtags: {
      topic:            `#${topic.replace(/\s/g, '')}`,
      tournament:       '#WorldCup2026 #WC2026',
      brand_pitchpulse: '#PitchPulse',
      generic:          '#Football #Soccer #FIFA #WC2026facts'
    }
  };

  const curiosityInstructions = fillTemplate(PPL_INSTRUCTIONS.curiosity, {
    TOPIC: topic,
    TODAY: today
  });

  const prompt = [
    ...linesOf(curiosityInstructions),
    JSON.stringify(schema, null, 2)
  ].join('\n');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000
    })
  });

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('Perplexity error: ' + JSON.stringify(data));
  }

  let text = data.choices[0].message.content;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Nessun JSON trovato (curiosity). Risposta: ' + text.substring(0, 200));
  }

  try {
    return { data: parsePerplexityJSON(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity/curiosity] JSON non valido:', jsonMatch[0].substring(0, 500));
    throw new Error('JSON Perplexity curiosity non parsabile: ' + parseErr.message);
  }
}

// ── Handler curiosity ─────────────────────────────────────
async function handleCuriosity(ctx) {
  const topic = ctx.message.text.replace(/^\/curiosity(?:@\S+)?\s*/i, '').trim();
  if (!topic) return ctx.reply('Formato: /curiosity World Cup 2026\nEsempi: /curiosity Brazil | /curiosity Group A | /curiosity Mbappe');

  const slug = topic.replace(/\s/g, '').substring(0, 12).toUpperCase();
  const projectName = `curiosity-${slug}-${Date.now()}`;

  await ctx.reply(`🤯 *CURIOSITY* — ${topic}\nAvvio pipeline...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('🔍 Ricercando curiosità...');
    const { data: jsonData, promptUsed } = await getCuriosityData(topic);

    await ctx.reply('🎨 Generando HTML e copy...');

    const copyPrompt = `You are a social media copywriter for PitchPulse, a football analytics brand targeting 18-28 on TikTok and Instagram Reels.

Write a social copy block for this CURIOSITY card about: "${topic}". Use ONLY data from the JSON below.
Tone: mind-blowing, punchy, data-first, never neutral.
IMPORTANT: do NOT use country flag emoji (regional indicator pairs like 🇺🇸 or 🇧🇷) anywhere — they break on Windows. Use other emoji (⚽🔥💥📊🧠) or plain text instead.

Return ONLY the caption body below, no headers, no labels, no extra text, no hashtags.
Use EXACTLY 2 blank lines between each paragraph:

[caption_hook from JSON - STRICTLY max 12 words]


[2-3 lines expanding on the most shocking fact. Max 40 words. Data-first.]


[1 CTA - e.g. "Follow @PitchPulse for more WC2026 facts"]

JSON:
${JSON.stringify(jsonData, null, 2)}`;

    const postText = await (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: copyPrompt }]
          })
        });
        clearTimeout(timeout);
        const data = await res.json();
        if (!data.content || !data.content[0]) throw new Error('Claude copy error');
        return formatPostText(data.content[0].text.trim());
      } catch (err) {
        clearTimeout(timeout);
        return jsonData.caption_hook || '';
      }
    })();
    jsonData.engagement_question = extractEngagementQuestion(postText) || null;

    const { html, claudePayload } = await generateHTML(jsonData, 'curiosity');

    await ctx.reply('🎬 Avviando render...');
    const callbackUrl = buildRailwayUrl('/callback');

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\`\nPronto in circa 3 minuti`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Errore GitHub Actions');
    }
  } catch (err) {
    console.error('[curiosity] Error:', err.message);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      await ctx.reply('⏱ Timeout. Riprova con /curiosity');
    } else {
      await ctx.reply(`❌ Errore: ${err.message}`);
    }
  }
}

// ── Perplexity: ricerca dati match ────────────────────────
async function getMatchData(teamA, teamB, moment) {
  const momentLabel = {
    prematch:  'PRE-MATCH preview',
    live:      'LIVE match current score and stats',
    postmatch: 'POST-MATCH final result',
    teaser:    'tournament teaser'
  }[moment] || 'PRE-MATCH';

  const codeA     = teamA.replace(/\s/g, '').substring(0, 3).toUpperCase();
  const codeB     = teamB.replace(/\s/g, '').substring(0, 3).toUpperCase();
  const hashMatch = `#${teamA.replace(/\s/g, '')}vs${teamB.replace(/\s/g, '')}`;
  const today     = todayISO();
  const nowUtc    = nowUtcLabel();
  const assets    = getAssetPaths(moment);

  const schema = {
    meta: {
      moment,
      brand:      'PitchPulse',
      version:    '2.0',
      tournament: 'FIFA World Cup 2026',
      audio_src:  assets.audio_src,
      video_src:  assets.video_src
    },
    match: {
      team_a:        { name: 'FILL_FULL_NAME', code: codeA, flag_emoji: 'FILL_EMOJI' },
      team_b:        { name: 'FILL_FULL_NAME', code: codeB, flag_emoji: 'FILL_EMOJI' },
      phase:         'FILL_REAL_PHASE',
      matchday:      'FILL_MD1_OR_MD2_OR_MD3',
      kickoff_utc:   'FILL_REAL_KICKOFF_UTC',
      kickoff_local: 'FILL_REAL_KICKOFF_LOCAL',
      venue:         'FILL_REAL_VENUE',
      city:          'FILL_REAL_CITY'
    },
    headline: {
      eyebrow:     'FILL_SHORT_LABEL',
      value:       'FILL_NUMBER',
      unit:        'FILL_UNIT_OR_NULL',
      description: 'FILL_REAL_CONTEXT'
    },
    stats: moment === 'live' ? [
      { label: 'POSSESSION',       value: 'FILL_XX_PCT_VS_YY_PCT', context: 'FILL' },
      { label: 'SHOTS ON TARGET',  value: 'FILL_X_VS_Y',           context: 'FILL' },
      { label: 'FILL_CORNERS_FOULS_OR_XG', value: 'FILL',          context: 'FILL' }
    ] : [
      { label: 'FILL', value: 'FILL', context: 'FILL' },
      { label: 'FILL', value: 'FILL', context: 'FILL' },
      { label: 'FILL', value: 'FILL', context: 'FILL' }
    ],
    H2H: {
      team_a_wins:    'FILL_REAL_OR_0',
      draws:          'FILL_REAL_OR_0',
      team_b_wins:    'FILL_REAL_OR_0',
      last_meeting:   'FILL_DATE_SCORE_COMPETITION_OR_NULL',
      total_meetings: 'FILL_REAL_OR_0'
    },
    cold_fact: {
      emoji: 'FILL_EMOJI',
      label: 'DID YOU KNOW',
      text:  'FILL_REAL_SURPRISING_FACT'
    },
    player_watch: {
      name: 'FILL_REAL_PLAYER',
      team: codeA,
      stat: 'FILL_REAL_STAT_ONE_SENTENCE'
    },
    mvp:           moment === 'postmatch' ? { name: 'FILL_REAL_PLAYER', team: 'FILL_CODE', reason: 'FILL_ONE_SENTENCE_WHY' } : null,
    cold_verdict:  moment === 'postmatch' ? 'FILL_ONE_SENTENCE_VERDICT_ON_THE_MATCH' : null,
    record_broken: moment === 'postmatch' ? 'FILL_REAL_RECORD_TEXT_OR_null_IF_NONE' : null,
    next_match:    moment === 'postmatch' ? 'FILL_NEXT_PHASE_OPPONENT_DATE_OR_null_IF_FINAL' : null,
    match_status:  moment === 'live' ? 'FILL_not_started_OR_live_OR_halftime_OR_finished' : null,
    score_a:       (moment === 'live' || moment === 'postmatch') ? 'FILL_REAL_INTEGER' : null,
    score_b:       (moment === 'live' || moment === 'postmatch') ? 'FILL_REAL_INTEGER' : null,
    minute:        moment === 'live' ? 'FILL_REAL_MINUTE_OR_HT_OR_FT' : (moment === 'postmatch' ? 'FT' : null),
    source_note:   moment === 'live' ? 'FILL_SOURCE_NAME_AND_TIMESTAMP_OR_MINUTE_REPORTED' : null,
    key_events:    moment === 'live' ? [] : null,
    caption_hook:  'FILL_STRICTLY_MAX_12_WORDS_PUNCHY_DATA_FIRST',
    hashtags: {
      match:            hashMatch,
      tournament:       '#WorldCup2026 #WC2026',
      brand_pitchpulse: '#PitchPulse',
      generic:          '#Football #Soccer #FIFA'
    }
  };

  const momentInstructions = fillTemplate(PPL_INSTRUCTIONS[moment] || '', {
    NOW_UTC: nowUtc,
    TODAY:   today,
    TEAM_A:  teamA,
    TEAM_B:  teamB
  });

  const commonInstructions = PPL_INSTRUCTIONS.common;

  const prompt = [
    `FIFA World Cup 2026 - ${momentLabel}: ${teamA} vs ${teamB}.`,
    `Today is ${today}. Research REAL verified data from the web.`,
    ...linesOf(momentInstructions),
    ...linesOf(commonInstructions),
    JSON.stringify(schema, null, 2)
  ].join('\n');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000
    })
  });

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('Perplexity error: ' + JSON.stringify(data));
  }

  let text = data.choices[0].message.content;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Nessun JSON trovato nella risposta Perplexity. Risposta: ' + text.substring(0, 200));
  }

  try {
    return { data: parsePerplexityJSON(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity] JSON non valido:', jsonMatch[0].substring(0, 500));
    throw new Error('JSON Perplexity non parsabile: ' + parseErr.message);
  }
}

// ── Perplexity: ricerca risultati giornata ────────────────
async function getHighlightsData(matchday) {
  const today = todayISO();
  const nowUtc = nowUtcLabel();
  const assets = getAssetPaths('highlights');

  const schema = {
    meta: {
      moment:     'highlights',
      brand:      'PitchPulse',
      version:    '2.0',
      tournament: 'FIFA World Cup 2026',
      audio_src:  assets.audio_src,
      video_src:  assets.video_src
    },
    day: {
      matchday: 'FILL_MD1_OR_MD2_OR_MD3_OR_R32_ETC',
      date:     'FILL_DATE_DD_MONTH_YYYY',
      label:    'FILL_LABEL_E.G._GROUP_STAGE_DAY_1'
    },
    headline: {
      eyebrow:     'FILL_E.G._GOALS_TODAY',
      value:       'FILL_TOTAL_GOALS_NUMBER',
      unit:        'FILL_E.G._GOALS',
      description: 'FILL_ONE_LINE_SUMMARY_OF_THE_DAY'
    },
    matches: [
      {
        team_a:      { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        team_b:      { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        score_a:     'FILL_REAL_INTEGER_OR_null_IF_NS',
        score_b:     'FILL_REAL_INTEGER_OR_null_IF_NS',
        status:      'FILL_FT_OR_LIVE_OR_NS',
        highlight:   'FILL_KEY_MOMENT_MAX_8_WORDS_OR_NULL'
      }
    ],
    top_scorer: {
      name:   'FILL_PLAYER_NAME_OR_NULL',
      team:   'FILL_TEAM_CODE_OR_NULL',
      goals:  'FILL_REAL_INTEGER_OR_null_IF_NONE',
      detail: 'FILL_ONE_LINE_STAT_OR_NULL'
    },
    cold_fact: {
      emoji: 'FILL_EMOJI',
      label: 'DID YOU KNOW',
      text:  'FILL_MOST_INTERESTING_FACT_ABOUT_TODAY'
    },
    caption_hook: 'FILL_STRICTLY_MAX_12_WORDS_PUNCHY_DATA_FIRST',
    hashtags: {
      matchday:         `#WC2026${matchday.replace(/\s/g, '')}`,
      tournament:       '#WorldCup2026 #WC2026',
      brand_pitchpulse: '#PitchPulse',
      generic:          '#Football #Soccer #FIFA #MatchDay'
    }
  };

  const highlightsInstructions = fillTemplate(PPL_INSTRUCTIONS.highlights, {
    MATCHDAY: matchday,
    NOW_UTC:  nowUtc,
    TODAY:    today
  });

  const prompt = [
    ...linesOf(highlightsInstructions),
    JSON.stringify(schema, null, 2)
  ].join('\n');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('Perplexity error: ' + JSON.stringify(data));
  }

  let text = data.choices[0].message.content;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Nessun JSON trovato (highlights). Risposta: ' + text.substring(0, 200));
  }

  try {
    return { data: parsePerplexityJSON(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity/highlights] JSON non valido:', jsonMatch[0].substring(0, 500));
    throw new Error('JSON Perplexity highlights non parsabile: ' + parseErr.message);
  }
}

// ── Handler highlights ────────────────────────────────────
async function handleHighlights(ctx) {
  const input = ctx.message.text.replace(/^\/highlights(?:@\S+)?\s*/i, '').trim();
  if (!input) return ctx.reply('Formato: /highlights MD1\nEsempi: /highlights MD1 | /highlights MD3 | /highlights 2026-06-16');

  const slug = input.replace(/\s/g, '').substring(0, 8).toUpperCase();
  const projectName = `highlights-${slug}-${Date.now()}`;

  await ctx.reply(`📊 *HIGHLIGHTS* — ${input}\nAvvio pipeline...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('🔍 Raccogliendo risultati...');
    const { data: jsonData, promptUsed } = await getHighlightsData(input);

    await ctx.reply('🎨 Generando HTML e copy...');

    const copyPrompt = `You are a social media copywriter for PitchPulse, a football analytics brand targeting 18-28 on TikTok and Instagram Reels.

Write a social copy block for this HIGHLIGHTS recap. Use ONLY data from the JSON below.
Tone: high energy, punchy, data-first, never neutral.
IMPORTANT: do NOT use country flag emoji (regional indicator pairs like 🇺🇸 or 🇧🇷) anywhere — they break on Windows. Use other emoji (⚽🔥💥📊) or plain text instead.

Return ONLY the caption body below, no headers, no labels, no extra text, no hashtags.
Use EXACTLY 2 blank lines between each paragraph:

[caption_hook from JSON - STRICTLY max 12 words]


[List all results as: TeamA score-score TeamB (plain text, NO emoji flags — flag emoji break on Windows)]
[1 line on top scorer if not null]


[1 CTA - e.g. "Follow @PitchPulse for every result 👇"]

JSON:
${JSON.stringify(jsonData, null, 2)}`;

    const postText = await (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: copyPrompt }]
          })
        });
        clearTimeout(timeout);
        const data = await res.json();
        if (!data.content || !data.content[0]) throw new Error('Claude copy error');
        return formatPostText(data.content[0].text.trim());
      } catch (err) {
        clearTimeout(timeout);
        return jsonData.caption_hook || '';
      }
    })();
    jsonData.engagement_question = extractEngagementQuestion(postText) || null;

    const { html, claudePayload } = await generateHTML(jsonData, 'highlights');

    await ctx.reply('🎬 Avviando render...');
    const callbackUrl = buildRailwayUrl('/callback');

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Errore GitHub Actions');
    }
  } catch (err) {
    console.error('[highlights] Error:', err.message);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      await ctx.reply('⏱ Timeout. Riprova con /highlights');
    } else {
      await ctx.reply(`❌ Errore: ${err.message}`);
    }
  }
}

// ── Perplexity: ricerca stato girone ─────────────────────
async function getGroupHlData(group) {
  const today  = todayISO();
  const nowUtc = nowUtcLabel();
  const assets = getAssetPaths('group_hl');

  const schema = {
    meta: {
      moment:     'group_hl',
      brand:      'PitchPulse',
      version:    '2.0',
      tournament: 'FIFA World Cup 2026',
      audio_src:  assets.audio_src,
      video_src:  assets.video_src
    },
    group: {
      name:     'FILL_E.G._GROUP_A',
      matchday: 'FILL_MD1_OR_MD2_OR_MD3',
      stage:    'FILL_E.G._GROUP_STAGE_MATCHDAY_1'
    },
    standings: [
      { pos: 1, team: { name: 'FILL_FULL_NAME', code: 'FILL_3_LETTER', flag_emoji: 'FILL_EMOJI' }, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 },
      { pos: 2, team: { name: 'FILL_FULL_NAME', code: 'FILL_3_LETTER', flag_emoji: 'FILL_EMOJI' }, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 },
      { pos: 3, team: { name: 'FILL_FULL_NAME', code: 'FILL_3_LETTER', flag_emoji: 'FILL_EMOJI' }, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 },
      { pos: 4, team: { name: 'FILL_FULL_NAME', code: 'FILL_3_LETTER', flag_emoji: 'FILL_EMOJI' }, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 }
    ],
    played_matches: [
      {
        team_a:    { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        team_b:    { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        score_a:   'FILL_REAL_INTEGER',
        score_b:   'FILL_REAL_INTEGER',
        highlight: 'FILL_KEY_MOMENT_MAX_8_WORDS_OR_NULL'
      }
    ],
    upcoming_matches: [
      {
        team_a:        { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        team_b:        { name: 'FILL_FULL_NAME', code: 'FILL_CODE', flag_emoji: 'FILL_EMOJI' },
        matchday:      'FILL_MD2_OR_MD3',
        kickoff_local: 'FILL_DATE_TIME_TZ'
      }
    ],
    cold_fact: {
      emoji: 'FILL_EMOJI',
      label: 'DID YOU KNOW',
      text:  'FILL_MOST_INTERESTING_GROUP_FACT_ONE_SENTENCE'
    },
    caption_hook: 'FILL_STRICTLY_MAX_12_WORDS_PUNCHY_DATA_FIRST',
    hashtags: {
      group:            `#WC2026${group.replace(/\s/g, '')}`,
      tournament:       '#WorldCup2026 #WC2026',
      brand_pitchpulse: '#PitchPulse',
      generic:          '#Football #Soccer #FIFA #GroupStage'
    }
  };

  const groupHlInstructions = fillTemplate(PPL_INSTRUCTIONS.group_hl, {
    GROUP:   group,
    NOW_UTC: nowUtc,
    TODAY:   today
  });

  const prompt = [
    ...linesOf(groupHlInstructions),
    JSON.stringify(schema, null, 2)
  ].join('\n');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model:      'sonar-pro',
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('Perplexity error: ' + JSON.stringify(data));
  }

  let text = data.choices[0].message.content;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Nessun JSON trovato (group_hl). Risposta: ' + text.substring(0, 200));
  }

  try {
    return { data: parsePerplexityJSON(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity/group_hl] JSON non valido:', jsonMatch[0].substring(0, 500));
    throw new Error('JSON Perplexity group_hl non parsabile: ' + parseErr.message);
  }
}

// ── Handler group_hl ──────────────────────────────────────
async function handleGroupHl(ctx) {
  const input = ctx.message.text.replace(/^\/group_hl(?:@\S+)?\s*/i, '').trim();
  if (!input) return ctx.reply('Formato: /group_hl Group A\nEsempi: /group_hl Group A | /group_hl Group C | /group_hl Group L');

  const slug = input.replace(/\s/g, '').substring(0, 8).toUpperCase();
  const projectName = `group_hl-${slug}-${Date.now()}`;

  await ctx.reply(`📊 *GROUP HIGHLIGHTS* — ${input}\nAvvio pipeline...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('🔍 Raccogliendo dati girone...');
    const { data: jsonData, promptUsed } = await getGroupHlData(input);

    await ctx.reply('🎨 Generando HTML e copy...');

    const copyPrompt = `You are a social media copywriter for PitchPulse, a football analytics brand targeting 18-28 on TikTok and Instagram Reels.

Write a social copy block for this GROUP HIGHLIGHTS card. Use ONLY data from the JSON below.
Tone: high energy, punchy, data-first, never neutral.
IMPORTANT: do NOT use country flag emoji (regional indicator pairs like 🇲🇽 or 🇰🇷) anywhere — they break on Windows. Use other emoji (⚽🔥💥📊) or plain text instead.

Return ONLY the caption body below, no headers, no labels, no extra text, no hashtags.
Use EXACTLY 2 blank lines between each paragraph:

[caption_hook from JSON - STRICTLY max 12 words]


[Standings snapshot: 1. Code Xpts | 2. Code Xpts | 3. Code Xpts | 4. Code Xpts — plain text ONLY, NO emoji flags]
[1 line on the most notable played match result or cold_fact]


[1 CTA - e.g. "Follow @PitchPulse for every group update 📊"]

JSON:
${JSON.stringify(jsonData, null, 2)}`;

    const postText = await (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key':          ANTHROPIC_API_KEY,
            'anthropic-version':  '2023-06-01',
            'Content-Type':       'application/json'
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5',
            max_tokens: 1000,
            messages:   [{ role: 'user', content: copyPrompt }]
          })
        });
        clearTimeout(timeout);
        const data = await res.json();
        if (!data.content || !data.content[0]) throw new Error('Claude copy error');
        return formatPostText(data.content[0].text.trim());
      } catch (err) {
        clearTimeout(timeout);
        return jsonData.caption_hook || '';
      }
    })();
    jsonData.engagement_question = extractEngagementQuestion(postText) || null;

    const { html, claudePayload } = await generateHTML(jsonData, 'group_hl');

    await ctx.reply('🎬 Avviando render...');
    const callbackUrl = buildRailwayUrl('/callback');

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Errore GitHub Actions');
    }
  } catch (err) {
    console.error('[group_hl] Error:', err.message);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      await ctx.reply('⏱ Timeout. Riprova con /group_hl');
    } else {
      await ctx.reply(`❌ Errore: ${err.message}`);
    }
  }
}

// ── Claude: genera HTML ───────────────────────────────────
async function generateHTML(jsonData, moment) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${moment}\n${JSON.stringify(jsonData, null, 2)}` }]
      })
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (!data.content || !data.content[0]) throw new Error('Claude error: ' + JSON.stringify(data));
    let html = data.content[0].text;
    html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '').trim();
    const claudePayload = `MOMENT: ${moment}\n\nJSON INVIATO A CLAUDE:\n${JSON.stringify(jsonData, null, 2)}`;
    return { html, claudePayload };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── GitHub Actions: trigger render ───────────────────────
async function triggerRender(html, projectName, callbackUrl, postText, promptPerplexity, promptClaude) {
  const htmlBase64         = Buffer.from(html).toString('base64');
  const postTextBase64     = postText         ? Buffer.from(postText).toString('base64')         : '';
  const promptPplBase64    = promptPerplexity ? Buffer.from(promptPerplexity).toString('base64') : '';
  const promptClaudeBase64 = promptClaude     ? Buffer.from(promptClaude).toString('base64')     : '';

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/render.yml/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        html:              htmlBase64,
        project:           projectName,
        post_text:         postTextBase64,
        prompt_perplexity: promptPplBase64,
        prompt_claude:     promptClaudeBase64,
        callback_url:      callbackUrl || ''
      }
    })
  });
  if (res.status !== 204) console.error(`[triggerRender] GitHub Actions status: ${res.status} per ${projectName}`);
  return res.status === 204;
}

// ── Handler principale match ──────────────────────────────
async function handleMoment(ctx, moment) {
  const text = ctx.message.text.replace(new RegExp(`^\\/${moment}(?:@\\S+)?\\s*`, 'i'), '').trim();
  const match = text.match(/(.+?)\s+vs\s+(.+)/i);
  if (!match) return ctx.reply(`Formato: /${moment} Brazil vs Argentina`);

  const teamA = match[1].trim();
  const teamB = match[2].trim();
  const tsA = teamA.replace(/\s/g, '').substring(0, 3).toUpperCase();
  const tsB = teamB.replace(/\s/g, '').substring(0, 3).toUpperCase();
  const projectName = `${moment}-${tsA}vs${tsB}-${Date.now()}`;
  const emoji = { prematch: '⚽', live: '🔴', postmatch: '🏆', teaser: '🔮' }[moment];
  const label = { prematch: 'PRE-MATCH', live: 'LIVE', postmatch: 'POST-MATCH', teaser: 'TEASER' }[moment];

  await ctx.reply(`${emoji} *${label}* - ${teamA} vs ${teamB}\nAvvio pipeline...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('📊 Raccogliendo dati...');
    const { data: jsonData, promptUsed } = await getMatchData(teamA, teamB, moment);

    await ctx.reply('🎨 Generando copy...');
    const postText = await generateCopy(jsonData, moment, teamA, teamB);
    jsonData.engagement_question = extractEngagementQuestion(postText) || null;

    await ctx.reply('🎨 Generando HTML...');
    const { html, claudePayload } = await generateHTML(jsonData, moment);

    await ctx.reply('🎬 Avviando render...');
    const callbackUrl = buildRailwayUrl('/callback');

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Errore GitHub Actions');
    }
  } catch (err) {
    console.error(`[${moment}] Error:`, err.message);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      await ctx.reply(`⏱ Timeout Claude. Riprova con /${moment}`);
    } else {
      await ctx.reply(`❌ Errore: ${err.message}`);
    }
  }
}

// ── Batch handler ────────────────────────────────────────
const BATCH_MAX_JOBS = 10;
const BATCH_DELAY_MS = 10000;
const VALID_MOMENTS = ['prematch', 'live', 'postmatch', 'teaser'];

// Stato batch attivo (uno alla volta)
let batchState = null; // { chatId, total, done, stopped }

async function runBatchJobs(jobs, chatId) {
  for (let i = 0; i < jobs.length; i++) {
    if (batchState && batchState.stopped) {
      await bot.telegram.sendMessage(chatId,
        `🛑 *Batch interrotto* dopo ${i}/${jobs.length} job avviati.`,
        { parse_mode: 'Markdown' });
      return;
    }

    if (batchState) batchState.done = i;

    const job = jobs[i];
    const label = (job.moment === 'highlights' || job.moment === 'group_hl')
      ? `${job.moment} ${job.query}`
      : `${job.moment} ${job.teamA} vs ${job.teamB}`;

    await bot.telegram.sendMessage(chatId,
      `▶️ *Job ${i + 1}/${jobs.length}:* ${label.replace(/_/g, '\\_')}`,
      { parse_mode: 'Markdown' });

    const replyFn = (text, opts) => bot.telegram.sendMessage(chatId, text, opts);

    try {
      if (job.moment === 'highlights') {
        await handleHighlights({
          message: { text: `/highlights ${job.query}` },
          reply: replyFn,
        });
      } else if (job.moment === 'group_hl') {
        await handleGroupHl({
          message: { text: `/group_hl ${job.query}` },
          reply: replyFn,
        });
      } else {
        await handleMoment({
          message: { text: `/${job.moment} ${job.teamA} vs ${job.teamB}` },
          reply: replyFn,
        }, job.moment);
      }
    } catch (err) {
      await bot.telegram.sendMessage(chatId, `❌ Job ${i + 1} fallito: ${err.message}`);
    }

    if (i < jobs.length - 1 && batchState && !batchState.stopped) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  if (batchState && !batchState.stopped) {
    await bot.telegram.sendMessage(chatId,
      `✅ *Batch completato:* ${jobs.length}/${jobs.length} job avviati`,
      { parse_mode: 'Markdown' });
  }
}

async function handleBatch(ctx) {
  const rawText = ctx.message.text.replace(/^\/batch(?:@\S+)?\s*/i, '').trim();
  if (!rawText) {
    return ctx.reply(
      '*Formato /batch:*\n```\nprematch Brazil vs Argentina\nlive France vs England\npostmatch Spain vs Germany\nhighlights MD1\ngroup_hl Group A\ngroup_hl Group C\n```\n(max 10 righe, una per riga)\nUsa /batchstop per fermare.',
      { parse_mode: 'Markdown' }
    );
  }

  if (batchState) {
    return ctx.reply('⚠️ Batch già in corso. Usa /batchstop per fermarlo prima di avviarne uno nuovo.');
  }

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length > BATCH_MAX_JOBS) {
    return ctx.reply(`❌ Batch troppo grande: ${lines.length} righe (max ${BATCH_MAX_JOBS}). Riduci e riprova.`);
  }

  const jobs = [];
  const invalidLines = [];

  for (const line of lines) {
    const hm = line.match(/^highlights\s+(.+)$/i);
    if (hm) {
      jobs.push({ moment: 'highlights', query: hm[1].trim() });
      continue;
    }
    const ghm = line.match(/^group_hl\s+(.+)$/i);
    if (ghm) {
      jobs.push({ moment: 'group_hl', query: ghm[1].trim() });
      continue;
    }
    const m = line.match(/^(\w+)\s+(.+?)\s+vs\s+(.+)$/i);
    if (!m) { invalidLines.push(`• \`${line}\` — formato non valido`); continue; }
    const moment = m[1].toLowerCase();
    const teamA = m[2].trim();
    const teamB = m[3].trim();
    if (!VALID_MOMENTS.includes(moment)) {
      invalidLines.push(`• \`${line}\` — moment "${moment}" non valido (usa: ${VALID_MOMENTS.join(', ')}, highlights <MD>, group\\_hl <Group X>)`);
      continue;
    }
    jobs.push({ moment, teamA, teamB });
  }

  if (jobs.length === 0) {
    const errMsg = invalidLines.length > 0
      ? `❌ Nessuna riga valida:\n${invalidLines.join('\n')}`
      : '❌ Nessuna riga valida nel batch.';
    return ctx.reply(errMsg, { parse_mode: 'Markdown' });
  }

  let summary = `🚀 *Batch avviato:* ${jobs.length} job${jobs.length > 1 ? 's' : ''} in sequenza`;
  if (invalidLines.length > 0) {
    summary += `\n⚠️ ${invalidLines.length} riga${invalidLines.length > 1 ? 'e' : ''} ignorata${invalidLines.length > 1 ? 'e' : ''}:\n${invalidLines.join('\n')}`;
  }
  summary += '\n\nUsa /batchstop per interrompere.';
  await ctx.reply(summary, { parse_mode: 'Markdown' });

  const chatId = ctx.chat.id;
  batchState = { chatId, total: jobs.length, done: 0, stopped: false };

  // Stacca il loop dal webhook handler: Telegram ha timeout ~60s,
  // il batch dura minuti — senza setImmediate Telegram fa retry
  // avviando batch concorrenti.
  setImmediate(async () => {
    try {
      await runBatchJobs(jobs, chatId);
    } catch (err) {
      console.error('[batch] Unexpected error:', err.message);
      await bot.telegram.sendMessage(chatId, `❌ Errore batch: ${err.message}`).catch(() => {});
    } finally {
      batchState = null;
    }
  });
}

async function handleBatchStop(ctx) {
  if (!batchState) {
    return ctx.reply('ℹ️ Nessun batch in corso.');
  }
  batchState.stopped = true;
  await ctx.reply(
    `🛑 *Stop richiesto.* Il batch si ferma dopo il job corrente (${batchState.done + 1}/${batchState.total}).`,
    { parse_mode: 'Markdown' }
  );
}

// ── Metricool Bridge: Dropbox helpers ────────────────────

let _dbxToken = { value: null, expiry: 0 };
let _dbxTokenRefreshPromise = null;

async function getDropboxAccessToken() {
  if (_dbxToken.value && Date.now() < _dbxToken.expiry) return _dbxToken.value;
  // Evita doppio refresh concorrente: se c'è già un refresh in corso, aspetta quello
  if (_dbxTokenRefreshPromise) return _dbxTokenRefreshPromise;
  _dbxTokenRefreshPromise = (async () => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: process.env.DBX_REFRESH_TOKEN,
            client_id: process.env.DBX_APP_KEY,
            client_secret: process.env.DBX_APP_SECRET
          })
        });
        const data = await res.json();
        if (!data.access_token) throw new Error('Dropbox token refresh failed: ' + JSON.stringify(data));
        _dbxToken = { value: data.access_token, expiry: Date.now() + 55 * 60 * 1000 };
        return data.access_token;
      } catch (e) {
        if (attempt === maxAttempts) throw e;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  })().finally(() => { _dbxTokenRefreshPromise = null; });
  return _dbxTokenRefreshPromise;
}

async function readCaptionFromDropbox(projectName) {
  try {
    const token = await getDropboxAccessToken();
    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `/${projectName}/post.txt` }),
        'Content-Type': 'text/plain'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.replace(/^﻿/, ''); // strip UTF-8 BOM
  } catch (e) {
    console.error('[dropbox] readCaption error:', e.message);
    return '';
  }
}

function toDirectDownloadUrl(url) {
  const u = new URL(url);
  u.searchParams.set('dl', '1');
  return u.toString();
}

async function getDropboxShareLink(projectName) {
  try {
    const token = await getDropboxAccessToken();
    const filePath = `/${projectName}/${projectName}.mp4`;

    // Check if a shared link already exists
    const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, direct_only: true })
    });
    const listData = await listRes.json();
    if (listData.links && listData.links.length > 0) {
      return toDirectDownloadUrl(listData.links[0].url);
    }

    // Create new public shared link
    const createRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, settings: { requested_visibility: { '.tag': 'public' } } })
    });
    const createData = await createRes.json();
    if (createData.url) return toDirectDownloadUrl(createData.url);

    // Handle "link already exists" race condition — two sub-types:
    // "metadata" includes the URL in the error body; "default" does not.
    // In both cases the safe path is to re-query list_shared_links.
    if (createData.error && createData.error['.tag'] === 'shared_link_already_exists') {
      const meta = createData.error.shared_link_already_exists?.metadata;
      if (meta && meta.url) return toDirectDownloadUrl(meta.url);
      // "default" sub-type: re-fetch the existing link
      const retryRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, direct_only: true })
      });
      const retryData = await retryRes.json();
      if (retryData.links && retryData.links.length > 0) return toDirectDownloadUrl(retryData.links[0].url);
    }

    // Fallback: team accounts may reject 'public' visibility — try without visibility restriction
    if (createData.error) {
      console.error('[dropbox] shareLink create error (public):', JSON.stringify(createData.error));
      const fallbackRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      const fallbackData = await fallbackRes.json();
      if (fallbackData.url) return toDirectDownloadUrl(fallbackData.url);
      if (fallbackData.error && fallbackData.error['.tag'] === 'shared_link_already_exists') {
        const retryRes2 = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, direct_only: true })
        });
        const retryData2 = await retryRes2.json();
        if (retryData2.links && retryData2.links.length > 0) return toDirectDownloadUrl(retryData2.links[0].url);
      }
      console.error('[dropbox] shareLink fallback error:', JSON.stringify(fallbackData.error || fallbackData));
    }
    return null;
  } catch (e) {
    console.error('[dropbox] shareLink error:', e.message);
    return null;
  }
}

// ── Metricool CSV generation ──────────────────────────────

function csvField(value) {
  const str = (value === null || value === undefined) ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function generateMetricoolCSV(items) {
  const headers = [
    'Text', 'Date', 'Time', 'Draft',
    'Facebook', 'Twitter', 'LinkedIn', 'Instagram', 'Pinterest', 'TikTok', 'Youtube', 'Threads', 'Bluesky',
    'Picture Url 1', 'Picture Url 2', 'Picture Url 3', 'Picture Url 4', 'Picture Url 5',
    'Picture Url 6', 'Picture Url 7', 'Picture Url 8', 'Picture Url 9', 'Picture Url 10',
    'Instagram publish as', 'Brand name'
  ];

  const rows = items.map(item => {
    const entry = outputStore.get(item.projectId);
    if (!entry) return null;
    return [
      csvField(entry.caption),
      csvField(item.date),
      csvField(item.time),
      'FALSE',
      'FALSE', 'FALSE', 'FALSE',
      item.instagram ? 'TRUE' : 'FALSE',
      'FALSE',
      item.tiktok ? 'TRUE' : 'FALSE',
      'FALSE', 'FALSE', 'FALSE',
      csvField(entry.shareLink || ''),
      '', '', '', '', '', '', '', '', '',
      item.instagram ? 'REEL' : '',
      'PitchPulse'
    ].join(',');
  }).filter(Boolean);

  return [headers.join(','), ...rows].join('\r\n');
}

// ── Callback render completato ────────────────────────────
app.post('/callback', async (req, res) => {
  const { status, project, dropbox } = req.body;
  try {
    if (status === 'ok') {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID,
        `✅ *Render completato!*\n📁 \`${project}\`\n☁️ \`${dropbox}\``,
        { parse_mode: 'Markdown' });

      const entry = { project, dropbox, caption: '', shareLink: null, timestamp: new Date().toISOString() };
      outputStore.set(project, entry);
      saveStore();

      // Enrich async (non-blocking): read caption + generate share link
      Promise.all([readCaptionFromDropbox(project), getDropboxShareLink(project)])
        .then(([caption, shareLink]) => { entry.caption = caption; entry.shareLink = shareLink; saveStore(); })
        .catch(e => console.error('[callback] enrich error:', e.message));

    } else {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID,
        `❌ *Render fallito:* \`${project}\``,
        { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error('Callback error:', e.message); }
  res.json({ ok: true });
});

// ── Metricool Bridge: Dashboard & API ────────────────────

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/outputs', (req, res) => {
  const list = Array.from(outputStore.values())
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(list);
});

app.post('/api/outputs/:id/refresh-caption', async (req, res) => {
  const entry = outputStore.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const caption = await readCaptionFromDropbox(entry.project);
  entry.caption = caption;
  if (caption) saveStore();
  res.json({ caption });
});

app.post('/api/outputs/:id/refresh-link', async (req, res) => {
  const entry = outputStore.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const shareLink = await getDropboxShareLink(entry.project);
  entry.shareLink = shareLink;
  if (shareLink) saveStore();
  res.json({ shareLink });
});

app.post('/api/export-csv', async (req, res) => {
  const { items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });
  const csv = generateMetricoolCSV(items);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pitchpulse-metricool-${Date.now()}.csv"`);
  res.send('﻿' + csv); // UTF-8 BOM for Excel compatibility
});

app.get('/health', (req, res) => res.json({ ok: true, bot: 'PitchPulse' }));

// ── Comandi bot ───────────────────────────────────────────
bot.command('start', (ctx) => ctx.reply(
  '*PitchPulse Bot* attivo!\n\n⚽ /prematch Brazil vs Argentina\n🔴 /live Brazil vs Argentina\n🏆 /postmatch Brazil vs Argentina\n🔮 /teaser Brazil vs Argentina\n🤯 /curiosity World Cup 2026\n📊 /highlights MD1\n🗂 /group_hl Group A\n📋 /batch [vedi /help per formato]\n🛑 /batchstop — ferma il batch in corso',
  { parse_mode: 'Markdown' }
));
bot.command('help', (ctx) => ctx.reply(
  '*Comandi:*\n\n⚽ /prematch TeamA vs TeamB\n🔴 /live TeamA vs TeamB\n🏆 /postmatch TeamA vs TeamB\n🔮 /teaser TeamA vs TeamB\n🤯 /curiosity [topic]\n📊 /highlights [MD1 / data / ...]\n🗂 /group_hl [Group A / Group C / ...]\n📋 /batch — lancia più post in sequenza (uno alla volta):\n`prematch Brazil vs Argentina`\n`live France vs England`\n`highlights MD1`\n`group_hl Group A`\n`group_hl Group C`\n(una riga per job, max 10)\n🛑 /batchstop — ferma il batch corrente\n\n⏱ Render circa 3 min | ☁️ Output: Dropbox /[project]/',
  { parse_mode: 'Markdown' }
));
bot.command('prematch',   (ctx) => handleMoment(ctx, 'prematch'));
bot.command('live',       (ctx) => handleMoment(ctx, 'live'));
bot.command('postmatch',  (ctx) => handleMoment(ctx, 'postmatch'));
bot.command('teaser',     (ctx) => handleMoment(ctx, 'teaser'));
bot.command('curiosity',  (ctx) => handleCuriosity(ctx));
bot.command('highlights', (ctx) => handleHighlights(ctx));
bot.command('group_hl',  (ctx) => handleGroupHl(ctx));
bot.command('batch',      (ctx) => handleBatch(ctx));
bot.command('batchstop',  (ctx) => handleBatchStop(ctx));

// ── Server / webhook (solo quando eseguito direttamente) ──────────────────────
// Quando bot.js viene richiesto come modulo (es. da test-live-real.js),
// il blocco di startup NON gira: no server, no polling, no signal handlers.
if (require.main === module) {
  if (RAILWAY_PUBLIC_URL) {
    app.use(bot.webhookCallback('/webhook'));
    app.listen(PORT, async () => {
      console.log(`Server on port ${PORT}`);
      const webhookUrl = buildRailwayUrl('/webhook');
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`Webhook: ${webhookUrl}`);
    });
  } else {
    app.listen(PORT, () => console.log(`Server on port ${PORT}`));
    bot.launch({ dropPendingUpdates: true });
  }
  console.log('PitchPulse Bot avviato');
  process.once('SIGINT',  () => bot.stop('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => bot.stop('SIGTERM').finally(() => process.exit(0)));
} else {
  module.exports = { getMatchData, getCuriosityData, getHighlightsData, getGroupHlData, generateHTML };
}
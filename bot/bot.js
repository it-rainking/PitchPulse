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
  highlights: fs.readFileSync(path.join(PPL_DIR, 'highlights-instructions.txt'), 'utf8')
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

// ── ASSET REGISTRY ────────────────────────────────────────
// Modifica qui per aggiungere/cambiare audio, video e path
const ASSETS = {
  paths: {
    audio: '../audio/',
    fonts: '../fonts/',
    video: '../videos/'
  },
  audio: {
    prematch:   'PP-prematch.mp3',
    live:       'PP-live.mp3',
    postmatch:  'PP-postmatch.mp3',
    teaser:     'PP-prematch.mp3',
    curiosity:  'PP-prematch.mp3',
    highlights: 'PP-postmatch.mp3'
  },
  video: [
    'Goal-1.mp4',
    'Goal-2.mp4',
    'Goal-3.mp4',
    'Goal-4.mp4'
  ]
};

// ── Helper: path asset completi ───────────────────────────
function getAssetPaths(moment) {
  const audioFile = ASSETS.audio[moment] || ASSETS.audio.prematch;
  const videoFile = ASSETS.video[Math.floor(Math.random() * ASSETS.video.length)];
  return {
    audio_src: ASSETS.paths.audio + audioFile,
    video_src: ASSETS.paths.video + videoFile
  };
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

Return ONLY this exact format, no extra text:

=== PITCHPULSE - ${momentLabel} COPY ===
Match: [match.team_a.name] vs [match.team_b.name]
Phase: [match.phase] - [meta.tournament]
Venue: [match.venue], [match.city]
Kickoff: format as "HH:MM TZ | HH:MM UTC | DD Month YYYY" using match.kickoff_local and match.kickoff_utc

--- TIKTOK / REELS CAPTION ---
[caption_hook from JSON - STRICTLY max 12 words, punchy, data-first]

[2-3 lines expanding on key stat or cold_fact. Max 40 words. Data-first.]

[1 question to drive comments - e.g. "Who wins this one? Drop your score below"]

--- HASHTAGS ---
[hashtags.match] [hashtags.tournament] [hashtags.brand_pitchpulse] [hashtags.generic]
#${moment} #matchday #stats #footballdata #WC2026

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
    return data.content[0].text.trim();
  } catch (err) {
    clearTimeout(timeout);
    const hashtags = Object.values(jsonData.hashtags || {}).join(' ');
    return [
      `=== PITCHPULSE - ${momentLabel} COPY ===`,
      `Match: ${teamA} vs ${teamB}`,
      ``,
      `--- TIKTOK / REELS CAPTION ---`,
      jsonData.caption_hook || '',
      ``,
      `--- HASHTAGS ---`,
      hashtags
    ].join('\n');
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
    return { data: JSON.parse(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity/curiosity] JSON non valido:', jsonMatch[0].substring(0, 300));
    throw new Error('JSON Perplexity curiosity non parsabile: ' + parseErr.message);
  }
}

// ── Handler curiosity ─────────────────────────────────────
async function handleCuriosity(ctx) {
  const topic = ctx.message.text.replace('/curiosity', '').trim();
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

Return ONLY this exact format, no extra text:

=== PITCHPULSE - CURIOSITY COPY ===
Topic: ${topic}
Category: [curiosity.category]

--- TIKTOK / REELS CAPTION ---
[caption_hook from JSON - STRICTLY max 12 words]

[2-3 lines expanding on the most shocking fact. Max 40 words. Data-first.]

[1 CTA - e.g. "Follow @PitchPulse for more WC2026 facts"]

--- HASHTAGS ---
[hashtags.topic] [hashtags.tournament] [hashtags.brand_pitchpulse] [hashtags.generic]
#curiosity #footballfacts #WC2026facts

JSON:
${JSON.stringify(jsonData, null, 2)}`;

    const [{ html, claudePayload }, postText] = await Promise.all([
      generateHTML(jsonData, 'curiosity'),
      (async () => {
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
          return data.content[0].text.trim();
        } catch (err) {
          clearTimeout(timeout);
          return `=== PITCHPULSE - CURIOSITY COPY ===\nTopic: ${topic}\n\n--- CAPTION ---\n${jsonData.caption_hook || ''}\n\n--- HASHTAGS ---\n${Object.values(jsonData.hashtags || {}).join(' ')}`;
        }
      })()
    ]);

    await ctx.reply('🎬 Avviando render...');
    const base = RAILWAY_PUBLIC_URL || '';
    const callbackUrl = base ? `${base.startsWith('https') ? '' : 'https://'}${base}/callback` : '';

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
    return { data: JSON.parse(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity] JSON non valido:', jsonMatch[0].substring(0, 300));
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
    return { data: JSON.parse(jsonMatch[0]), promptUsed: prompt };
  } catch (parseErr) {
    console.error('[Perplexity/highlights] JSON non valido:', jsonMatch[0].substring(0, 300));
    throw new Error('JSON Perplexity highlights non parsabile: ' + parseErr.message);
  }
}

// ── Handler highlights ────────────────────────────────────
async function handleHighlights(ctx) {
  const input = ctx.message.text.replace('/highlights', '').trim();
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

Return ONLY this exact format, no extra text:

=== PITCHPULSE - HIGHLIGHTS COPY ===
Matchday: [day.matchday] - [day.date]
Tournament: [meta.tournament]

--- TIKTOK / REELS CAPTION ---
[caption_hook from JSON - STRICTLY max 12 words]

[List all results as: FLAG TeamA score-score TeamB FLAG]
[1 line on top scorer if not null]
[1 CTA - e.g. "Follow @PitchPulse for every result 👇"]

--- HASHTAGS ---
[hashtags.matchday] [hashtags.tournament] [hashtags.brand_pitchpulse] [hashtags.generic]
#highlights #results #WC2026recap

JSON:
${JSON.stringify(jsonData, null, 2)}`;

    const [{ html, claudePayload }, postText] = await Promise.all([
      generateHTML(jsonData, 'highlights'),
      (async () => {
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
          return data.content[0].text.trim();
        } catch (err) {
          clearTimeout(timeout);
          return `=== PITCHPULSE - HIGHLIGHTS COPY ===\nMatchday: ${input}\n\n--- CAPTION ---\n${jsonData.caption_hook || ''}\n\n--- HASHTAGS ---\n${Object.values(jsonData.hashtags || {}).join(' ')}`;
        }
      })()
    ]);

    await ctx.reply('🎬 Avviando render...');
    const base = RAILWAY_PUBLIC_URL || '';
    const callbackUrl = base ? `${base.startsWith('https') ? '' : 'https://'}${base}/callback` : '';

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\`\nPronto in circa 3 minuti`, { parse_mode: 'Markdown' });
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
    html = html.replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();
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
  return res.status === 204;
}

// ── Handler principale match ──────────────────────────────
async function handleMoment(ctx, moment) {
  const text = ctx.message.text.replace(`/${moment}`, '').trim();
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

    await ctx.reply('🎨 Generando HTML e copy...');
    const [{ html, claudePayload }, postText] = await Promise.all([
      generateHTML(jsonData, moment),
      generateCopy(jsonData, moment, teamA, teamB)
    ]);

    await ctx.reply('🎬 Avviando render...');
    const base = RAILWAY_PUBLIC_URL || '';
    const callbackUrl = base ? `${base.startsWith('https') ? '' : 'https://'}${base}/callback` : '';

    const triggered = await triggerRender(html, projectName, callbackUrl, postText, promptUsed, claudePayload);

    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\`\nPronto in circa 3 minuti`, { parse_mode: 'Markdown' });
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

// ── Callback render completato ────────────────────────────
app.post('/callback', async (req, res) => {
  const { status, project, dropbox } = req.body;
  try {
    if (status === 'ok') {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID,
        `✅ *Render completato!*\n📁 \`${project}\`\n☁️ \`${dropbox}\``,
        { parse_mode: 'Markdown' });
    } else {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID,
        `❌ *Render fallito:* \`${project}\``,
        { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error('Callback error:', e.message); }
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, bot: 'PitchPulse' }));

// ── Comandi bot ───────────────────────────────────────────
bot.command('start', (ctx) => ctx.reply(
  '*PitchPulse Bot* attivo!\n\n⚽ /prematch Brazil vs Argentina\n🔴 /live Brazil vs Argentina\n🏆 /postmatch Brazil vs Argentina\n🔮 /teaser Brazil vs Argentina\n🤯 /curiosity World Cup 2026\n📊 /highlights MD1',
  { parse_mode: 'Markdown' }
));
bot.command('help', (ctx) => ctx.reply(
  '*Comandi:*\n\n⚽ /prematch TeamA vs TeamB\n🔴 /live TeamA vs TeamB\n🏆 /postmatch TeamA vs TeamB\n🔮 /teaser TeamA vs TeamB\n🤯 /curiosity [topic]\n📊 /highlights [MD1 / MD2 / data]\n\n⏱ Render circa 3 min | ☁️ Output: Dropbox /[project]/',
  { parse_mode: 'Markdown' }
));
bot.command('prematch',   (ctx) => handleMoment(ctx, 'prematch'));
bot.command('live',       (ctx) => handleMoment(ctx, 'live'));
bot.command('postmatch',  (ctx) => handleMoment(ctx, 'postmatch'));
bot.command('teaser',     (ctx) => handleMoment(ctx, 'teaser'));
bot.command('curiosity',  (ctx) => handleCuriosity(ctx));
bot.command('highlights', (ctx) => handleHighlights(ctx));

// ── Server / webhook ──────────────────────────────────────
if (RAILWAY_PUBLIC_URL) {
  app.use(bot.webhookCallback('/webhook'));
  app.listen(PORT, async () => {
    console.log(`Server on port ${PORT}`);
    const webhookUrl = `${RAILWAY_PUBLIC_URL.startsWith('https') ? '' : 'https://'}${RAILWAY_PUBLIC_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook: ${webhookUrl}`);
  });
} else {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
  bot.launch({ dropPendingUpdates: true });
}

console.log('PitchPulse Bot avviato');
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ── Export condizionale per testing ───────────────────────
// Se questo file viene RICHIESTO da un altro script (es. test-live-real.js)
// invece di essere lanciato direttamente (node bot.js), esponiamo le funzioni
// pure di costruzione prompt/dati senza interferire con l'avvio reale del bot
// su Railway, che continua a partire normalmente con `node bot.js`.
if (require.main !== module) {
  module.exports = { getMatchData, getCuriosityData, getHighlightsData, generateHTML };
}


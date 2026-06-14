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

async function getMatchData(teamA, teamB, moment) {
  const momentLabel = { prematch:'PRE-MATCH preview', live:'LIVE match current score and stats', postmatch:'POST-MATCH final result', teaser:'tournament teaser' }[moment] || 'PRE-MATCH';
  const prompt = `World Cup 2026. ${momentLabel}: ${teamA} vs ${teamB}. Research real data. Return ONLY valid JSON, no markdown, no explanation:\n{"meta":{"moment":"${moment}","brand":"PitchPulse","version":"2.0"},"match":{"team_a":"${teamA}","team_a_code":"${teamA.substring(0,3).toUpperCase()}","team_b":"${teamB}","team_b_code":"${teamB.substring(0,3).toUpperCase()}","phase":"Group Stage","matchday":1,"kickoff_utc":"2026-06-15T18:00:00Z","venue":"Real Stadium","city":"Real City"},"headline":{"label":"KEY STAT","value":"XX","sub_label":"stat","description":"real context"},"stats":[{"label":"Stat","value":"X","context":"ctx"},{"label":"Stat","value":"X","context":"ctx"},{"label":"Stat","value":"X","context":"ctx"}],"H2H":{"team_a_wins":0,"draws":0,"team_b_wins":0},"cold_fact":{"label":"DID YOU KNOW","text":"real fact"},"player_watch":{"name":"Real Player","team":"${teamA}","stat":"real stat"},"mvp":null,"cold_verdict":null,"record_broken":null,"next_match":null,"score_a":null,"score_b":null,"minute":null,"caption_hook":"punchy hook","hashtags":{"match":"#${teamA.replace(/\s/g,'')}vs${teamB.replace(/\s/g,'')}","tournament":"#WorldCup2026 #WC2026","brand_pitchpulse":"#PitchPulse","generic":"#Football #Soccer #FIFA"}}`;

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar-pro', messages: [{ role: 'user', content: prompt }], max_tokens: 1500 })
  });
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error('Perplexity error: ' + JSON.stringify(data));
  const text = data.choices[0].message.content;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Perplexity response');
  return JSON.parse(jsonMatch[0]);
}

async function generateHTML(jsonData, moment) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `${moment}\n${JSON.stringify(jsonData, null, 2)}` }] })
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (!data.content || !data.content[0]) throw new Error('Claude error: ' + JSON.stringify(data));
    let html = data.content[0].text;
    html = html.replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();
    return html;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function triggerRender(html, projectName, callbackUrl) {
  // FIX: encode HTML in base64 per evitare syntax error bash con caratteri speciali (<, >, ', ")
  const htmlBase64 = Buffer.from(html).toString('base64');

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/render.yml/dispatches`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { html: htmlBase64, project: projectName, callback_url: callbackUrl || '' } })
  });
  return res.status === 204;
}

async function handleMoment(ctx, moment) {
  const text = ctx.message.text.replace(`/${moment}`, '').trim();
  const match = text.match(/(.+?)\s+vs\s+(.+)/i);
  if (!match) return ctx.reply(`❌ Formato: /${moment} Brazil vs Argentina`);

  const teamA = match[1].trim();
  const teamB = match[2].trim();
  const tsA = teamA.replace(/\s/g,'').substring(0,3).toUpperCase();
  const tsB = teamB.replace(/\s/g,'').substring(0,3).toUpperCase();
  const projectName = `${moment}-${tsA}vs${tsB}-${Date.now()}`;
  const emoji = { prematch:'⚽', live:'🔴', postmatch:'🏆', teaser:'🔮' }[moment];
  const label = { prematch:'PRE-MATCH', live:'LIVE', postmatch:'POST-MATCH', teaser:'TEASER' }[moment];

  await ctx.reply(`${emoji} *${label}* — ${teamA} vs ${teamB}\n⏳ Avvio pipeline...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('📊 Raccogliendo dati...');
    const jsonData = await getMatchData(teamA, teamB, moment);
    await ctx.reply('🎨 Generando HTML...');
    const html = await generateHTML(jsonData, moment);
    await ctx.reply('🎬 Avviando render...');
    const base = RAILWAY_PUBLIC_URL || '';
    const callbackUrl = base ? `${base.startsWith('https') ? '' : 'https://'}${base}/callback` : '';
    const triggered = await triggerRender(html, projectName, callbackUrl);
    if (triggered) {
      await ctx.reply(`✅ *Render avviato!*\n📁 \`${projectName}\`\n⏱ Pronto in ~3 minuti`, { parse_mode: 'Markdown' });
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

app.post('/callback', async (req, res) => {
  const { status, project, dropbox } = req.body;
  try {
    if (status === 'ok') {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `✅ *Render completato!*\n📁 \`${project}\`\n☁️ \`${dropbox}\``, { parse_mode: 'Markdown' });
    } else {
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ *Render fallito:* \`${project}\``, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error('Callback error:', e.message); }
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, bot: 'PitchPulse' }));

bot.command('start', (ctx) => ctx.reply('👋 *PitchPulse Bot* attivo!\n\n⚽ `/prematch` Brazil vs Argentina\n🔴 `/live` Brazil vs Argentina\n🏆 `/postmatch` Brazil vs Argentina\n🔮 `/teaser` Brazil vs Argentina', { parse_mode: 'Markdown' }));
bot.command('help', (ctx) => ctx.reply('📖 *Comandi:*\n\n⚽ `/prematch TeamA vs TeamB`\n🔴 `/live TeamA vs TeamB`\n🏆 `/postmatch TeamA vs TeamB`\n🔮 `/teaser TeamA vs TeamB`\n\n⏱ Render ~3 min | ☁️ Output: Dropbox /', { parse_mode: 'Markdown' }));
bot.command('prematch', (ctx) => handleMoment(ctx, 'prematch'));
bot.command('live', (ctx) => handleMoment(ctx, 'live'));
bot.command('postmatch', (ctx) => handleMoment(ctx, 'postmatch'));
bot.command('teaser', (ctx) => handleMoment(ctx, 'teaser'));

if (RAILWAY_PUBLIC_URL) {
  app.use(bot.webhookCallback('/webhook'));
  app.listen(PORT, async () => {
    console.log(`🚀 Server on port ${PORT}`);
    const webhookUrl = `${RAILWAY_PUBLIC_URL.startsWith('https') ? '' : 'https://'}${RAILWAY_PUBLIC_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🔗 Webhook: ${webhookUrl}`);
  });
} else {
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
  bot.launch({ dropPendingUpdates: true });
}

console.log('🤖 PitchPulse Bot avviato');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

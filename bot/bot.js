const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');
const express = require('express');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const app = express();
app.use(express.json());

const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
console.log('ANTHROPIC KEY PREFIX:', ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.substring(0, 15) + '...' : 'UNDEFINED');
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL;
const PORT = process.env.PORT || 3000;

async function getMatchData(teamA, teamB) {
  const prompt = `World Cup 2026. Match: ${teamA} vs ${teamB}. Return ONLY valid JSON with this structure: {"meta":{"moment":"prematch","brand":"PitchPulse","version":"2.0"},"match":{"team_a":"${teamA}","team_a_code":"${teamA.substring(0,3).toUpperCase()}","team_b":"${teamB}","team_b_code":"${teamB.substring(0,3).toUpperCase()}","phase":"Group Stage","matchday":1,"kickoff_utc":"2026-06-15T18:00:00Z","venue":"Stadium","city":"City"},"headline":{"label":"KEY STAT","value":"64%","sub_label":"possession avg","description":"Historical possession advantage"},"stats":[{"label":"Goals Scored","value":"12","context":"last 5 matches"},{"label":"Clean Sheets","value":"3","context":"last 5 matches"},{"label":"Win Rate","value":"70%","context":"all time H2H"}],"H2H":{"team_a_wins":8,"draws":4,"team_b_wins":6},"cold_fact":{"label":"DID YOU KNOW","text":"These teams have met 18 times in major tournaments."},"player_watch":{"name":"Star Player","team":"${teamA}","stat":"5 goals in last 3 WC matches"},"caption_hook":"The clash everyone waited for!","hashtags":{"match":"#${teamA.replace(/\s/g,'')}vs${teamB.replace(/\s/g,'')}","tournament":"#WorldCup2026 #WC2026","brand_pitchpulse":"#PitchPulse","generic":"#Football #Soccer"}}`;

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar-pro', messages: [{ role: 'user', content: prompt }], max_tokens: 1500 })
  });
  const data = await res.json();
  console.log('PERPLEXITY STATUS:', res.status);
  console.log('PERPLEXITY DATA:', JSON.stringify(data));
  if (!data.choices || !data.choices[0]) throw new Error('Perplexity error: ' + JSON.stringify(data));
  const text = data.choices[0].message.content;
  console.log('PERPLEXITY RAW:', text);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch[0]);
}

async function generateHTML(jsonData, moment) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: 'You are the PitchPulse HTML Agent. Convert JSON match data into a complete self-contained HTML file (1080x1920px) for Instagram/TikTok Stories. Dark navy background #0A0E2A, cyan #00F5FF, violet #7B2FFF. Include HyperFrames attributes on #root: data-composition-id, data-width="1080", data-height="1920", data-fps="30", data-duration="15", data-start="0". Include window.__timelines registration. Return ONLY the HTML.',
      messages: [{ role: 'user', content: `${moment}\n${JSON.stringify(jsonData, null, 2)}` }]
    })
  });
  const data = await res.json();
  console.log('CLAUDE STATUS:', res.status);
  console.log('CLAUDE DATA:', JSON.stringify(data).substring(0, 500));
  if (!data.content || !data.content[0]) throw new Error('Claude error: ' + JSON.stringify(data));
  return data.content[0].text;
}

async function triggerRender(html, projectName, callbackUrl) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/render.yml/dispatches`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { html, project: projectName, callback_url: callbackUrl || '' } })
  });
  return res.status === 204;
}

app.post('/callback', async (req, res) => {
  const { status, project, dropbox } = req.body;
  if (status === 'ok') {
    await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID,
      `✅ *Render completato!*\n📁 \`${project}\`\n☁️ \`${dropbox}\``,
      { parse_mode: 'Markdown' }
    );
  }
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

bot.command('start', (ctx) => {
  ctx.reply('👋 PitchPulse Bot attivo!\n\n/prematch Brazil vs Argentina');
});

bot.command('prematch', async (ctx) => {
  const text = ctx.message.text.replace('/prematch', '').trim();
  const match = text.match(/(.+?)\s+vs\s+(.+)/i);
  if (!match) return ctx.reply('❌ Formato: /prematch Brazil vs Argentina');

  const teamA = match[1].trim();
  const teamB = match[2].trim();
  const projectName = `prematch-${teamA.replace(/\s/g,'').substring(0,3).toUpperCase()}vs${teamB.replace(/\s/g,'').substring(0,3).toUpperCase()}-${Date.now()}`;

  await ctx.reply(`⏳ Generando card *${teamA} vs ${teamB}*...`, { parse_mode: 'Markdown' });

  try {
    await ctx.reply('📊 Raccogliendo dati...');
    const jsonData = await getMatchData(teamA, teamB);
    await ctx.reply('🎨 Generando HTML...');
    const html = await generateHTML(jsonData, 'prematch');
    await ctx.reply('🎬 Avviando render...');
    const callbackUrl = RAILWAY_PUBLIC_URL ? `${RAILWAY_PUBLIC_URL}/callback` : '';
    const triggered = await triggerRender(html, projectName, callbackUrl);
    if (triggered) {
      await ctx.reply(`✅ Render avviato!\n📁 \`${projectName}\`\n⏱ ~3 minuti`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Errore GitHub Actions');
    }
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Errore: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
bot.launch();
console.log('🤖 PitchPulse Bot avviato');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

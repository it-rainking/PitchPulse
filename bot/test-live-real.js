// Script di verifica MANUALE contro le API reali di Perplexity e Anthropic.
// Da lanciare da terminale, nella cartella bot/, dopo aver settato le env vars
// reali (PERPLEXITY_API_KEY, ANTHROPIC_API_KEY). NON è automatizzato/CI -
// consuma credito reale sulle API, va lanciato consapevolmente.
//
// Uso:
//   cd bot
//   node test-live-real.js prematch "Brazil vs Argentina"
//   node test-live-real.js live "Portugal vs DR Congo"
//   node test-live-real.js postmatch "France vs Germany"
//   node test-live-real.js curiosity "Mbappe"
//   node test-live-real.js highlights "MD1"

require('dotenv').config(); // se usi un .env locale, altrimenti assicurati che le env siano settate

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!PERPLEXITY_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Mancano PERPLEXITY_API_KEY e/o ANTHROPIC_API_KEY nelle variabili d\'ambiente.');
  process.exit(1);
}

// Importa le stesse funzioni pure da bot.js. Richiede che bot.js esponga
// queste funzioni via module.exports SOLO se vuoi usare questo script
// senza duplicare codice - altrimenti copia qui la logica di getMatchData
// /getCuriosityData/getHighlightsData manualmente. Per semplicità, qui
// assumiamo l'export di test (vedi nota in fondo al file).

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const mode = args[0];
const input = args[1];

if (!mode || !input) {
  console.log('Uso: node test-live-real.js <prematch|live|postmatch|curiosity|highlights|group_hl> "<input>"');
  process.exit(1);
}

async function callPerplexity(prompt) {
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
    console.error('Errore Perplexity:', JSON.stringify(data, null, 2));
    process.exit(1);
  }
  let text = data.choices[0].message.content;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Nessun JSON trovato nella risposta:', text.slice(0, 300));
    process.exit(1);
  }
  return JSON.parse(jsonMatch[0]);
}

(async () => {
  // Richiede bot.js con le funzioni esportate temporaneamente per il test
  // (vedi PASSOPASSO sotto per come abilitarlo senza intaccare la versione
  // di produzione caricata da Railway).
  const mod = require('./bot.js');

  let result;
  console.log(`\n>>> Chiamata REALE a Perplexity per moment "${mode}" con input "${input}"...\n`);

  if (mode === 'curiosity') {
    result = await mod.getCuriosityData(input);
  } else if (mode === 'highlights') {
    result = await mod.getHighlightsData(input);
  } else if (mode === 'group_hl') {
    result = await mod.getGroupHlData(input);
  } else {
    const matchInput = input.match(/(.+?)\s+vs\s+(.+)/i);
    if (!matchInput) {
      console.error('Formato squadre non valido, usa "TeamA vs TeamB"');
      process.exit(1);
    }
    result = await mod.getMatchData(matchInput[1].trim(), matchInput[2].trim(), mode);
  }

  console.log('=== JSON RICEVUTO DA PERPLEXITY ===');
  console.log(JSON.stringify(result.data, null, 2));

  console.log('\n=== CONTROLLI MANUALI DA FARE A OCCHIO ===');
  if (mode === 'live') {
    console.log('- match_status è plausibile rispetto all\'orario reale della partita?');
    console.log('- score_a/score_b sono numeri interi reali, non null, non placeholder?');
    console.log('- minute riflette un minuto reale o HT/FT, non un valore a caso?');
    console.log('- key_events contiene eventi reali o un array vuoto coerente?');
    console.log('- source_note indica una fonte e un timestamp/minuto verificabile?');
  }
  if (mode === 'postmatch') {
    console.log('- score_a/score_b sono il risultato finale reale?');
    console.log('- mvp.name è un giocatore reale di quella partita?');
    console.log('- record_broken è null oppure un record reale, non un testo a caso?');
    console.log('- next_match è null se finale/eliminazione, altrimenti coerente?');
  }
  if (mode === 'highlights') {
    console.log('- matches[] contiene TUTTI i match reali della giornata?');
    console.log('- ogni match ha lo status corretto (FT/LIVE/NS) rispetto a ora?');
    console.log('- i match NS hanno davvero score_a/score_b = null?');
  }
  if (mode === 'group_hl') {
    console.log('- standings[] ha esattamente 4 team con pos 1-4?');
    console.log('- played, won, drawn, lost, gf, ga, pts sono tutti interi reali?');
    console.log('- played_matches[] contiene solo le partite effettivamente giocate?');
    console.log('- upcoming_matches[] è array vuoto se tutte le partite sono state giocate?');
  }
  if (mode === 'curiosity') {
    console.log('- il fatto è davvero ancorato a WC2026 o cita correttamente contesto storico?');
    console.log('- i 3 facts[] sono davvero su 3 angoli diversi (non ripetitivi)?');
  }

  console.log('\nDone. Nessuna chiamata a Claude è stata fatta in questo script (solo Perplexity).');
})();

// PASSOPASSO per abilitare l'uso di questo script:
// 1. In bot.js, in fondo al file, aggiungi temporaneamente (o lascia se
//    vuoi sempre poter testare in isolamento):
//
//    if (require.main !== module) {
//      module.exports = { getMatchData, getCuriosityData, getHighlightsData };
//    }
//
//    Questo fa si' che quando bot.js viene LANCIATO direttamente (node bot.js
//    su Railway) il bot parta normalmente, ma quando viene RICHIESTO da
//    un altro script (come questo) esponga le funzioni senza avviare il bot.
// 2. node test-live-real.js live "Portugal vs DR Congo"

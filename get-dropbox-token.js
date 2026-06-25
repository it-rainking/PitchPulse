#!/usr/bin/env node
/**
 * Genera un nuovo Dropbox refresh_token via OAuth2 offline flow.
 * Uso: DBX_APP_KEY=xxx DBX_APP_SECRET=yyy node get-dropbox-token.js
 */

const https = require('https');
const readline = require('readline');

const APP_KEY    = process.env.DBX_APP_KEY;
const APP_SECRET = process.env.DBX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('Errore: imposta DBX_APP_KEY e DBX_APP_SECRET come variabili d\'ambiente.');
  console.error('  DBX_APP_KEY=xxx DBX_APP_SECRET=yyy node get-dropbox-token.js');
  process.exit(1);
}

const authUrl =
  `https://www.dropbox.com/oauth2/authorize` +
  `?client_id=${APP_KEY}` +
  `&response_type=code` +
  `&token_access_type=offline`;

console.log('\n1. Apri questo URL nel browser e autorizza l\'app:\n');
console.log('   ' + authUrl);
console.log('\n2. Dropbox ti mostrerà un codice di autorizzazione. Incollalo qui sotto.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Codice di autorizzazione: ', (code) => {
  rl.close();
  code = code.trim();

  const body = new URLSearchParams({
    code,
    grant_type:    'authorization_code',
    client_id:     APP_KEY,
    client_secret: APP_SECRET,
  }).toString();

  const req = https.request({
    hostname: 'api.dropboxapi.com',
    path:     '/oauth2/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let json;
      try { json = JSON.parse(data); } catch {
        console.error('Risposta non valida:', data);
        process.exit(1);
      }

      if (json.error) {
        console.error('\nErrore Dropbox:', json.error, '-', json.error_description);
        process.exit(1);
      }

      console.log('\n✅ Token ottenuto con successo!\n');
      console.log('  refresh_token :', json.refresh_token);
      console.log('  access_token  :', json.access_token);
      console.log('  account_id    :', json.account_id);
      console.log('\n3. Aggiorna il secret GitHub Actions:');
      console.log('   Repository → Settings → Secrets and variables → Actions');
      console.log('   Nome secret: DBX_REFRESH_TOKEN');
      console.log('   Valore     :', json.refresh_token);
    });
  });

  req.on('error', err => {
    console.error('Errore di rete:', err.message);
    process.exit(1);
  });

  req.write(body);
  req.end();
});

/**
 * Two-step Xiaomi Cloud 2FA Authenticator & Token Persister
 *
 * Usage:
 *   Step 1 (Trigger 2FA email code):
 *     node xiaomi-2fa-setup.js send
 *   Step 2 (Verify 6-digit code & save permanent tokens + Device ID to functions/.env):
 *     node xiaomi-2fa-setup.js verify <6_DIGIT_CODE>
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'functions', '.xiaomi-session.json');
const ENV_FILE = path.join(__dirname, 'functions', '.env');
const FIXED_DEVICE_ID = 'XIAOMIVACUUMCZ01';
const USER_AGENT =
  'Android-7.1.1-1.0.0-ONEPLUS A3010-136-XIAOMIVACUUMCZ01 APP/xiaomi.smarthome APPV/62830';

function stripPrefix(text) {
  const prefix = '&&&START&&&';
  return typeof text === 'string' && text.startsWith(prefix)
    ? text.slice(prefix.length)
    : text;
}

function parseCookies(res, jar = {}) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
  for (const c of raw) {
    if (!c) continue;
    const firstPart = c.split(';')[0];
    const eq = firstPart.indexOf('=');
    if (eq > 0) {
      const k = firstPart.slice(0, eq).trim();
      const v = firstPart.slice(eq + 1).trim();
      if (v && v !== 'EXPIRED') {
        jar[k] = v;
      }
    }
  }
  return jar;
}

function formatCookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) {
        env[t.slice(0, eq).trim()] = t
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
      }
    }
  }
  return env;
}

async function startLoginAndSendCode() {
  const env = loadEnv();
  const username = env.MIHOME_USERNAME || 'asterbikova@gmail.com';
  const password = env.MIHOME_PASSWORD || 'Alena1957';

  const jar = {
    sdkVersion: 'accountsdk-18.8.15',
    deviceId: FIXED_DEVICE_ID,
    userId: username,
  };

  console.log(`1. Initiating Xiaomi login for ${username}...`);
  const r1 = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', {
    headers: { 'User-Agent': USER_AGENT, Cookie: formatCookieHeader(jar) },
  });
  parseCookies(r1, jar);
  const j1 = JSON.parse(stripPrefix(await r1.text()));

  const hash = crypto.createHash('md5').update(password).digest('hex').toUpperCase();
  const form = new URLSearchParams({
    sid: 'xiaomiio',
    hash,
    callback: 'https://sts.api.io.mi.com/sts',
    qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
    user: username,
    _sign: j1._sign,
    _json: 'true',
  });

  const r2 = await fetch('https://account.xiaomi.com/pass/serviceLoginAuth2', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: formatCookieHeader(jar),
    },
    body: form.toString(),
  });
  parseCookies(r2, jar);
  const j2 = JSON.parse(stripPrefix(await r2.text()));

  if (j2.ssecurity && j2.location) {
    console.log('✓ Logged in without 2FA!');
    await completeStsAndDiscover(j2, jar, username, password);
    return;
  }

  if (!j2.notificationUrl) {
    throw new Error(`Unexpected login response: ${JSON.stringify(j2)}`);
  }

  const notificationUrl = j2.notificationUrl;
  const parsedUrl = new URL(notificationUrl);
  const context = parsedUrl.searchParams.get('context');

  console.log('2. Xiaomi requested 2FA verification. Fetching identity session...');
  const listUrl = `https://account.xiaomi.com/identity/list?sid=xiaomiio&context=${encodeURIComponent(
    context
  )}&_locale=cs_CZ`;
  const rList = await fetch(listUrl, {
    headers: { 'User-Agent': USER_AGENT, Cookie: formatCookieHeader(jar) },
  });
  parseCookies(rList, jar);
  const listText = stripPrefix(await rList.text());
  console.log('Identity list status:', rList.status);

  // Trigger sending the email verification ticket
  const sendEmailUrl = 'https://account.xiaomi.com/identity/auth/sendEmailTicket';
  const sendBody = new URLSearchParams({
    retry: '0',
    icode: '',
    _json: 'true',
    ick: jar.ick || '',
  });
  const rSend = await fetch(sendEmailUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: formatCookieHeader(jar),
    },
    body: sendBody.toString(),
  });
  parseCookies(rSend, jar);
  const sendResult = stripPrefix(await rSend.text());
  console.log('Send email ticket response:', sendResult);

  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ jar, context, notificationUrl, username, password, listText }, null, 2),
    'utf8'
  );
  console.log(`✓ Saved 2FA session to ${SESSION_FILE}`);
}

async function verifyCode(code) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('No active 2FA session file found. Run `node xiaomi-2fa-setup.js send` first.');
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const { jar, username, password } = session;

  console.log(`Verifying 2FA code ${code}...`);
  const verifyUrl = 'https://account.xiaomi.com/identity/auth/verifyEmail';
  const form = new URLSearchParams({
    ticket: String(code).trim(),
    trust: 'true',
    _json: 'true',
    ick: jar.ick || '',
  });

  const rVerify = await fetch(verifyUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: formatCookieHeader(jar),
    },
    body: form.toString(),
  });
  parseCookies(rVerify, jar);
  const verifyJson = JSON.parse(stripPrefix(await rVerify.text()));
  console.log('Verify response:', verifyJson);

  if (verifyJson.code !== 0 || !verifyJson.location) {
    throw new Error(`2FA verification failed: ${JSON.stringify(verifyJson)}`);
  }

  // Follow redirect chain to finish identity verification
  let nextUrl = verifyJson.location;
  for (let i = 0; i < 5 && nextUrl; i++) {
    const rNext = await fetch(nextUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Cookie: formatCookieHeader(jar) },
    });
    parseCookies(rNext, jar);
    nextUrl = rNext.headers.get('location');
  }

  // Now re-run serviceLogin with the newly trusted deviceId & passToken cookies!
  const rLogin = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', {
    headers: { 'User-Agent': USER_AGENT, Cookie: formatCookieHeader(jar) },
  });
  parseCookies(rLogin, jar);
  const jLogin = JSON.parse(stripPrefix(await rLogin.text()));

  if (!jLogin.ssecurity || !jLogin.location) {
    throw new Error(`Post-2FA serviceLogin did not return ssecurity: ${JSON.stringify(jLogin)}`);
  }

  await completeStsAndDiscover(jLogin, jar, username, password);
}

async function completeStsAndDiscover(loginJson, jar, username, password) {
  const rSts = await fetch(loginJson.location, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Cookie: formatCookieHeader(jar) },
  });
  parseCookies(rSts, jar);

  const serviceToken = jar.serviceToken;
  const ssecurity = loginJson.ssecurity;
  const userId = loginJson.userId || jar.userId;
  const passToken = loginJson.passToken || jar.passToken;

  if (!serviceToken) {
    throw new Error('Could not obtain serviceToken from STS redirect.');
  }

  console.log('✓ Successfully obtained permanent Xiaomi Cloud tokens!');
  const { XiaomiCloudClient } = require('./functions/xiaomi-cloud.js');
  const client = new XiaomiCloudClient();
  client.userId = userId;
  client.ssecurity = ssecurity;
  client.serviceToken = serviceToken;
  client.passToken = passToken;
  client.isLoggedIn = true;

  const regions = ['de', 'cn', 'us', 'sg', 'ru'];
  let selectedDevice = null;
  let selectedCountry = 'de';

  for (const country of regions) {
    try {
      const devices = await client.getDevices(null, { country });
      if (Array.isArray(devices) && devices.length > 0) {
        console.log(`\n=== Region: "${country}" (${devices.length} device(s)) ===`);
        for (const dev of devices) {
          console.log(`  • Name:      ${dev.name}`);
          console.log(`    Device ID: ${dev.did}`);
          console.log(`    Model:     ${dev.model}`);
          console.log(`    Online:    ${dev.isOnline}`);

          const isVacuum =
            String(dev.model || '').toLowerCase().includes('vacuum') ||
            String(dev.name || '').toLowerCase().includes('vacuum') ||
            String(dev.name || '').toLowerCase().includes('vysava');

          if (!selectedDevice || (isVacuum && dev.isOnline)) {
            selectedDevice = dev;
            selectedCountry = country;
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  const did = selectedDevice ? selectedDevice.did : '123456789';
  const envLines = [
    '# Xiaomi Cloud Account Credentials',
    `MIHOME_USERNAME="${username}"`,
    `MIHOME_PASSWORD="${password}"`,
    `MIHOME_DEVICE_ID="${did}"`,
    `MIHOME_COUNTRY="${selectedCountry}"`,
    '',
    '# Cached Xiaomi Cloud Session Tokens (prevents future 2FA prompts)',
    `MIHOME_USER_ID="${userId}"`,
    `MIHOME_PASS_TOKEN="${passToken || ''}"`,
    `MIHOME_SSECURITY="${ssecurity}"`,
    `MIHOME_SERVICE_TOKEN="${serviceToken}"`,
    '',
  ];
  fs.writeFileSync(ENV_FILE, envLines.join('\n'), 'utf8');
  console.log(`\n✓ Saved credentials, permanent session tokens, and Device ID (${did}) to functions/.env!`);
}

const cmd = process.argv[2] || 'send';
if (cmd === 'send') {
  startLoginAndSendCode().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'verify') {
  verifyCode(process.argv[3]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

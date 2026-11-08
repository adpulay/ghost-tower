#!/usr/bin/env node
// Checks everything the live demo depends on, without changing anything. Run it before going on stage.
//
//   npm run preflight
//
// Settings come from the repo's .env; real environment variables win. Exits 1 if anything would break the demo.
import { existsSync, readFileSync } from 'node:fs';

function loadEnv() {
  const file = new URL('../.env', import.meta.url);
  const env = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const isSet = v => !!v && !v.includes('<') && !/X{4,}/.test(v);
const ok = msg => ({ level: 'ok', msg });
const warn = msg => ({ level: 'warn', msg });
const fail = msg => ({ level: 'fail', msg });

const TIMEOUT_MS = 6000;
async function request(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const host = (env.SPACETIME_HOST ?? 'http://localhost:3000').replace(/^ws/, 'http').replace(/\/$/, '');
const db = env.SPACETIME_DB ?? 'ghost-tower';
const dbUrl = `${host}/v1/database/${encodeURIComponent(db)}`;

const checks = [
  ['Database', async () => {
    const res = await request(`${dbUrl}/sql`, { method: 'POST', body: 'SELECT id FROM dev_config' });
    if (!res.ok) return fail(`${db} on ${host} answered HTTP ${res.status}`);
    const schema = await request(`${dbUrl}/sql`, { method: 'POST', body: 'SELECT id FROM case_report' });
    if (!schema.ok) return fail(`${db} is running an old module: publish spacetime/ again`);
    return ok(`${db} on ${host}`);
  }],
  ['Operator token', async () => {
    if (!isSet(env.SPACETIME_TOKEN)) return fail('SPACETIME_TOKEN is not set: the agent and simulator will be refused');
    const res = await request(`${dbUrl}/call/check_operator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SPACETIME_TOKEN}` },
      body: '[]',
    });
    if (res.ok) return ok('accepted as operator');
    return fail(`refused (HTTP ${res.status}): ${(await res.text()).slice(0, 100)}`);
  }],
  ['Scam classifier', async () => {
    if (!isSet(env.SCORE_URL)) return warn('SCORE_URL is not set, so this could not be checked');
    const res = await request(env.SCORE_URL.replace(/\/score\/?$/, '/health'));
    if (!res.ok) return fail(`${env.SCORE_URL} answered HTTP ${res.status}`);
    const { scorer } = await res.json();
    return scorer === 'rules' ? warn('up, but serving keyword rules: no trained model is loaded') : ok(`up, using ${scorer}`);
  }],
  ['Nemotron', async () => {
    const provider = env.NEMOTRON_PROVIDER ?? 'brev';
    if (provider === 'mock') return warn('NEMOTRON_PROVIDER=mock: all text will come from fixed templates');
    if (provider === 'hosted') return isSet(env.HOSTED_API_KEY) ? ok('hosted API key is set') : fail('HOSTED_API_KEY is not set');
    if (!isSet(env.BREV_BASE_URL)) return fail('BREV_BASE_URL is not set');
    const res = await request(`${env.BREV_BASE_URL.replace(/\/$/, '')}/models`);
    return res.ok ? ok(`answering at ${env.BREV_BASE_URL}`) : fail(`${env.BREV_BASE_URL} answered HTTP ${res.status}`);
  }],
  ['Road router', async () => {
    const base = (env.OSRM_URL ?? 'https://router.project-osrm.org').replace(/\/$/, '');
    const res = await request(`${base}/route/v1/driving/-96.77,32.98;-96.76,32.98?overview=false`);
    return res.ok ? ok(base) : warn(`${base} answered HTTP ${res.status}: routes will be straight lines`);
  }],
  ['Text warnings', async () => {
    if (env.TWILIO_DRY_RUN === '1') return warn('TWILIO_DRY_RUN=1: no real texts will be sent');
    if (!isSet(env.TWILIO_ACCOUNT_SID) || !isSet(env.TWILIO_AUTH_TOKEN)) return warn('Twilio is not configured: no real texts will be sent');
    const n = (env.TWILIO_VERIFIED_NUMBERS ?? '').split(',').filter(isSet).length;
    return n ? ok(`real texts go to ${n} verified number${n === 1 ? '' : 's'}`) : warn('no verified numbers: no real texts will be sent');
  }],
  ['Push relay', async () => (isSet(env.NTFY_TOPIC) ? ok('NTFY_TOPIC is set (start it with `npm run ntfy` in agent/)') : warn('NTFY_TOPIC is not set: no ntfy pushes'))],
];

const MARK = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
let failed = 0;
for (const [name, check] of checks) {
  let result;
  try {
    result = await check();
  } catch (e) {
    result = fail(`no answer (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ?? e.message})`);
  }
  if (result.level === 'fail') failed++;
  console.log(`[${MARK[result.level]}] ${name.padEnd(16)} ${result.msg}`);
}
console.log(failed ? `\n${failed} check${failed === 1 ? '' : 's'} failed. Fix before going on.` : '\nNothing is blocking the demo.');
process.exit(failed ? 1 : 0);

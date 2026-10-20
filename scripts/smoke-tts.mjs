#!/usr/bin/env node
/**
 * Exercise `ai-proxy` `/tts` on a deployed project with a throwaway user.
 *
 * The deploy script's boot smoke is OPTIONS-only (see
 * docs/automation/edge-function-deploy-policy.md); this is the one executable
 * test of the handler itself, because `serve()` at module level keeps it out
 * of `deno test`. It creates a user with the service key, signs in for a JWT,
 * posts two texts (a short one, and one past the ElevenLabs fence), prints
 * status / content-type / bytes / `X-Tts-Provider` for each, and deletes the
 * user. It never prints a secret.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, AI_PROXY_APP_TOKEN.
 * Optional: SMOKE_EXPECT_SHORT (provider expected for the short text, e.g.
 * "elevenlabs"), SMOKE_EXPECT_LONG (e.g. "openai"; on a project with no
 * OPENAI_API_KEY expect status 502 instead via SMOKE_EXPECT_LONG_STATUS).
 * Both requests must return audio by default. An explicit long status can
 * exercise a known failure path; short speech must always succeed.
 * Exit 0 when baseline and stated expectations hold, 1 otherwise.
 */

// Static reads only (the repo's eslint forbids dynamic process.env access).
const ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  AI_PROXY_APP_TOKEN: process.env.AI_PROXY_APP_TOKEN,
};
const need = (name) => {
  const v = ENV[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return v;
};

const url = need('SUPABASE_URL').replace(/\/$/, '');
const anon = need('SUPABASE_ANON_KEY');
const service = need('SUPABASE_SERVICE_ROLE_KEY');
const appToken = need('AI_PROXY_APP_TOKEN');

const SHORT = 'Yesterday was a miss. The research says one day does not hurt. Today, return.';
const LONG = `${SHORT} `.repeat(25); // ~1,950 chars: past ELEVENLABS_MAX_CHARS (1,500)

const email = `smoke-tts-${Date.now()}@example.invalid`;
const password = `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function admin(path, init) {
  return fetch(`${url}/auth/v1${path}`, {
    ...init,
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

let userId = null;
let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

try {
  const created = await admin('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`createUser ${created.status}: ${(await created.text()).slice(0, 200)}`);
  userId = (await created.json()).id;

  const signIn = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`signIn ${signIn.status}: ${(await signIn.text()).slice(0, 200)}`);
  const jwt = (await signIn.json()).access_token;

  const tts = async (text) => {
    const started = Date.now();
    const res = await fetch(`${url}/functions/v1/ai-proxy/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-App-Token': appToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const ms = Date.now() - started;
    const contentType = res.headers.get('content-type') ?? '';
    const provider = res.headers.get('x-tts-provider') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    const errorText = contentType.includes('json') ? new TextDecoder().decode(buf).slice(0, 160) : '';
    return { status: res.status, contentType, provider, bytes: buf.byteLength, ms, errorText };
  };

  const short = await tts(SHORT);
  console.log('short:', short);
  const long = await tts(LONG);
  console.log('long: ', long);

  const checkAudio = (label, result) => {
    check(`${label} → 200`, result.status === 200, String(result.status));
    check(`${label} → audio/mpeg`, result.contentType.toLowerCase().startsWith('audio/mpeg'), result.contentType);
    check(`${label} → ≥ 64 bytes`, result.bytes >= 64, String(result.bytes));
  };
  checkAudio('short', short);
  const expectShort = process.env.SMOKE_EXPECT_SHORT;
  if (expectShort) check(`short → provider ${expectShort}`, short.provider === expectShort, short.provider);

  const expectLong = process.env.SMOKE_EXPECT_LONG;
  const expectLongStatus = process.env.SMOKE_EXPECT_LONG_STATUS;
  const expectedStatus = expectLongStatus ? Number(expectLongStatus) : 200;
  check(`long → status ${expectedStatus}`, long.status === expectedStatus, `${long.status} ${long.errorText}`);
  // A provider expectation implies successful audio even if a conflicting
  // error status was also configured. Explicit 200 still checks the bytes.
  if (expectedStatus === 200 || expectLong) checkAudio('long', long);
  if (expectLong) check(`long → provider ${expectLong}`, long.provider === expectLong, long.provider);

} catch (e) {
  console.error('smoke error:', e instanceof Error ? e.message : e);
  failed = true;
} finally {
  if (userId) {
    try {
      const del = await admin(`/admin/users/${userId}`, { method: 'DELETE' });
      console.log(`cleanup: deleted user ${userId} (${del.status})`);
      if (!del.ok) failed = true;
    } catch (e) {
      console.error(`cleanup FAILED for user ${userId}; remove it by hand:`, e instanceof Error ? e.message : e);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);

import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';

const API_BASE = 'https://api.appstoreconnect.apple.com';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createToken(keyId, issuerId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 1_190,
    aud: 'appstoreconnect-v1',
  }));
  const input = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${input}.${signature}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findBuild({ appId, buildNumber, keyId, issuerId, privateKey }) {
  const url = new URL('/v1/builds', API_BASE);
  url.searchParams.set('filter[app]', appId);
  url.searchParams.set('filter[version]', buildNumber);
  url.searchParams.set('fields[builds]', 'version,processingState,uploadedDate');
  url.searchParams.set('sort', '-uploadedDate');
  url.searchParams.set('limit', '5');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${createToken(keyId, issuerId, privateKey)}` },
  });
  if (!response.ok) {
    throw new Error(`App Store Connect build lookup failed (${response.status}).`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data[0] ?? null : null;
}

async function main() {
  const keyId = argument('key-id');
  const issuerId = argument('issuer-id');
  const keyFile = argument('key-file');
  const appId = argument('app-id');
  const buildNumber = argument('build-number');
  const timeoutSeconds = Number(argument('timeout-seconds'));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be positive.');
  }
  const privateKey = await readFile(keyFile, 'utf8');
  const deadline = Date.now() + timeoutSeconds * 1_000;

  while (Date.now() < deadline) {
    const build = await findBuild({ appId, buildNumber, keyId, issuerId, privateKey });
    const state = build?.attributes?.processingState;
    if (state === 'VALID') {
      console.log(`App Store Connect build ${buildNumber} is VALID and TestFlight-visible.`);
      return;
    }
    if (state === 'FAILED' || state === 'INVALID') {
      throw new Error(`App Store Connect build ${buildNumber} is ${state}.`);
    }
    console.log(
      build
        ? `App Store Connect build ${buildNumber} is ${state ?? 'PROCESSING'}; checking again.`
        : `App Store Connect has not indexed build ${buildNumber} yet; checking again.`,
    );
    await sleep(30_000);
  }
  throw new Error(`Timed out waiting for App Store Connect build ${buildNumber}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

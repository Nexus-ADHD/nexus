// Connect AI: client for the nexus-mcp multi-user connector.
//
// - mintConnectionCode(): generates the 8-char one-time code the user types
//   into the MCP consent page. The PLAINTEXT lives only in component state
//   (shown once); Supabase stores only the sha-256 hash. TTL (10 min) is a
//   column DEFAULT server-side — never send expires_at (a modified client
//   must not mint longer-lived codes).
// - listConnections() / revokeConnection(): the user's live MCP connections,
//   via the worker's /connections routes, authed with the user's own
//   Supabase access token.
import * as Crypto from 'expo-crypto';
import { supabase, getSession } from './supabase';

export const MCP_SERVER_URL = 'https://nexus-mcp.nexus-mcp.workers.dev/mcp';
const WORKER_BASE = MCP_SERVER_URL.replace(/\/mcp$/, '');

// Unambiguous alphabet — matches the worker's CODE_PATTERN ([A-Z2-9]{8}):
// no 0/1 digits, no O/I/L letters (read-aloud safe).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export async function generateCode(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(CODE_LENGTH);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Inserts the hash and returns the plaintext for one-time display.
export async function mintConnectionCode(userId: string): Promise<string> {
  const code = await generateCode();
  const codeHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    code,
  );
  const { error } = await supabase
    .from('connect_codes')
    .insert({ user_id: userId, code_hash: codeHash });
  if (error) throw new Error(`Could not create a connection code: ${error.message}`);
  return code;
}

export interface AiConnection {
  id: string;
  client: string;
  scope: string[];
}

async function accessToken(): Promise<string> {
  const session = await getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in');
  return token;
}

export async function listConnections(): Promise<AiConnection[]> {
  const res = await fetch(`${WORKER_BASE}/connections`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) throw new Error(`Could not load connections (${res.status})`);
  const body = (await res.json()) as { connections?: AiConnection[] };
  return body.connections ?? [];
}

export async function revokeConnection(grantId: string): Promise<void> {
  const res = await fetch(
    `${WORKER_BASE}/connections?id=${encodeURIComponent(grantId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${await accessToken()}` } },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`Could not disconnect (${res.status})`);
  }
}

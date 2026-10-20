import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
Deno.env.set('SUPABASE_URL', 'https://example.invalid');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
const { escapeHtml, firstNameFrom, isServiceRoleCaller, requireUser } = await import('./caller-auth.ts');

const withAuth = (value?: string) =>
  new Request('https://x.invalid', { method: 'POST', headers: value ? { Authorization: value } : {} });

Deno.test('service role: the exact env key passes, near misses fail without a network call', async () => {
  assert(await isServiceRoleCaller(withAuth('Bearer service-role-test-key')));
  assert(!(await isServiceRoleCaller(withAuth('Bearer anon-test-key'))));
  assert(!(await isServiceRoleCaller(withAuth('Bearer service-role-test-ke'))));
  assert(!(await isServiceRoleCaller(withAuth('service-role-test-key'))));
  assert(!(await isServiceRoleCaller(withAuth())));
});

Deno.test('service role: a JWT claiming service_role is checked with the auth server', async () => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  const forged = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.sig`;
  const real = globalThis.fetch;
  let called = 0;
  try {
    globalThis.fetch = (() => { called++; return Promise.resolve(new Response('{}', { status: 401 })); }) as typeof fetch;
    assert(!(await isServiceRoleCaller(withAuth(`Bearer ${forged}`))));
    globalThis.fetch = (() => { called++; return Promise.resolve(new Response('{}', { status: 200 })); }) as typeof fetch;
    assert(await isServiceRoleCaller(withAuth(`Bearer ${forged}`)));
    const anonJwt = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon' })}.sig`;
    assert(!(await isServiceRoleCaller(withAuth(`Bearer ${anonJwt}`))));
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(called, 2);
});

Deno.test('requireUser: no bearer is a 401 before any network call', async () => {
  const res = await requireUser(withAuth());
  assert(res instanceof Response);
  assertEquals(res.status, 401);
});

Deno.test('escapeHtml neutralises markup and attribute breakouts', () => {
  assertEquals(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

Deno.test('firstNameFrom: first word, no control characters, capped, fallback', () => {
  assertEquals(firstNameFrom('Alex Rivera', 'there'), 'Alex');
  assertEquals(firstNameFrom('  \r\nEvil\nSubject: x', 'there'), 'Evil');
  assertEquals(firstNameFrom('', 'there'), 'there');
  assertEquals(firstNameFrom(42, 'friend'), 'friend');
  assertEquals(firstNameFrom('x'.repeat(100), 'there').length, 40);
});

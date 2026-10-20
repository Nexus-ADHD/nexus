import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { readTtsErrorBody, runTtsRequest } from './tts-request.ts';

const expired = () => new Response('Speech budget exhausted', { status: 504 });

Deno.test('request: an expired budget never starts authentication', async () => {
  let calls = 0;
  const response = await runTtsRequest(Date.now() - 100, () => {
    calls++;
    return Promise.resolve(new Response());
  }, expired, 50);
  assertEquals(response.status, 504);
  assertEquals(calls, 0);
});

Deno.test('request: successful and unauthorized responses return normally and clear the timer', async () => {
  for (const status of [200, 401, 429]) {
    const response = await runTtsRequest(Date.now(), () => Promise.resolve(new Response(null, { status })), expired, 1000);
    assertEquals(response.status, status);
  }
});

Deno.test('request: stalled auth or limiter returns 504 even if its library swallows abort', async () => {
  for (const stage of ['auth', 'limiter']) {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    let signal!: AbortSignal;
    let synthesisCalls = 0;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => { settled = resolve; });
    const response = await runTtsRequest(Date.now(), async (s) => {
      signal = s;
      try {
        // Model a library resolving an error result after abort instead of throwing.
        await stalled;
        s.throwIfAborted();
        synthesisCalls++;
        return new Response('audio');
      } finally {
        settled();
      }
    }, expired, 10);
    assertEquals(response.status, 504, stage);
    assert(signal.aborted, stage);
    release();
    await done;
    assertEquals(synthesisCalls, 0, stage);
  }
});

Deno.test('request: an abort-aware upstream is cancelled at the request deadline', async () => {
  let cancelled = false;
  const response = await runTtsRequest(Date.now(), (signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      cancelled = true;
      reject(signal.reason);
    }, { once: true });
  }), expired, 10);
  assertEquals(response.status, 504);
  assert(cancelled);
});

Deno.test('request: unexpected failures propagate and do not leak deadline timers', async () => {
  await assertRejects(() => runTtsRequest(Date.now(), () => Promise.reject(new Error('unexpected')), expired, 1000), Error, 'unexpected');
});

Deno.test('error body: an aborted non-2xx body preserves the status and permits metrics cleanup', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new DOMException('deadline', 'TimeoutError'));
    },
  });
  const upstream = new Response(body, { status: 429 });
  const detail = await readTtsErrorBody(upstream);
  assertEquals(detail, '');
  assertEquals(upstream.status, 429);
  assertEquals(await readTtsErrorBody(new Response('x'.repeat(500), { status: 500 })), 'x'.repeat(200));
});

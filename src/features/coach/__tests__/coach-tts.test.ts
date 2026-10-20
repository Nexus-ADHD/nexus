import { describe, expect, it, vi } from 'vitest';
import { fetch as expoFetch } from 'expo/fetch';
import { aiProxyRequest } from '../../../utils/ai-client';
import { synthesizeSpeech, TTS_MAX_CHARS, ttsEligible, ttsFileName } from '../coach-tts';

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class { uri = 'file://test.mp3'; write = vi.fn(); }, Paths: { cache: {} } }));
vi.mock('../../../utils/ai-client', () => ({ aiProxyRequest: vi.fn() }));


describe('coach-tts pure decisions', () => {
  it('speaks a non-empty reply up to the proxy cap and nothing beyond it', () => {
    expect(ttsEligible('One rep.')).toBe(true);
    expect(ttsEligible('   ')).toBe(false);
    expect(ttsEligible('x'.repeat(TTS_MAX_CHARS))).toBe(true);
    expect(ttsEligible('x'.repeat(TTS_MAX_CHARS + 1))).toBe(false);
  });

  it('names clips so two quick turns never share a file', () => {
    expect(ttsFileName(1000, 1)).not.toBe(ttsFileName(1000, 2));
    expect(ttsFileName(1000, 1)).toMatch(/^coach-tts-1000-1\.mp3$/);
  });
});

describe('speech provider attribution', () => {
  it.each([
    ['elevenlabs', 'elevenlabs'], ['openai', 'openai'], [null, 'unknown'], ['unexpected', 'unknown'],
  ])('retains only recognized provider header %s', async (header, expected) => {
    vi.mocked(aiProxyRequest).mockResolvedValue({ url: 'https://test.invalid/tts', headers: {}, diagnostics: { sessionFallback: false, sessionMs: 0 } });
    vi.mocked(expoFetch).mockResolvedValue({
      ok: true, headers: new Headers(header ? { 'X-Tts-Provider': header } : {}),
      bytes: async () => new Uint8Array(128),
    } as Awaited<ReturnType<typeof expoFetch>>);
    const clip = await synthesizeSpeech('Today, return.');
    expect(clip.provider).toBe(expected);
    expect(clip.uri).toBe('file://test.mp3');
  });
});

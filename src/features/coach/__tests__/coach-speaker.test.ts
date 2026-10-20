import { beforeEach, describe, expect, it, vi } from 'vitest';

const av = vi.hoisted(() => ({
  createAsync: vi.fn(),
  setAudioModeAsync: vi.fn(async () => {}),
}));
const files = vi.hoisted(() => ({ discarded: [] as string[] }));

vi.mock('expo-av', () => ({
  Audio: { Sound: { createAsync: av.createAsync }, setAudioModeAsync: av.setAudioModeAsync },
}));
vi.mock('../coach-tts', () => ({ discardSpeechFile: (uri: string) => files.discarded.push(uri) }));

import { createCoachSpeaker } from '../coach-speaker';

function fakeSound() {
  return { stopAsync: vi.fn(async () => {}), unloadAsync: vi.fn(async () => {}) };
}

describe('createCoachSpeaker (Greptile T-Rex, PR #492)', () => {
  beforeEach(() => {
    av.createAsync.mockReset();
    files.discarded.length = 0;
  });

  it('a native load failure REJECTS play() so the caller can fall back to the system voice, and drops the clip', async () => {
    av.createAsync.mockRejectedValueOnce(new Error('AVPlayer cannot decode'));
    const speaker = createCoachSpeaker();
    await expect(speaker.play('file:///cache/a.mp3')).rejects.toThrow(/cannot decode/);
    expect(files.discarded).toEqual(['file:///cache/a.mp3']);
    expect(speaker.isSpeaking()).toBe(false);
  });

  it('stop() during active playback unloads the sound AND deletes its clip', async () => {
    const sound = fakeSound();
    let statusCb: ((s: any) => void) | null = null;
    av.createAsync.mockImplementationOnce(async (_src: unknown, _init: unknown, cb: (s: any) => void) => {
      statusCb = cb;
      return { sound };
    });
    const speaker = createCoachSpeaker();
    const playing = speaker.play('file:///cache/b.mp3');
    await new Promise((r) => setTimeout(r, 0));
    expect(speaker.isSpeaking()).toBe(true);
    await speaker.stop();
    expect(sound.stopAsync).toHaveBeenCalled();
    expect(sound.unloadAsync).toHaveBeenCalled();
    expect(files.discarded).toEqual(['file:///cache/b.mp3']);
    expect(speaker.isSpeaking()).toBe(false);
    // The playback promise settles once a status arrives or is otherwise irrelevant after stop.
    statusCb?.({ isLoaded: true, didJustFinish: true });
    await playing;
  });

  it('a clip that finishes on its own is unloaded once and its file deleted once', async () => {
    const sound = fakeSound();
    let statusCb: ((s: any) => void) | null = null;
    av.createAsync.mockImplementationOnce(async (_src: unknown, _init: unknown, cb: (s: any) => void) => {
      statusCb = cb;
      return { sound };
    });
    const speaker = createCoachSpeaker();
    const playing = speaker.play('file:///cache/c.mp3');
    await new Promise((r) => setTimeout(r, 0));
    statusCb?.({ isLoaded: true, didJustFinish: true });
    await playing;
    expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
    expect(files.discarded).toEqual(['file:///cache/c.mp3']);
  });

  it('a stop() that races the load drops the late sound and its clip', async () => {
    const sound = fakeSound();
    let resolveCreate: (v: unknown) => void = () => {};
    av.createAsync.mockImplementationOnce(() => new Promise((r) => { resolveCreate = r; }));
    const speaker = createCoachSpeaker();
    const playing = speaker.play('file:///cache/d.mp3');
    // Let play() reach the native load, then stop while it is in flight.
    for (let i = 0; i < 10 && av.createAsync.mock.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(av.createAsync).toHaveBeenCalledTimes(1);
    await speaker.stop();
    resolveCreate({ sound });
    await playing;
    expect(sound.unloadAsync).toHaveBeenCalled();
    expect(files.discarded).toContain('file:///cache/d.mp3');
    expect(speaker.isSpeaking()).toBe(false);
  });
});

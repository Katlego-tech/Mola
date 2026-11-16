import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVoicePlayer } from '../src/lib/voice';

let audio: HTMLAudioElement;
beforeEach(() => {
  audio = document.createElement('audio');
  vi.stubGlobal('Audio', vi.fn(function () { return audio; }));
  vi.spyOn(audio, 'play').mockResolvedValue();
  vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('plays queued audio only after the previous clip ends', () => {
  const player = createVoicePlayer();
  const failed = vi.fn();
  player.play('/voice/first.mp3', failed);
  player.play('/voice/second.mp3', failed);
  expect(audio.getAttribute('src')).toBe('/voice/first.mp3');
  expect(audio.play).toHaveBeenCalledTimes(1);
  audio.dispatchEvent(new Event('ended'));
  expect(audio.getAttribute('src')).toBe('/voice/second.mp3');
  expect(audio.play).toHaveBeenCalledTimes(2);
  expect(failed).not.toHaveBeenCalled();
});

it('reports a rejected play and continues with the next clip', async () => {
  vi.mocked(audio.play).mockRejectedValueOnce(new Error('blocked'));
  const player = createVoicePlayer();
  const failed = vi.fn();
  player.play('/voice/first.mp3', failed);
  player.play('/voice/second.mp3', failed);
  await Promise.resolve();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(audio.getAttribute('src')).toBe('/voice/second.mp3');
});

it('reports a failed audio download and continues', () => {
  const player = createVoicePlayer();
  const failed = vi.fn();
  player.play('/voice/first.mp3', failed);
  player.play('/voice/second.mp3', failed);
  audio.dispatchEvent(new Event('error'));
  expect(failed).toHaveBeenCalledTimes(1);
  expect(audio.getAttribute('src')).toBe('/voice/second.mp3');
});

it('stops playback and discards queued clips when disabled', () => {
  const player = createVoicePlayer();
  player.play('/voice/first.mp3', vi.fn());
  player.play('/voice/second.mp3', vi.fn());
  player.stop();
  audio.dispatchEvent(new Event('ended'));
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(audio.play).toHaveBeenCalledTimes(1);
});

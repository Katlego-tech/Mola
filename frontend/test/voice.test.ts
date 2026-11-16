import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createVoicePlayer, useVoice } from '../src/lib/voice';

let audio: HTMLAudioElement;
beforeEach(() => {
  localStorage.clear();
  audio = document.createElement('audio');
  vi.stubGlobal('Audio', vi.fn(function () { return audio; }));
  vi.spyOn(audio, 'play').mockResolvedValue();
  vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

it.each(['bad_ticket', 'internal'] as const)('passes ambiguous %s errors through while releasing the pending speech request', code => {
  localStorage.setItem('test-voice', 'true');
  const { result } = renderHook(() => useVoice('test-voice'));
  const send = vi.fn();
  act(() => {
    result.current.call(7, send);
    result.current.call(8, send);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.current.receive({ type: 'error', code, message: 'Try again.' })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith({ action: 'speak', what: 'call', ticketNo: 8 });
});

it('consumes a voice error and leaves unrelated errors for other handlers', () => {
  localStorage.setItem('test-voice', 'true');
  const { result } = renderHook(() => useVoice('test-voice'));
  const send = vi.fn();
  result.current.call(7, send);
  expect(result.current.receive({ type: 'error', code: 'desk_busy', message: 'Busy.' })).toBe(false);
  expect(result.current.receive({ type: 'error', code: 'voice_unavailable', message: 'Unavailable.' })).toBe(true);
  expect(result.current.receive({ type: 'speech', what: 'call', ticketNo: 7, url: '/voice/first.mp3' })).toBe(false);
});

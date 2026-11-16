import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const resume = vi.fn();
const source = { buffer: null, connect: vi.fn(), start: vi.fn() };
const createBuffer = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  resume.mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    sampleRate = 44100;
    destination = {};
    resume = resume;
    createBuffer = createBuffer;
    createBufferSource() { return source; }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('resumes the chime context and starts a silent buffer before reporting unlocked', async () => {
  const { isSoundUnlocked, unlockSound } = await import('../src/lib/alerts');
  expect(isSoundUnlocked()).toBe(false);
  const unlocking = unlockSound();
  expect(resume).toHaveBeenCalledOnce();
  expect(createBuffer).toHaveBeenCalledWith(1, 1, 44100);
  expect(source.connect).toHaveBeenCalledOnce();
  expect(source.start).toHaveBeenCalledOnce();
  expect(isSoundUnlocked()).toBe(false);
  await unlocking;
  expect(isSoundUnlocked()).toBe(true);
});

it('keeps sound locked after a rejected resume and allows another gesture to retry', async () => {
  const { isSoundUnlocked, unlockSound } = await import('../src/lib/alerts');
  resume.mockRejectedValueOnce(new Error('blocked'));
  await unlockSound();
  expect(isSoundUnlocked()).toBe(false);
  await unlockSound();
  expect(isSoundUnlocked()).toBe(true);
});

it('keeps vibration available on supporting phones and tolerates its absence', async () => {
  const { buzz } = await import('../src/lib/alerts');
  const vibrate = vi.fn();
  vi.stubGlobal('navigator', { vibrate });
  buzz();
  expect(vibrate).toHaveBeenCalledWith([400, 200, 400]);
  vi.stubGlobal('navigator', {});
  expect(() => buzz()).not.toThrow();
});

// The "it's your turn" alerts (web.md 4.1). Each one is feature-detected; a phone without it simply
// goes without, and the green screen still says it.

let audio: AudioContext | null = null;
let unlocked = false;

export function isSoundUnlocked(): boolean { return unlocked; }

/** Called from a tap ("Get a number", or the first tap after a resume): browsers only let a page
 *  make sound after the person has touched it. */
export async function unlockSound(): Promise<void> {
  if (unlocked && audio?.state === 'running') return;
  try {
    audio ??= new AudioContext();
    const resumed = audio.resume();
    const source = audio.createBufferSource();
    source.buffer = audio.createBuffer(1, 1, audio.sampleRate);
    source.connect(audio.destination);
    source.start();
    await resumed;
    unlocked = true;
  } catch {
    unlocked = false;
  }
}

/** Two short notes, generated, so there is no sound file to ship. */
export function chime(): void {
  if (!audio) return;
  const start = audio.currentTime;
  for (const [i, freq] of [660, 880].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + i * 0.22);
    gain.gain.exponentialRampToValueAtTime(0.3, start + i * 0.22 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.22 + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + i * 0.22);
    osc.stop(start + i * 0.22 + 0.21);
  }
}

export function buzz(): void {
  navigator.vibrate?.([400, 200, 400]);
}

/** Keeps the screen on while a ticket is active, where the browser allows it. */
export async function holdWakeLock(): Promise<(() => void) | null> {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return lock ? () => void lock.release() : null;
  } catch {
    return null;
  }
}

import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from './messages';

type Playback = { url: string; failed(): void };
export function createVoicePlayer() {
  let audio: HTMLAudioElement | null = null;
  let silence: AudioContext | null = null;
  const releaseSilence = () => {
    if (audio) audio.srcObject = null;
    void silence?.close().catch(() => undefined);
    silence = null;
  };
  let current: Playback | null = null;
  const queue: Playback[] = [];
  let generation = 0;
  const element = () => audio ??= new Audio();
  const next = () => {
    if (current || !queue.length) return;
    current = queue.shift() ?? null;
    if (!current) return;
    const playing = current;
    const version = ++generation;
    const player = element();
    releaseSilence();
    const finish = (failed: boolean) => {
      if (generation !== version || current !== playing) return;
      current = null;
      if (failed) playing.failed();
      next();
    };
    player.onended = () => finish(false);
    player.onerror = () => finish(true);
    player.src = playing.url;
    try { void player.play().catch(() => finish(true)); }
    catch { finish(true); }
  };
  const stop = () => {
    generation += 1;
    releaseSilence();
    queue.length = 0;
    current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
  };
  return {
    unlock(failed: () => void) {
      if (current) return;
      const version = ++generation;
      const player = element();
      try {
        // A silent live stream unlocks this element without fetching audio or widening the CSP.
        releaseSilence();
        silence = new AudioContext();
        player.srcObject = silence.createMediaStreamDestination().stream;
        const rejected = () => { if (generation === version) failed(); };
        void silence.resume().catch(rejected);
        void player.play().catch(rejected);
      } catch { failed(); }
    },
    play(url: string, failed: () => void) { queue.push({ url, failed }); next(); },
    stop,
  };
}

type Speak = Extract<ClientMessage, { action: 'speak' }>;
type Request = { message: Speak; send(message: ClientMessage): void; failed(): void };

export function useVoice(storageKey: string) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'true'; }
    catch { return false; }
  });
  const enabledRef = useRef(enabled);
  const [hint, setHint] = useState(false);
  const [player] = useState(createVoicePlayer);
  const requests = useRef<Request[]>([]);
  const pending = useRef<Request | null>(null);
  const persist = (value: boolean) => {
    enabledRef.current = value;
    setEnabled(value);
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* Storage may be disabled. */ }
  };
  const blocked = () => {
    persist(false);
    setHint(true);
    player.stop();
    requests.current = requests.current.filter(request => request.message.what !== 'call');
  };
  const pump = () => {
    if (pending.current) return;
    pending.current = requests.current.shift() ?? null;
    if (pending.current) pending.current.send(pending.current.message);
  };
  const request = (message: Speak, send: Request['send'], failed: () => void) => {
    requests.current.push({ message, send, failed });
    pump();
  };
  const interrupt = useCallback(() => {
    pending.current?.failed();
    requests.current.forEach(request => request.failed());
    pending.current = null;
    requests.current = [];
    player.stop();
  }, [player]);
  useEffect(() => () => player.stop(), [player]);
  return {
    enabled, hint,
    toggle() {
      const next = !enabledRef.current;
      persist(next);
      setHint(false);
      if (next) player.unlock(blocked);
      else {
        player.stop();
        requests.current = requests.current.filter(request => request.message.what !== 'call');
      }
    },
    call(ticketNo: number, send: Request['send']) {
      if (enabledRef.current) request({ action: 'speak', what: 'call', ticketNo }, send, () => undefined);
    },
    listen(ticketNo: number, secret: string, text: string, send: Request['send'], failed: () => void) {
      player.unlock(failed);
      request({ action: 'speak', what: 'answer', ticketNo, secret, text }, send, failed);
    },
    receive(message: ServerMessage) {
      const held = pending.current;
      if (!held) return false;
      if (message.type === 'speech' && message.what === held.message.what && message.ticketNo === held.message.ticketNo) {
        pending.current = null;
        if (message.what === 'answer' || enabledRef.current) {
          player.play(message.url, message.what === 'call' ? blocked : held.failed);
        }
        pump();
        return true;
      } else if (message.type === 'error' && (message.code === 'voice_unavailable' || message.code === 'bad_ticket' || message.code === 'internal')) {
        pending.current = null;
        held.failed();
        pump();
        return true;
      }
      return false;
    },
    interrupt,
  };
}

export const VoiceContext = createContext<Pick<ReturnType<typeof useVoice>, 'enabled' | 'hint' | 'toggle'> | null>(null);

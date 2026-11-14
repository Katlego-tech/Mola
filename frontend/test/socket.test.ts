import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocket, type SocketState } from '../src/lib/socket';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  disconnect() { this.readyState = 3; this.onclose?.(); }
  message(data: string) { this.onmessage?.({ data }); }
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('Expected a WebSocket');
  return socket;
}

function setup() {
  const states: SocketState[] = [];
  const onMessage = vi.fn<(msg: { type: string }) => void>();
  const onOpen = vi.fn();
  const client = createSocket<{ type: string }, { action: string }>('wss://queue.test', {
    onMessage,
    onState: (state) => { states.push(state); },
    onOpen,
  });
  return { client, states, onMessage, onOpen };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createSocket', () => {
  it('connects to the URL, reports open, and permits sending from onOpen', () => {
    const { client, states, onOpen } = setup();
    onOpen.mockImplementation(() => { client.send({ action: 'resume' }); });
    expect(latestSocket().url).toBe('wss://queue.test');
    expect(states).toEqual(['connecting']);
    latestSocket().open();
    expect(states).toEqual(['connecting', 'open']);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(latestSocket().sent).toEqual(['{"action":"resume"}']);
  });

  it('parses incoming JSON and drops invalid JSON without stopping later messages', () => {
    const { onMessage } = setup();
    latestSocket().open();
    latestSocket().message('{"type":"status"}');
    latestSocket().message('not JSON');
    latestSocket().message('{"type":"ticket"}');
    expect(onMessage.mock.calls).toEqual([[{ type: 'status' }], [{ type: 'ticket' }]]);
  });

  it('supports arbitrary JSON wire types without adding schema validation', () => {
    const onMessage = vi.fn<(msg: number) => void>();
    const client = createSocket<number, string>('wss://queue.test', {
      onMessage, onState: vi.fn(), onOpen: vi.fn(),
    });
    latestSocket().open();
    latestSocket().message('42');
    client.send('hello');
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(42);
    expect(latestSocket().sent).toEqual(['"hello"']);
  });

  it('reconnects on the exponential schedule, capped at a 30 second base', () => {
    const { states, onOpen } = setup();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = FakeWebSocket.instances.length;
      latestSocket().disconnect();
      expect(states.at(-1)).toBe('backoff');
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
      expect(states.at(-1)).toBe('connecting');
    }
    latestSocket().open();
    latestSocket().disconnect();
    vi.advanceTimersByTime(1000);
    latestSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it.each([0, 0.5, 0.999999])('applies ±20 percent jitter at random=%s', (random) => {
    vi.mocked(Math.random).mockReturnValue(random);
    setup();
    latestSocket().disconnect();
    const delay = Math.floor(1000 * (0.8 + random * 0.4));
    vi.advanceTimersByTime(delay - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('handles an opening error followed by close as a single failed attempt', () => {
    const { states } = setup();
    const failed = latestSocket();
    failed.onerror?.();
    failed.disconnect();
    expect(failed.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'backoff']);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    failed.open();
    failed.disconnect();
    expect(states).toEqual(['connecting', 'backoff', 'connecting']);
    latestSocket().disconnect();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('drops sends while connecting, in backoff, or closed without queuing them', () => {
    const { client } = setup();
    client.send({ action: 'connecting' });
    latestSocket().disconnect();
    client.send({ action: 'backoff' });
    vi.advanceTimersByTime(1000);
    latestSocket().open();
    expect(latestSocket().sent).toEqual([]);
    client.send({ action: 'watch' });
    client.close();
    client.send({ action: 'closed' });
    expect(latestSocket().sent).toEqual(['{"action":"watch"}']);
  });

  it('pings every five minutes only while open and restarts the interval on reconnect', () => {
    const { client } = setup();
    vi.advanceTimersByTime(300_000);
    const first = latestSocket();
    expect(first.sent).toEqual([]);
    first.open();
    vi.advanceTimersByTime(299_999);
    expect(first.sent).toEqual([]);
    vi.advanceTimersByTime(300_001);
    expect(first.sent).toEqual(['{"action":"ping"}', '{"action":"ping"}']);
    first.disconnect();
    vi.advanceTimersByTime(600_000);
    expect(first.sent).toHaveLength(2);
    const second = latestSocket();
    second.open();
    vi.advanceTimersByTime(299_999);
    expect(second.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(second.sent).toEqual(['{"action":"ping"}']);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['connecting', 'open', 'backoff'] as const)('closes permanently from %s', (state) => {
    const { client, states, onOpen, onMessage } = setup();
    const socket = latestSocket();
    if (state === 'open') socket.open();
    if (state === 'backoff') socket.disconnect();
    client.close();
    client.close();
    expect(states.at(-1)).toBe('closed');
    expect(states.filter((value) => value === 'closed')).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledOnce();
    socket.open();
    socket.onerror?.();
    socket.disconnect();
    socket.message('{"type":"status"}');
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onOpen).toHaveBeenCalledTimes(state === 'open' ? 1 : 0);
    expect(onMessage).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

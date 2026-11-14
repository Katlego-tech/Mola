export type SocketState = 'connecting' | 'open' | 'backoff' | 'closed';

export function createSocket<In, Out>(
  url: string,
  opts: {
    onMessage(msg: In): void;
    onState(state: SocketState): void;
    onOpen(): void;
  },
): { send(msg: Out): void; close(): void } {
  let state: SocketState = 'connecting';
  let socket: WebSocket;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function setState(next: SocketState): void {
    state = next;
    opts.onState(next);
  }

  function stopHeartbeat(): void {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function connect(): void {
    const current = new WebSocket(url);
    socket = current;
    let failed = false;
    const isActive = () => state !== 'closed' && socket === current && !failed;

    function backoff(): void {
      if (!isActive()) return;
      failed = true;
      stopHeartbeat();
      const wait = delay * (0.8 + Math.random() * 0.4);
      delay = Math.min(delay * 2, 30_000);
      retry = setTimeout(() => {
        retry = undefined;
        setState('connecting');
        if (state !== 'closed') connect();
      }, wait);
      setState('backoff');
    }

    current.onopen = () => {
      if (!isActive() || state !== 'connecting') return;
      delay = 1000;
      heartbeat = setInterval(() => {
        if (isActive() && current.readyState === WebSocket.OPEN) {
          current.send('{"action":"ping"}');
        }
      }, 300_000);
      setState('open');
      if (isActive()) opts.onOpen();
    };
    current.onmessage = (event: MessageEvent<string>) => {
      if (!isActive()) return;
      let message: In;
      try {
        message = JSON.parse(event.data) as In;
      } catch {
        return;
      }
      opts.onMessage(message);
    };
    current.onclose = backoff;
    current.onerror = () => {
      if (!isActive() || state !== 'connecting') return;
      backoff();
      current.close();
    };
  }

  setState('connecting');
  connect();

  return {
    send(msg) {
      if (state === 'open' && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    close() {
      if (state === 'closed') return;
      clearTimeout(retry);
      retry = undefined;
      stopHeartbeat();
      setState('closed');
      socket.close();
    },
  };
}

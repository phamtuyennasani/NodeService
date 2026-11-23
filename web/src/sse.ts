import { signedFetch } from './api';

export type SseEvent = { type: string; data: string };

/** Incremental UTF-8/event parser. Incomplete events at EOF are discarded. */
export function createSseDecoder(receive: (event: SseEvent) => void, maxBuffer = 64 * 1024) {
  const decoder = new TextDecoder();
  let line = '';
  let eventType = '';
  let data: string[] = [];
  let dataLength = 0;
  let frameLength = 0;
  let skipLf = false;
  let finished = false;
  function checkSize() {
    if (frameLength > maxBuffer || line.length + eventType.length + dataLength > maxBuffer) throw new RangeError('SSE event exceeded the buffer limit.');
  }
  function acceptLine() {
    const value = line;
    line = '';
    if (value === '') {
      const event = data.length ? { type: eventType || 'message', data: data.join('\n') } : undefined;
      eventType = ''; data = []; dataLength = 0; frameLength = 0;
      if (event) receive(event);
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventType = content;
    if (field === 'data') {
      data.push(content);
      dataLength += content.length + 1;
    }
    checkSize();
  }
  function consume(text: string) {
    for (const character of text) {
      if (skipLf) {
        skipLf = false;
        if (character === '\n') continue;
      }
      frameLength++;
      checkSize();
      if (character === '\r' || character === '\n') {
        acceptLine();
        skipLf = character === '\r';
      } else {
        line += character;
        checkSize();
      }
    }
  }
  return {
    push(chunk: Uint8Array) {
      if (finished) throw new Error('SSE decoder is already finished.');
      consume(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      if (finished) return;
      finished = true;
      consume(decoder.decode());
      line = ''; eventType = ''; data = []; dataLength = 0; frameLength = 0;
    },
  };
}

/** Every reconnect goes through signedFetch and obtains a fresh browser proof. */
export function subscribeCrmEvents(path: string, handlers: Record<string, (payload: string) => void>): () => void {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const emit = (type: string, payload = '') => {
    if (stopped || !Object.prototype.hasOwnProperty.call(handlers, type)) return;
    try { handlers[type](payload); } catch { /* One consumer cannot interrupt stream parsing. */ }
  };
  async function connect() {
    if (stopped) return;
    const active = new AbortController();
    controller = active;
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const startedAt = Date.now();
    let terminal = false;
    try {
      const response = await signedFetch(path, {
        headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal: active.signal,
      });
      if (stopped) { await response.body?.cancel(); return; }
      if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel();
        throw new Error('CRM did not return an event stream.');
      }
      stream = response.body.getReader();
      reader = stream;
      emit('open');
      const decoder = createSseDecoder(event => emit(event.type, event.data));
      while (!stopped) {
        const chunk = await stream.read();
        if (chunk.done) { decoder.finish(); break; }
        decoder.push(chunk.value);
      }
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      terminal = status === 401 || status === 403;
    } finally {
      if (stream) {
        await stream.cancel().catch(() => undefined);
        stream.releaseLock();
      }
      if (reader === stream) reader = undefined;
      if (controller === active) controller = undefined;
    }
    if (stopped) return;
    emit('error');
    if (stopped) return;
    if (terminal) { stopped = true; return; }
    if (Date.now() - startedAt >= 30_000) attempts = 0;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  }
  void connect();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
    void reader?.cancel().catch(() => undefined);
  };
}

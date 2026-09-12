import type { EngineEvent } from '../shared/protocol';

export class SseDecoder {
  private buffer = '';
  push(chunk: string): EngineEvent[] {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) throw new Error('SSE_EVENT_TOO_LARGE');
    const events: EngineEvent[] = [];
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      let id = ''; const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const event = JSON.parse(data.join('\n')) as EngineEvent;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || String(event.sequence) !== id || typeof event.type !== 'string' || typeof event.timestamp !== 'string' || !event.payload || typeof event.payload !== 'object') throw new Error('INVALID_SSE_EVENT');
      events.push(event);
    }
    return events;
  }
}

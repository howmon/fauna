// Minimal typed event emitter (no deps)

type Handler = (...args: any[]) => void;

export class EventEmitter {
  private _handlers: Record<string, Handler[]> = {};

  on(event: string, handler: Handler) {
    (this._handlers[event] ??= []).push(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler) {
    const list = this._handlers[event];
    if (list) this._handlers[event] = list.filter((h) => h !== handler);
  }

  emit(event: string, ...args: any[]) {
    this._handlers[event]?.forEach((h) => h(...args));
  }
}

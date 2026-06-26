const MAX_EVENTS = 500;
const _events = [];

export function recordSecurityEvent(event = {}) {
  const entry = {
    id: 'sec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    type: event.type || 'security-event',
    severity: event.severity || 'info',
    surface: event.surface || 'unknown',
    message: event.message || '',
    details: event.details || {},
  };
  _events.push(entry);
  if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);
  return entry;
}

export function listSecurityEvents({ limit = 50, type } = {}) {
  let events = _events;
  if (type) events = events.filter(e => e.type === type);
  return events.slice(-Math.max(0, Math.min(500, Number(limit) || 50))).reverse();
}

export function clearSecurityEvents() {
  _events.splice(0, _events.length);
}

import { randomUUID } from 'node:crypto';

export const EXECUTION_EVENT_SCHEMA_VERSION = 1;

export function createExecutionEvent(event = {}, opts = {}) {
  const timestamp = [event.timestamp, event.ts, opts.timestamp]
    .map(value => Number(value))
    .find(value => Number.isFinite(value) && value > 0) || Date.now();
  const stamped = {
    ...event,
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: event.eventId || randomUUID(),
    timestamp,
    source: event.source || opts.source || 'run-ledger',
    ts: timestamp,
  };

  if (stamped.correlationId == null && stamped.runId) stamped.correlationId = stamped.runId;
  return stamped;
}
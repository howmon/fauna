// Fauna Mobile — API client for communicating with the Fauna server
// Connects over LAN using the host + token obtained via QR pairing

import { EventEmitter } from './events';

let _baseUrl = '';
let _token = '';

export function configure(host: string, port: number, token: string) {
  _baseUrl = `http://${host}:${port}`;
  _token = token;
}

export function isConfigured(): boolean {
  return !!_baseUrl;
}

export function getBaseUrl(): string {
  return _baseUrl;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (_token) h['X-Fauna-Token'] = _token;
  return h;
}

// ── REST helpers ──────────────────────────────────────────────────────────

async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${_baseUrl}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${_baseUrl}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPut<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${_baseUrl}${path}`, {
    method: 'PUT',
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await fetch(`${_baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── System ────────────────────────────────────────────────────────────────

export async function getSystemContext() {
  return apiGet('/api/system-context');
}

export async function getModels() {
  return apiGet<any[]>('/api/models');
}

export async function getAgents() {
  const data = await apiGet<{ agents: any[] }>('/api/agents');
  return data.agents;
}

// ── Chat (SSE streaming) ─────────────────────────────────────────────────

export interface ChatEvent {
  type: 'content' | 'tool_call' | 'tool_output' | 'tool_waiting_for_input' | 'error' | 'done';
  content?: string;
  name?: string;
  arguments?: string;
  output?: string;
  error?: string;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function streamChat(
  messages: Array<{ role: string; content: string | any[] }>,
  options: { model?: string; agentName?: string } = {},
  onEvent: (evt: ChatEvent) => void,
): AbortController {
  const controller = new AbortController();
  const body = { messages, ...options };

  // Use XMLHttpRequest instead of fetch — React Native's fetch doesn't support
  // ReadableStream/getReader() on Android, so SSE streaming silently fails.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${_baseUrl}/api/chat`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  if (_token) xhr.setRequestHeader('X-Fauna-Token', _token);

  let seenBytes = 0;
  let buffer = '';

  xhr.onprogress = () => {
    const newData = xhr.responseText.slice(seenBytes);
    seenBytes = xhr.responseText.length;
    buffer += newData;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch {}
    }
  };

  xhr.onload = () => {
    // Process any remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch {}
      }
    }
    onEvent({ type: 'done' });
  };

  xhr.onerror = () => {
    onEvent({ type: 'error', error: 'Network error' });
  };

  // Wire up AbortController
  controller.signal.addEventListener('abort', () => xhr.abort());

  xhr.send(JSON.stringify(body));

  return controller;
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function getTasks() {
  return apiGet<any[]>('/api/tasks');
}

export async function getTask(id: string) {
  return apiGet(`/api/tasks/${id}`);
}

export async function createTask(task: any) {
  return apiPost('/api/tasks', task);
}

export async function updateTask(id: string, updates: any) {
  return apiPut(`/api/tasks/${id}`, updates);
}

export async function deleteTask(id: string) {
  return apiDelete(`/api/tasks/${id}`);
}

export async function runTask(id: string) {
  return apiPost(`/api/tasks/${id}/run`);
}

export async function stopTask(id: string) {
  return apiPost(`/api/tasks/${id}/stop`);
}

export async function steerTask(id: string, message: string) {
  return apiPost(`/api/tasks/${id}/steer`, { message });
}

// SSE stream for live task updates
export function streamTasks(onEvent: (evt: any) => void): () => void {
  const controller = new AbortController();

  fetch(`${_baseUrl}/api/tasks/stream`, {
    headers: headers(),
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    })
    .catch(() => {});

  return () => controller.abort();
}

// Single task SSE stream
export function streamTask(id: string, onEvent: (evt: any) => void): () => void {
  const controller = new AbortController();

  fetch(`${_baseUrl}/api/tasks/${id}/stream`, {
    headers: headers(),
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    })
    .catch(() => {});

  return () => controller.abort();
}

// ── Pairing ───────────────────────────────────────────────────────────────

export async function verifyConnection(): Promise<boolean> {
  try {
    // If we get a 200 response, the mobile token was accepted
    await getSystemContext();
    return true;
  } catch {
    return false;
  }
}

// ── Conversations ─────────────────────────────────────────────────────────

export async function getConversations() {
  return apiGet<any[]>('/api/conversations');
}

export async function getConversation(id: string) {
  return apiGet(`/api/conversations/${id}`);
}

export async function deleteConversation(id: string) {
  return apiDelete(`/api/conversations/${id}`);
}

export async function saveConversation(id: string, conv: any) {
  return apiPut(`/api/conversations/${id}`, conv);
}

// Fauna Mobile — API client for communicating with the Fauna server
// Connects over LAN using the host + token obtained via QR pairing

import { EventEmitter } from './events';

let _baseUrl = '';
let _token = '';

export function configure(host: string, port: number, token: string) {
  _baseUrl = `http://${host}:${port}`;
  _token = token;
}

// Configure with a full URL (for tunnel connections)
export function configureUrl(url: string, token: string) {
  _baseUrl = url.replace(/\/+$/, '');
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

async function apiPatch<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${_baseUrl}${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── System ────────────────────────────────────────────────────────────────

export async function getSystemContext() {
  return apiGet('/api/system-context');
}

export async function getModels() {
  const data = await apiGet<{ models: any[] }>('/api/models');
  return Array.isArray(data) ? data : (data?.models || []);
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
  options: { model?: string; agentName?: string; systemPrompt?: string; instruction?: string; projectId?: string | null; conversationId?: string } = {},
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

// ── Shell exec ───────────────────────────────────────────────────────────

export async function shellExec(command: string): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return apiPost('/api/shell-exec', { command });
}

export async function extCommand(action: string, params: Record<string, any> = {}, tabId?: number): Promise<any> {
  return apiPost('/api/ext/command', { action, params, tabId: tabId ?? null });
}

export async function extStatus(): Promise<{ ok: boolean; browsers: any[] }> {
  return apiGet('/api/ext/status');
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
    // Abort after 5 seconds so the app doesn't hang on an unreachable server
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${_baseUrl}/api/system`, { headers: headers(), signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
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

export async function updateConversation(id: string, updates: any) {
  return apiPut(`/api/conversations/${id}`, updates);
}

// ── Preferences (playbook + agent rules + system prompt) ─────────────────

export interface Preferences {
  playbook: Array<{ id: string; title: string; body: string; enabled?: boolean; tags?: string[] }>;
  agentRules: Array<{ id: string; text: string; enabled?: boolean }>;
  systemPrompt: string;
}

export async function getPreferences(): Promise<Preferences> {
  try { return await apiGet<Preferences>('/api/preferences'); }
  catch (_) { return { playbook: [], agentRules: [], systemPrompt: '' }; }
}

// ── Projects ──────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  color: string;
  conversationIds: string[];
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export async function getProjects(): Promise<Project[]> {
  return apiGet<Project[]>('/api/projects');
}

export async function getProjectById(id: string): Promise<Project> {
  return apiGet<Project>(`/api/projects/${id}`);
}

export async function createProject(opts: { name: string; description?: string; color?: string }): Promise<Project> {
  return apiPost<Project>('/api/projects', opts);
}

export async function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'color'>>): Promise<Project> {
  return apiPut<Project>(`/api/projects/${id}`, patch);
}

export async function deleteProject(id: string): Promise<void> {
  return apiDelete(`/api/projects/${id}`);
}

export async function linkConversationToProject(projectId: string, convId: string): Promise<void> {
  return apiPost(`/api/projects/${projectId}/conversations`, { convId });
}

export async function touchProject(id: string): Promise<void> {
  return apiPost(`/api/projects/${id}/touch`);
}

// ── Project boards / work items ─────────────────────────────────────────

export interface WorkItem {
  id: string;
  title: string;
  body?: string;
  column?: string;
  assignee?: string;
  priority?: string;
  tags?: string[];
  comments?: Array<{ id?: string; author?: string; body: string; createdAt?: string }>;
  updatedAt?: string;
}

export interface ProjectBoard {
  projectId?: string;
  columns?: Array<{ id: string; title?: string; name?: string; items?: WorkItem[] }>;
  items?: WorkItem[];
  idle?: any;
}

export async function getProjectBoard(projectId: string): Promise<ProjectBoard> {
  return apiGet<ProjectBoard>(`/api/projects/${projectId}/board`);
}

export async function createWorkItem(projectId: string, item: Partial<WorkItem>): Promise<WorkItem> {
  return apiPost<WorkItem>(`/api/projects/${projectId}/workitems`, item);
}

export async function updateWorkItem(projectId: string, itemId: string, patch: Partial<WorkItem>): Promise<WorkItem> {
  return apiPatch<WorkItem>(`/api/projects/${projectId}/workitems/${itemId}`, patch);
}

export async function moveWorkItem(projectId: string, itemId: string, patch: { column?: string; assignee?: string; claimedBy?: string | null }): Promise<WorkItem> {
  return apiPost<WorkItem>(`/api/projects/${projectId}/workitems/${itemId}/move`, patch);
}

export async function sendWorkItemInstruction(projectId: string, itemId: string, body: string): Promise<any> {
  return apiPost(`/api/projects/${projectId}/workitems/${itemId}/comments`, { author: 'human', body });
}

export async function prioritizeProject(projectId: string, method: 'rice' | 'moscow' = 'rice'): Promise<any> {
  return apiPost(`/api/projects/${projectId}/prioritize`, { method });
}

export async function auditProject(projectId: string, opts: { maxProposals?: number; dryRun?: boolean } = {}): Promise<any> {
  return apiPost(`/api/projects/${projectId}/audit`, opts);
}

// ── Automations / workflows ─────────────────────────────────────────────

export interface WorkflowAutomation {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  schedule?: string;
  status?: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export async function getWorkflows(): Promise<WorkflowAutomation[]> {
  return apiGet<WorkflowAutomation[]>('/api/workflows');
}

export async function getWorkflow(id: string): Promise<WorkflowAutomation> {
  return apiGet<WorkflowAutomation>(`/api/workflows/${id}`);
}

export async function createWorkflow(workflow: Partial<WorkflowAutomation>): Promise<WorkflowAutomation> {
  return apiPost<WorkflowAutomation>('/api/workflows', workflow);
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowAutomation>): Promise<WorkflowAutomation> {
  return apiPut<WorkflowAutomation>(`/api/workflows/${id}`, patch);
}

export async function deleteWorkflow(id: string): Promise<void> {
  return apiDelete(`/api/workflows/${id}`);
}

export async function runWorkflowNow(id: string): Promise<any> {
  return apiPost(`/api/workflows/${id}/run-now`);
}

export async function getWorkflowHistory(id: string): Promise<any[]> {
  return apiGet<any[]>(`/api/workflows/${id}/history`);
}

export async function parseWorkflowSchedule(text: string): Promise<any> {
  return apiPost('/api/workflows/parse-schedule', { text });
}

// ── Accountless serverless sync controls ────────────────────────────────

export interface ServerlessPeer {
  id: string;
  name?: string;
  url?: string;
  createdAt?: string;
  lastSyncAt?: string;
  lastAutoSyncAt?: string;
  lastError?: { message?: string; at?: string } | null;
  lastStats?: any;
}

export interface ServerlessSyncSettings {
  autoSync: boolean;
  intervalMs: number;
  includeFiles: boolean;
  push: boolean;
}

export function parseServerlessPairingUrl(raw: string): { url: string; token: string; key: string; name?: string } {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'fauna:' || parsed.hostname !== 'serverless-sync') throw new Error('Not a Fauna serverless sync QR code');
  const url = parsed.searchParams.get('url') || '';
  const token = parsed.searchParams.get('token') || '';
  const key = parsed.searchParams.get('key') || '';
  const name = parsed.searchParams.get('device') || parsed.searchParams.get('name') || undefined;
  if (!url || !token || !key) throw new Error('Incomplete serverless sync QR data');
  return { url, token, key, name };
}

export async function getServerlessPeers(): Promise<{ ok: boolean; settings: ServerlessSyncSettings; peers: ServerlessPeer[]; shares: any[]; conflicts: any[] }> {
  return apiGet('/api/serverless-sync/peers');
}

export async function importServerlessPeer(pairingUrl: string, name?: string): Promise<any> {
  const parsed = parseServerlessPairingUrl(pairingUrl);
  return apiPost('/api/serverless-sync/import', { ...parsed, name: name || parsed.name });
}

export async function syncServerlessPeer(peerId: string, opts: { includeFiles?: boolean; push?: boolean } = {}): Promise<any> {
  return apiPost(`/api/serverless-sync/peers/${peerId}/sync`, opts);
}

export async function updateServerlessAutoSync(settings: Partial<ServerlessSyncSettings>): Promise<any> {
  return apiPost('/api/serverless-sync/auto-sync', settings);
}

export async function runServerlessAutoSync(force = true): Promise<any> {
  return apiPost('/api/serverless-sync/auto-sync/run', { force });
}

// ── Conversation title generation ────────────────────────────────────────

export async function getConversationTitle(
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  try {
    const data = await apiPost<{ title: string }>('/api/conversation-title', { messages });
    return data?.title || '';
  } catch (_) { return ''; }
}

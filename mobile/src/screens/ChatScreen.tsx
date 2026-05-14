// Chat screen — streaming AI conversation with rich text, images, artifacts, copy & share

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, useColorScheme, Image, Modal, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';
import MessageBubble, { type ParsedArtifact } from '../components/MessageBubble';
import ArtifactPanel from '../components/ArtifactPanel';

// ── System prompt helpers ─────────────────────────────────────────────────

const BUILTIN_RULES = [
  'Always write complete, executable shell commands inside code blocks — never output an empty code block for a command. Every code block must contain real commands.',
  'Never simulate or invent command output. Write the actual command and let the app run it.',
];

function buildSystemPrompt(prefs: api.Preferences): string {
  const parts: string[] = [];
  if (prefs.systemPrompt?.trim()) parts.push(prefs.systemPrompt.trim());
  const activeRules = [
    ...BUILTIN_RULES.map((t, i) => `${i + 1}. ${t}`),
    ...prefs.agentRules
      .filter(r => r.enabled !== false)
      .map((r, i) => `${BUILTIN_RULES.length + i + 1}. ${r.text}`),
  ];
  if (activeRules.length)
    parts.push('## Agent Rules (follow these strictly in every response)\n' + activeRules.join('\n'));
  const activePlaybook = prefs.playbook.filter(e => e.enabled !== false);
  if (activePlaybook.length)
    parts.push('## Playbook \u2014 Learned Instructions (apply these to relevant tasks)\n' +
      activePlaybook.map((e, i) => `### ${i + 1}. ${e.title}\n${e.body}`).join('\n\n'));
  return parts.join('\n\n');
}

interface MessageImage {
  uri: string;
  base64: string;
  mime: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  images?: MessageImage[];
}

export default function ChatScreen({ loadedConvRef, newChatRef }: { loadedConvRef?: { current: any }; newChatRef?: { current: (() => void) | null } }) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState('');
  const [convTitle, setConvTitle] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pendingImages, setPendingImages] = useState<MessageImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [activeArtifact, setActiveArtifact] = useState<ParsedArtifact | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const msgIdRef = useRef(0);
  const convIdRef = useRef<string>('conv-' + Date.now());
  const messagesRef = useRef<Message[]>([]);
  const systemPromptCtxRef = useRef<string>('');  // built from prefs, not reactive
  const autoTitledRef = useRef(false);

  const nextId = () => `msg-${++msgIdRef.current}`;

  // Keep messagesRef in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Save current conversation to server
  const saveCurrentConv = useCallback(async (msgs?: Message[], title?: string) => {
    const id = convIdRef.current;
    const m = msgs || messages;
    if (m.length === 0) return;
    const apiMsgs = m
      .filter(x => x.role === 'user' || (x.role === 'assistant' && x.content))
      .map(x => ({ role: x.role, content: x.content }));
    if (apiMsgs.length === 0) return;
    const convT = title || convTitle || (apiMsgs[0]?.content || '').slice(0, 60) || 'Mobile chat';
    try {
      await api.saveConversation(id, {
        id,
        title: convT,
        messages: apiMsgs,
        model: model || undefined,
        createdAt: parseInt(id.replace('conv-', '')) || Date.now(),
      });
    } catch {}
  }, [messages, convTitle, model]);

  // Register new chat handler for header button
  useEffect(() => {
    if (newChatRef) {
      newChatRef.current = () => {
        if (streaming) return;
        saveCurrentConv();
        setMessages([]);
        setInput('');
        setConvTitle('');
        setAgent('');
        setPendingImages([]);
        msgIdRef.current = 0;
        convIdRef.current = 'conv-' + Date.now();
        autoTitledRef.current = false;
      };
    }
    return () => { if (newChatRef) newChatRef.current = null; };
  }, [streaming, saveCurrentConv]);

  // Load agents list
  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  // Load models + preferences (playbook, agent rules, sys prompt) once on mount
  useEffect(() => {
    api.getModels().then((list: any[]) => setModels(list)).catch(() => {});
    api.getPreferences().then(prefs => {
      systemPromptCtxRef.current = buildSystemPrompt(prefs);
    }).catch(() => {});
  }, []);

  // Pick up loaded conversation when Chat tab is focused
  useFocusEffect(
    useCallback(() => {
      if (loadedConvRef?.current) {
        const conv = loadedConvRef.current;
        loadedConvRef.current = null;
        const msgs: Message[] = (conv.messages || [])
          .filter((m: any) => m.role === 'user' || m.role === 'assistant')
          .map((m: any) => ({ id: nextId(), role: m.role, content: typeof m.content === 'string' ? m.content : (m.content?.find?.((c: any) => c.type === 'text')?.text || '') }));
        setMessages(msgs);
        setConvTitle(conv.title || '');
        if (conv.model) setModel(conv.model);
        if (conv.id) convIdRef.current = conv.id;
      }
    }, [])
  );

  const scrollToEnd = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  // ── Image picker ────────────────────────────────────────────────────────

  // Max dimension for vision API — keeps base64 under ~500KB per image
  const IMG_MAX_PX = 1024;

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.5,
      base64: true,
      allowsMultipleSelection: true,
      exif: false,
    });
    if (result.canceled) return;
    const newImages: MessageImage[] = [];
    for (const asset of result.assets) {
      let b64 = asset.base64 || '';
      if (!b64 && asset.uri) {
        b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      }
      if (b64) {
        // If image is very large (>800KB base64 ≈ 600KB raw), re-pick with resize
        if (b64.length > 800_000) {
          try {
            const resized = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.4,
              base64: true,
              allowsMultipleSelection: false,
              exif: false,
            });
            if (!resized.canceled && resized.assets[0]?.base64) {
              b64 = resized.assets[0].base64;
            }
          } catch {}
        }
        newImages.push({ uri: asset.uri, base64: b64, mime: asset.mimeType || 'image/jpeg' });
      }
    }
    setPendingImages(prev => [...prev, ...newImages]);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.4,
      base64: true,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    let b64 = asset.base64 || '';
    if (!b64 && asset.uri) {
      b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
    }
    if (b64) {
      setPendingImages(prev => [...prev, { uri: asset.uri, base64: b64, mime: asset.mimeType || 'image/jpeg' }]);
    }
  }

  function removeImage(index: number) {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (result.canceled) return;
    const MAX_BYTES = 150_000; // ~150 KB text limit
    for (const asset of result.assets) {
      try {
        const content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
        const trimmed = content.length > MAX_BYTES ? content.slice(0, MAX_BYTES) + '\n… [truncated]' : content;
        setPendingFiles(prev => [...prev, { name: asset.name, content: trimmed }]);
      } catch {
        // Binary file — attach name only so the model knows a file was provided
        setPendingFiles(prev => [...prev, { name: asset.name, content: '[binary file — content not available as text]' }]);
      }
    }
  }

  function removeFile(index: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  }

  // ── Send message ───────────────────────────────────────────────────────

  function handleSend() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0 && pendingFiles.length === 0) || streaming) return;
    setInput('');
    const images = [...pendingImages];
    const files  = [...pendingFiles];
    setPendingImages([]);
    setPendingFiles([]);

    // Append file contents as quoted blocks appended to the user text
    const fileBlocks = files.map(f => {
      const ext = f.name.split('.').pop() || '';
      return `\`\`\`${ext}\n// File: ${f.name}\n${f.content}\n\`\`\``;
    }).join('\n\n');
    const fullText = fileBlocks ? (text ? `${text}\n\n${fileBlocks}` : fileBlocks) : text;

    const userMsg: Message = { id: nextId(), role: 'user', content: fullText, images: images.length > 0 ? images : undefined };
    const assistantMsg: Message = { id: nextId(), role: 'assistant', content: '' };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    scrollToEnd();

    // Build history — strip images from older messages to avoid payload bloat
    const history: Array<{ role: string; content: string | any[] }> = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        // Strip old image payloads — server also does this but we avoid the 413 locally
        if (m.images && m.images.length > 0) {
          const textContent = m.content || '';
          return { role: m.role, content: textContent + (textContent ? '\n' : '') + '[image attached earlier]' };
        }
        return { role: m.role, content: m.content };
      });

    // Build current message content — only the NEW message gets full base64
    if (images.length > 0) {
      const parts: any[] = [];
      if (fullText) parts.push({ type: 'text', text: fullText });
      images.forEach(img => parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}`, detail: 'low' }
      }));
      history.push({ role: 'user', content: parts });
    } else {
      history.push({ role: 'user', content: fullText });
    }

    const controller = api.streamChat(
      history,
      { model: model || undefined, agentName: agent || undefined, systemPrompt: systemPromptCtxRef.current || undefined },
      (evt) => {
        switch (evt.type) {
          case 'content':
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              const last = updated[lastIdx];
              if (last?.role === 'assistant') {
                // Create new object so FlatList detects the change
                updated[lastIdx] = { ...last, content: last.content + (evt.content || '') };
              } else {
                updated.push({ id: nextId(), role: 'assistant', content: evt.content || '' });
              }
              return updated;
            });
            scrollToEnd();
            break;

          case 'tool_call':
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'tool', content: `[tool] ${evt.name}(${(evt.arguments || '').slice(0, 80)})`, toolName: evt.name },
            ]);
            scrollToEnd();
            break;

          case 'tool_output':
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'tool', content: `> ${(evt.output || '').slice(0, 200)}` },
              { id: nextId(), role: 'assistant', content: '' },
            ]);
            scrollToEnd();
            break;

          case 'error':
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'tool', content: `Error: ${evt.error}` },
            ]);
            setStreaming(false);
            break;

          case 'done':
            setStreaming(false);
            setTimeout(async () => {
              const msgs = messagesRef.current;
              saveCurrentConv(msgs);
              // Auto-title after the first exchange if not already titled
              if (!autoTitledRef.current && msgs.length >= 2) {
                autoTitledRef.current = true;
                const titleMsgs = msgs
                  .filter(m => m.role === 'user' || m.role === 'assistant')
                  .slice(0, 4)
                  .map(m => ({ role: m.role, content: m.content.slice(0, 300) }));
                const title = await api.getConversationTitle(titleMsgs);
                if (title) {
                  setConvTitle(title);
                  saveCurrentConv(msgs, title);
                }
              }
            }, 300);
            break;
        }
      },
    );
    abortRef.current = controller;
  }

  function handleStop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  // ── Render message (using MessageBubble) ────────────────────────────────

  const renderMessage = useCallback(({ item, index }: { item: Message; index: number }) => {
    const isLastAssistant = item.role === 'assistant' && index === messages.length - 1;
    return (
      <MessageBubble
        role={item.role}
        content={item.content}
        images={item.images?.map(img => ({ uri: img.uri, mime: img.mime }))}
        agentName={agent || undefined}
        streaming={isLastAssistant && streaming}
        onViewArtifact={setActiveArtifact}
      />
    );
  }, [messages, streaming]);

  return (
    <KeyboardAvoidingView
      style={[s.container, { backgroundColor: t.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderMessage}
        contentContainerStyle={s.list}
        onContentSizeChange={scrollToEnd}
      />

      {/* Pending file chips */}
      {pendingFiles.length > 0 && (
        <View style={[s.fileChipBar, { backgroundColor: t.surface }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: spacing.sm }}>
            {pendingFiles.map((f, i) => (
              <View key={i} style={[s.fileChip, { backgroundColor: t.surface2 }]}>
                <Text style={[s.fileChipName, { color: t.text }]} numberOfLines={1}>{f.name}</Text>
                <TouchableOpacity onPress={() => removeFile(i)} style={s.fileChipRemove}>
                  <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: '700' }}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Pending image preview strip */}
      {pendingImages.length > 0 && (
        <View style={[s.imagePreviewBar, { backgroundColor: t.surface }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: spacing.sm }}>
            {pendingImages.map((img, i) => (
              <View key={i} style={s.imagePreviewWrap}>
                <Image source={{ uri: img.uri }} style={s.imagePreview} />
                <TouchableOpacity style={s.imageRemoveBtn} onPress={() => removeImage(i)}>
                  <Text style={s.imageRemoveText}>x</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Agent chip bar + model chip + image buttons */}
      <View style={[s.chipBar, { backgroundColor: t.surface, borderTopColor: t.border }]}>
        <TouchableOpacity style={[s.agentChip, { backgroundColor: agent ? t.teal : t.surface2 }]} onPress={() => setShowAgentPicker(true)}>
          <Text style={[s.agentChipText, { color: agent ? '#fff' : t.textMuted }]}>
            {agent ? `@ ${agent}` : '@ Agent'}
          </Text>
        </TouchableOpacity>
        {agent ? (
          <TouchableOpacity onPress={() => setAgent('')}>
            <Text style={{ color: t.textMuted, fontSize: 14, marginLeft: 6, fontWeight: '600' }}>x</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[s.agentChip, { backgroundColor: model ? t.surface3 : t.surface2, marginLeft: 4 }]} onPress={() => setShowModelPicker(true)}>
          <Text style={[s.agentChipText, { color: t.textMuted }]} numberOfLines={1}>
            {model ? model.split('/').pop()?.replace(/-\d{4}-\d{2}-\d{2}$/, '') : 'Model'}
          </Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={[s.iconBtn, { backgroundColor: t.surface2 }]} onPress={pickFile}>
          <Text style={{ fontSize: 15, color: t.textMuted }}>📎</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.iconBtn, { backgroundColor: t.surface2 }]} onPress={pickImage}>
          <Text style={{ fontSize: 13, color: t.textMuted, fontWeight: '600' }}>IMG</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.iconBtn, { backgroundColor: t.surface2 }]} onPress={takePhoto}>
          <Text style={{ fontSize: 13, color: t.textMuted, fontWeight: '600' }}>CAM</Text>
        </TouchableOpacity>
      </View>

      <View style={[s.inputBar, { backgroundColor: t.surface, borderTopColor: t.border }]}>
        <TextInput
          style={[s.textInput, { color: t.text, backgroundColor: t.surface2 }]}
          placeholder="Ask Fauna…"
          placeholderTextColor={t.textMuted}
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={8000}
          editable={!streaming}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        {streaming ? (
          <TouchableOpacity style={[s.sendBtn, { backgroundColor: t.error }]} onPress={handleStop}>
            <Text style={s.sendBtnText}>■</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[s.sendBtn, { backgroundColor: (input.trim() || pendingImages.length || pendingFiles.length) ? t.teal : t.surface3 }]}
            onPress={handleSend}
            disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
          >
            <Text style={s.sendBtnText}>↑</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Agent picker modal */}
      <Modal visible={showAgentPicker} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={[s.modalContent, { backgroundColor: t.surface }]}>
            <Text style={[s.modalTitle, { color: t.text }]}>Select Agent</Text>
            <ScrollView style={{ maxHeight: 400 }}>
              <TouchableOpacity
                style={[s.agentItem, agent === '' && { backgroundColor: t.surface2 }]}
                onPress={() => { setAgent(''); setShowAgentPicker(false); }}
              >
                <Text style={[s.agentName, { color: t.text }]}>None (default)</Text>
              </TouchableOpacity>
              {agents.map((a) => (
                <TouchableOpacity
                  key={a.name}
                  style={[s.agentItem, agent === a.name && { backgroundColor: t.surface2 }]}
                  onPress={() => { setAgent(a.name); setShowAgentPicker(false); }}
                >
                  <Text style={[s.agentName, { color: t.text }]}>{a.displayName || a.name}</Text>
                  {a.description ? <Text style={[s.agentDesc, { color: t.textMuted }]} numberOfLines={1}>{a.description}</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[s.modalClose, { borderColor: t.border }]} onPress={() => setShowAgentPicker(false)}>
              <Text style={{ color: t.textMuted, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Model picker modal */}
      <Modal visible={showModelPicker} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={[s.modalContent, { backgroundColor: t.surface }]}>
            <Text style={[s.modalTitle, { color: t.text }]}>Select Model</Text>
            <ScrollView style={{ maxHeight: 400 }}>
              <TouchableOpacity
                style={[s.agentItem, model === '' && { backgroundColor: t.surface2 }]}
                onPress={() => { setModel(''); setShowModelPicker(false); }}
              >
                <Text style={[s.agentName, { color: t.text }]}>Default</Text>
              </TouchableOpacity>
              {models.map((m: any) => {
                const id = typeof m === 'string' ? m : (m.id || m.name || String(m));
                const label = typeof m === 'string' ? m : (m.displayName || m.name || m.id || String(m));
                return (
                  <TouchableOpacity
                    key={id}
                    style={[s.agentItem, model === id && { backgroundColor: t.surface2 }]}
                    onPress={() => { setModel(id); setShowModelPicker(false); }}
                  >
                    <Text style={[s.agentName, { color: t.text }]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={[s.modalClose, { borderColor: t.border }]} onPress={() => setShowModelPicker(false)}>
              <Text style={{ color: t.textMuted, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Artifact panel modal */}
      <Modal visible={!!activeArtifact} transparent animationType="slide">
        <View style={s.artifactOverlay}>
          {activeArtifact && (
            <ArtifactPanel artifact={activeArtifact} onClose={() => setActiveArtifact(null)} />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  chipBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: 4, gap: 6 },
  agentChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  agentChipText: { fontSize: 13, fontWeight: '500' },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: spacing.sm, borderTopWidth: 1 },
  textInput: { flex: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 15, maxHeight: 120, marginRight: spacing.sm },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  // File chip strip
  fileChipBar: { paddingVertical: 6 },
  fileChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16, maxWidth: 200 },
  fileChipName: { fontSize: 12, fontWeight: '500', flex: 1 },
  fileChipRemove: { marginLeft: 6, padding: 2 },
  // Image preview strip
  imagePreviewBar: { paddingVertical: 6 },
  imagePreviewWrap: { position: 'relative' },
  imagePreview: { width: 64, height: 64, borderRadius: 8 },
  imageRemoveBtn: { position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center' },
  imageRemoveText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: spacing.lg, paddingBottom: 40 },
  modalTitle: { fontSize: 17, fontWeight: '700', marginBottom: spacing.md },
  agentItem: { padding: spacing.md, borderRadius: radius.md, marginBottom: 4 },
  agentName: { fontSize: 15, fontWeight: '600' },
  agentDesc: { fontSize: 12, marginTop: 2 },
  modalClose: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md, alignItems: 'center' },
  artifactOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', paddingTop: 80 },
});

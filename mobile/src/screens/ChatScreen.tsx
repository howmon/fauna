// Chat screen — streaming AI conversation with rich text, images, artifacts, copy & share

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, useColorScheme, Image, Modal, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';
import MessageBubble, { type ParsedArtifact } from '../components/MessageBubble';
import ArtifactPanel from '../components/ArtifactPanel';

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
  const [pendingImages, setPendingImages] = useState<MessageImage[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<ParsedArtifact | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const msgIdRef = useRef(0);
  const convIdRef = useRef<string>('conv-' + Date.now());
  const messagesRef = useRef<Message[]>([]);

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
      };
    }
    return () => { if (newChatRef) newChatRef.current = null; };
  }, [streaming, saveCurrentConv]);

  // Load agents list
  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
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

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
      allowsMultipleSelection: true,
    });
    if (result.canceled) return;
    const newImages: MessageImage[] = [];
    for (const asset of result.assets) {
      let b64 = asset.base64 || '';
      if (!b64 && asset.uri) {
        b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      }
      if (b64) {
        newImages.push({ uri: asset.uri, base64: b64, mime: asset.mimeType || 'image/jpeg' });
      }
    }
    setPendingImages(prev => [...prev, ...newImages]);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      base64: true,
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

  // ── Send message ───────────────────────────────────────────────────────

  function handleSend() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || streaming) return;
    setInput('');
    const images = [...pendingImages];
    setPendingImages([]);

    const userMsg: Message = { id: nextId(), role: 'user', content: text, images: images.length > 0 ? images : undefined };
    const assistantMsg: Message = { id: nextId(), role: 'assistant', content: '' };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    scrollToEnd();

    // Build history — for messages with images, use multipart vision format
    const history: Array<{ role: string; content: string | any[] }> = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        if (m.images && m.images.length > 0) {
          const parts: any[] = [];
          if (m.content) parts.push({ type: 'text', text: m.content });
          m.images.forEach(img => parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mime};base64,${img.base64}`, detail: 'high' }
          }));
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      });

    // Build current message content
    if (images.length > 0) {
      const parts: any[] = [];
      if (text) parts.push({ type: 'text', text });
      images.forEach(img => parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}`, detail: 'high' }
      }));
      history.push({ role: 'user', content: parts });
    } else {
      history.push({ role: 'user', content: text });
    }

    const controller = api.streamChat(
      history,
      { model: model || undefined, agentName: agent || undefined },
      (evt) => {
        switch (evt.type) {
          case 'content':
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === 'assistant') {
                last.content += evt.content || '';
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
              { id: nextId(), role: 'tool', content: `⚙ ${evt.name}(${(evt.arguments || '').slice(0, 80)})`, toolName: evt.name },
            ]);
            scrollToEnd();
            break;

          case 'tool_output':
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'tool', content: `→ ${(evt.output || '').slice(0, 200)}` },
              { id: nextId(), role: 'assistant', content: '' },
            ]);
            scrollToEnd();
            break;

          case 'error':
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'tool', content: `✗ Error: ${evt.error}` },
            ]);
            setStreaming(false);
            break;

          case 'done':
            setStreaming(false);
            setTimeout(() => saveCurrentConv(messagesRef.current), 300);
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
        streaming={isLastAssistant && streaming}
        onViewArtifact={setActiveArtifact}
      />
    );
  }, [messages.length, streaming]);

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

      {/* Pending image preview strip */}
      {pendingImages.length > 0 && (
        <View style={[s.imagePreviewBar, { backgroundColor: t.surface }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: spacing.sm }}>
            {pendingImages.map((img, i) => (
              <View key={i} style={s.imagePreviewWrap}>
                <Image source={{ uri: img.uri }} style={s.imagePreview} />
                <TouchableOpacity style={s.imageRemoveBtn} onPress={() => removeImage(i)}>
                  <Text style={s.imageRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Agent chip bar + image buttons */}
      <View style={[s.chipBar, { backgroundColor: t.surface, borderTopColor: t.border }]}>
        <TouchableOpacity style={[s.agentChip, { backgroundColor: agent ? t.teal : t.surface2 }]} onPress={() => setShowAgentPicker(true)}>
          <Text style={[s.agentChipText, { color: agent ? '#fff' : t.textMuted }]}>
            {agent ? `@ ${agent}` : '@ Agent'}
          </Text>
        </TouchableOpacity>
        {agent ? (
          <TouchableOpacity onPress={() => setAgent('')}>
            <Text style={{ color: t.textMuted, fontSize: 16, marginLeft: 6 }}>✕</Text>
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={[s.iconBtn, { backgroundColor: t.surface2 }]} onPress={pickImage}>
          <Text style={{ fontSize: 16 }}>🖼</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.iconBtn, { backgroundColor: t.surface2 }]} onPress={takePhoto}>
          <Text style={{ fontSize: 16 }}>📷</Text>
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
            style={[s.sendBtn, { backgroundColor: (input.trim() || pendingImages.length) ? t.teal : t.surface3 }]}
            onPress={handleSend}
            disabled={!input.trim() && pendingImages.length === 0}
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

// Chat screen — streaming AI conversation

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, useColorScheme, ActivityIndicator, Modal, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

// Strip fenced action blocks that are meant for the desktop UI, not for display
const ACTION_BLOCK_RE = /```(?:browser-ext-action|shell-exec|write-file|task-create|patch-agent|figma-exec|update-prompt)[^]*?```/g;

function cleanContent(text: string): string {
  return text.replace(ACTION_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
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
  const abortRef = useRef<AbortController | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const msgIdRef = useRef(0);

  const nextId = () => `msg-${++msgIdRef.current}`;

  // Register new chat handler for header button
  useEffect(() => {
    if (newChatRef) {
      newChatRef.current = () => {
        if (streaming) return;
        setMessages([]);
        setInput('');
        setConvTitle('');
        setAgent('');
        msgIdRef.current = 0;
      };
    }
    return () => { if (newChatRef) newChatRef.current = null; };
  }, [streaming]);

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
          .map((m: any) => ({ id: nextId(), role: m.role, content: m.content }));
        setMessages(msgs);
        setConvTitle(conv.title || '');
        if (conv.model) setModel(conv.model);
      }
    }, [])
  );

  const scrollToEnd = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');

    const userMsg: Message = { id: nextId(), role: 'user', content: text };
    const assistantMsg: Message = { id: nextId(), role: 'assistant', content: '' };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    scrollToEnd();

    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: text });

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
              // Add a new assistant message for content that follows
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

  function renderMessage({ item }: { item: Message }) {
    const isUser = item.role === 'user';
    const isTool = item.role === 'tool';

    if (isTool) {
      return (
        <View style={[s.toolBubble, { backgroundColor: t.surface2 }]}>
          <Text style={[s.toolText, { color: t.textDim }]}>{item.content}</Text>
        </View>
      );
    }

    const cleaned = isUser ? item.content : cleanContent(item.content);
    // Skip empty assistant messages (or messages that were only action blocks)
    if (!isUser && !cleaned) return null;

    return (
      <View style={[s.bubble, { backgroundColor: isUser ? t.userBg : t.aiBg, alignSelf: isUser ? 'flex-end' : 'flex-start' }]}>
        {!isUser && <Text style={[s.roleLabel, { color: t.teal }]}>Fauna</Text>}
        <Text style={[s.msgText, { color: t.text }]} selectable>{cleaned}</Text>
      </View>
    );
  }

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

      {/* Agent chip bar */}
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
            style={[s.sendBtn, { backgroundColor: input.trim() ? t.teal : t.surface3 }]}
            onPress={handleSend}
            disabled={!input.trim()}
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
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  bubble: { maxWidth: '85%', padding: spacing.md, borderRadius: radius.lg, marginBottom: spacing.sm },
  toolBubble: { alignSelf: 'flex-start', padding: spacing.sm, borderRadius: radius.sm, marginBottom: spacing.xs, marginLeft: spacing.sm },
  toolText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  roleLabel: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  msgText: { fontSize: 15, lineHeight: 22 },
  chipBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: 4 },
  agentChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  agentChipText: { fontSize: 13, fontWeight: '500' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: spacing.sm, borderTopWidth: 1 },
  textInput: { flex: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 15, maxHeight: 120, marginRight: spacing.sm },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: spacing.lg, paddingBottom: 40 },
  modalTitle: { fontSize: 17, fontWeight: '700', marginBottom: spacing.md },
  agentItem: { padding: spacing.md, borderRadius: radius.md, marginBottom: 4 },
  agentName: { fontSize: 15, fontWeight: '600' },
  agentDesc: { fontSize: 12, marginTop: 2 },
  modalClose: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md, alignItems: 'center' },
});

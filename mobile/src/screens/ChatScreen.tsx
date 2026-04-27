// Chat screen — streaming AI conversation

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, useColorScheme, ActivityIndicator,
} from 'react-native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

export default function ChatScreen() {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const msgIdRef = useRef(0);

  const nextId = () => `msg-${++msgIdRef.current}`;

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

    // Skip empty assistant messages
    if (!isUser && !item.content) return null;

    return (
      <View style={[s.bubble, { backgroundColor: isUser ? t.userBg : t.aiBg, alignSelf: isUser ? 'flex-end' : 'flex-start' }]}>
        {!isUser && <Text style={[s.roleLabel, { color: t.teal }]}>Fauna</Text>}
        <Text style={[s.msgText, { color: t.text }]} selectable>{item.content}</Text>
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
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: spacing.sm, borderTopWidth: 1 },
  textInput: { flex: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 15, maxHeight: 120, marginRight: spacing.sm },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

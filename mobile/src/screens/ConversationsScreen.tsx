// Conversations screen — list saved conversations from the server

import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  useColorScheme, ActivityIndicator, Platform, TextInput,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

interface ConvSummary {
  id: string;
  title: string;
  createdAt?: number;
  model?: string;
  messageCount?: number;
}

export default function ConversationsScreen({ onLoadConversation }: { onLoadConversation: (conv: any) => void }) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const renameInputRef = useRef<TextInput>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const data = await api.getConversations();
          if (!cancelled) setConvs(data);
        } catch {}
        if (!cancelled) setLoading(false);
      })();
      return () => { cancelled = true; };
    }, [])
  );

  async function handleLoad(id: string) {
    try {
      const conv = await api.getConversation(id);
      onLoadConversation(conv);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  function handleLongPress(item: ConvSummary) {
    Alert.alert(item.title, undefined, [
      {
        text: 'Rename', onPress: () => {
          setRenamingId(item.id);
          setRenameText(item.title);
          setTimeout(() => renameInputRef.current?.focus(), 50);
        }
      },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          Alert.alert('Delete conversation?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete', style: 'destructive', onPress: async () => {
                try {
                  await api.deleteConversation(item.id);
                  setConvs(prev => prev.filter(c => c.id !== item.id));
                } catch {}
              }
            },
          ]);
        }
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function commitRename() {
    if (!renamingId) return;
    const trimmed = renameText.trim();
    if (trimmed) {
      try {
        await api.updateConversation(renamingId, { title: trimmed });
        setConvs(prev => prev.map(c => c.id === renamingId ? { ...c, title: trimmed } : c));
      } catch {}
    }
    setRenamingId(null);
  }

  function renderItem({ item }: { item: ConvSummary }) {
    const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '';
    const isRenaming = renamingId === item.id;
    return (
      <TouchableOpacity
        style={[s.item, { backgroundColor: t.surface }]}
        onPress={() => isRenaming ? null : handleLoad(item.id)}
        onLongPress={() => handleLongPress(item)}
        activeOpacity={isRenaming ? 1 : 0.7}
      >
        <View style={s.itemMain}>
          {isRenaming ? (
            <TextInput
              ref={renameInputRef}
              style={[s.renameInput, { color: t.text, borderColor: t.border ?? t.textDim }]}
              value={renameText}
              onChangeText={setRenameText}
              onBlur={commitRename}
              onSubmitEditing={commitRename}
              returnKeyType="done"
              autoFocus
            />
          ) : (
            <Text style={[s.title, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
          )}
          <Text style={[s.meta, { color: t.textMuted }]}>
            {item.messageCount || 0} messages · {date}
          </Text>
        </View>
        {item.model ? (
          <Text style={[s.model, { color: t.textDim }]} numberOfLines={1}>{item.model}</Text>
        ) : null}
      </TouchableOpacity>
    );
  }

  const filtered = query.trim()
    ? convs.filter(c => c.title.toLowerCase().includes(query.toLowerCase()))
    : convs;

  if (loading) {
    return (
      <View style={[s.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.teal} />
      </View>
    );
  }

  if (!convs.length) {
    return (
      <View style={[s.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.textMuted, fontSize: 15 }}>No conversations yet</Text>
        <Text style={{ color: t.textDim, fontSize: 13, marginTop: 4 }}>Chat in the desktop app to see them here</Text>
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      <View style={[s.searchRow, { backgroundColor: t.surface, borderBottomColor: t.border ?? t.textDim }]}>
        <TextInput
          style={[s.searchInput, { color: t.text }]}
          placeholder="Search conversations…"
          placeholderTextColor={t.textMuted}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>
      {filtered.length === 0 ? (
        <View style={s.center}>
          <Text style={{ color: t.textMuted, fontSize: 15 }}>
            {query ? 'No matching conversations' : 'No conversations yet'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={c => c.id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.md },
  searchRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    fontSize: 15,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
    paddingHorizontal: 10,
  },
  item: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  itemMain: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  meta: { fontSize: 12 },
  model: { fontSize: 11, marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  renameInput: {
    fontSize: 15, fontWeight: '600',
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: Platform.OS === 'ios' ? 4 : 2,
    marginBottom: 2,
  },
});

// Conversations screen — list saved conversations from the server

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  useColorScheme, ActivityIndicator, Platform,
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

  function handleDelete(id: string) {
    Alert.alert('Delete conversation?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await api.deleteConversation(id);
            setConvs(prev => prev.filter(c => c.id !== id));
          } catch {}
        }
      },
    ]);
  }

  function renderItem({ item }: { item: ConvSummary }) {
    const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '';
    return (
      <TouchableOpacity
        style={[s.item, { backgroundColor: t.surface }]}
        onPress={() => handleLoad(item.id)}
        onLongPress={() => handleDelete(item.id)}
      >
        <View style={s.itemMain}>
          <Text style={[s.title, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
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
      <FlatList
        data={convs}
        keyExtractor={c => c.id}
        renderItem={renderItem}
        contentContainerStyle={s.list}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.md },
  item: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  itemMain: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  meta: { fontSize: 12 },
  model: { fontSize: 11, marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});

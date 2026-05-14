// Project detail screen — shows conversations inside a project

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  useColorScheme, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

const COLOR_MAP: Record<string, string> = {
  teal:    '#14B8A6',
  teal2:   '#0D9488',
  purple:  '#8B5CF6',
  green:   '#22C55E',
  orange:  '#F97316',
  red:     '#EF4444',
  violet:  '#7C3AED',
  pink:    '#EC4899',
};

function projectColor(color: string): string {
  return COLOR_MAP[color] ?? COLOR_MAP.teal;
}

interface ConvSummary {
  id: string;
  title: string;
  createdAt?: number;
  messageCount?: number;
  model?: string;
}

interface Props {
  project: api.Project;
  onLoadConversation: (conv: any) => void;
  onNewChatInProject: (project: api.Project) => void;
}

export default function ProjectDetailScreen({ project, onLoadConversation, onNewChatInProject }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const accentColor = projectColor(project.color);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);

      // Fetch the fresh project to get current conversationIds, then load each conv summary
      api.getProjectById(project.id).then(async (p) => {
        const ids = p.conversationIds || [];
        if (ids.length === 0) {
          if (!cancelled) { setConvs([]); setLoading(false); }
          return;
        }
        // Load all conversations then filter to just this project's ids
        try {
          const all = await api.getConversations();
          const idSet = new Set(ids);
          const filtered = all
            .filter((c: any) => idSet.has(c.id))
            // Sort by most recent first (using project's conversationIds order, which is newest-first)
            .sort((a: any, b: any) => ids.indexOf(a.id) - ids.indexOf(b.id));
          if (!cancelled) { setConvs(filtered); setLoading(false); }
        } catch {
          if (!cancelled) setLoading(false);
        }
      }).catch(() => {
        if (!cancelled) setLoading(false);
      });

      return () => { cancelled = true; };
    }, [project.id])
  );

  async function handleLoadConv(id: string) {
    try {
      const conv = await api.getConversation(id);
      onLoadConversation(conv);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  function handleLongPressConv(item: ConvSummary) {
    Alert.alert(item.title, undefined, [
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

  function renderConv({ item }: { item: ConvSummary }) {
    const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '';
    return (
      <TouchableOpacity
        style={[s.convItem, { backgroundColor: t.surface, borderColor: t.border }]}
        onPress={() => handleLoadConv(item.id)}
        onLongPress={() => handleLongPressConv(item)}
        activeOpacity={0.75}
      >
        <Text style={[s.convTitle, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
        <Text style={[s.convMeta, { color: t.textMuted }]}>
          {item.messageCount || 0} messages{date ? ` · ${date}` : ''}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      {/* Project header card */}
      <View style={[s.headerCard, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={[s.colorAccent, { backgroundColor: accentColor }]} />
        <View style={s.headerInfo}>
          <Text style={[s.projectName, { color: t.text }]}>{project.name}</Text>
          {!!project.description && (
            <Text style={[s.projectDesc, { color: t.textMuted }]}>{project.description}</Text>
          )}
        </View>
      </View>

      {/* New chat button */}
      <TouchableOpacity
        style={[s.newChatRow, { backgroundColor: accentColor }]}
        onPress={() => onNewChatInProject(project)}
        activeOpacity={0.8}
      >
        <Text style={s.newChatLabel}>＋ New Chat in Project</Text>
      </TouchableOpacity>

      {/* Conversations */}
      <Text style={[s.sectionTitle, { color: t.textMuted }]}>
        CONVERSATIONS
      </Text>

      {loading ? (
        <View style={s.centered}>
          <ActivityIndicator color={t.teal} />
        </View>
      ) : convs.length === 0 ? (
        <View style={s.centered}>
          <Text style={[s.emptyText, { color: t.textMuted }]}>
            No conversations yet.{'\n'}Start a new chat to begin.
          </Text>
        </View>
      ) : (
        <FlatList
          data={convs}
          keyExtractor={c => c.id}
          renderItem={renderConv}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  headerCard: {
    flexDirection: 'row',
    margin: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  colorAccent: { width: 5 },
  headerInfo: { flex: 1, padding: spacing.md, gap: 4 },
  projectName: { fontSize: 17, fontWeight: '700' },
  projectDesc: { fontSize: 14, lineHeight: 20 },
  newChatRow: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  newChatLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
  },
  convItem: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: 4,
  },
  convTitle: { fontSize: 15, fontWeight: '500' },
  convMeta: { fontSize: 12 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});

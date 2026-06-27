// Project detail screen — shows conversations inside a project

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  useColorScheme, ActivityIndicator, ScrollView, TextInput,
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
  const [board, setBoard] = useState<api.ProjectBoard | null>(null);
  const [instructionByItem, setInstructionByItem] = useState<Record<string, string>>({});
  const [sendingItemId, setSendingItemId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);

      // Fetch the fresh project to get current conversationIds, then load each conv summary
      api.getProjectById(project.id).then(async (p) => {
        api.getProjectBoard(project.id).then((b) => { if (!cancelled) setBoard(b); }).catch(() => { if (!cancelled) setBoard(null); });
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

  function boardColumns(): Array<{ id: string; title: string; items: api.WorkItem[] }> {
    if (!board) return [];
    if (Array.isArray(board.columns) && board.columns.length) {
      return board.columns.map((col: any) => ({
        id: col.id || col.name || col.title || 'column',
        title: col.title || col.name || col.id || 'Column',
        items: Array.isArray(col.items) ? col.items : [],
      }));
    }
    const items = Array.isArray(board.items) ? board.items : [];
    const grouped = items.reduce<Record<string, api.WorkItem[]>>((acc, item) => {
      const key = item.column || 'todo';
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
    return Object.keys(grouped).map((id) => ({ id, title: id.replace(/_/g, ' '), items: grouped[id] }));
  }

  async function sendInstruction(item: api.WorkItem) {
    const text = (instructionByItem[item.id] || '').trim();
    if (!text) return;
    setSendingItemId(item.id);
    try {
      await api.sendWorkItemInstruction(project.id, item.id, text);
      setInstructionByItem(prev => ({ ...prev, [item.id]: '' }));
      const next = await api.getProjectBoard(project.id);
      setBoard(next);
    } catch (e: any) {
      Alert.alert('Instruction failed', e.message || 'Could not send instruction');
    } finally {
      setSendingItemId(null);
    }
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
      <ScrollView contentContainerStyle={s.scrollContent}>
      <Text style={[s.sectionTitle, { color: t.textMuted }]}>BOARD</Text>

      {boardColumns().length === 0 ? (
        <View style={[s.emptyPanel, { borderColor: t.border }]}>
          <Text style={[s.emptyText, { color: t.textMuted }]}>No board items yet.</Text>
        </View>
      ) : (
        boardColumns().map((col) => (
          <View key={col.id} style={s.boardColumn}>
            <Text style={[s.columnTitle, { color: t.text }]}>{col.title.toUpperCase()} · {col.items.length}</Text>
            {col.items.slice(0, 6).map((item) => (
              <View key={item.id} style={[s.workItem, { backgroundColor: t.surface, borderColor: t.border }]}>
                <Text style={[s.workTitle, { color: t.text }]} numberOfLines={2}>{item.title}</Text>
                {!!item.body && <Text style={[s.workBody, { color: t.textDim }]} numberOfLines={2}>{item.body}</Text>}
                <View style={s.workMetaRow}>
                  {!!item.priority && <Text style={[s.workMeta, { color: t.textMuted }]}>{item.priority}</Text>}
                  {!!item.assignee && <Text style={[s.workMeta, { color: t.textMuted }]}>Assigned {item.assignee}</Text>}
                </View>
                <View style={s.instructionRow}>
                  <TextInput
                    style={[s.instructionInput, { color: t.text, borderColor: t.border, backgroundColor: t.surface2 }]}
                    placeholder="Send instruction"
                    placeholderTextColor={t.textMuted}
                    value={instructionByItem[item.id] || ''}
                    onChangeText={(value) => setInstructionByItem(prev => ({ ...prev, [item.id]: value }))}
                    returnKeyType="send"
                    onSubmitEditing={() => sendInstruction(item)}
                  />
                  <TouchableOpacity
                    style={[s.sendInstruction, { backgroundColor: accentColor, opacity: sendingItemId === item.id ? 0.5 : 1 }]}
                    onPress={() => sendInstruction(item)}
                    disabled={sendingItemId === item.id}
                  >
                    <Text style={s.sendInstructionText}>Send</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        ))
      )}

      <Text style={[s.sectionTitle, { color: t.textMuted }]}>CONVERSATIONS</Text>

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
      </ScrollView>
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
  scrollContent: { paddingBottom: spacing.xl },
  emptyPanel: { borderWidth: 1, borderRadius: radius.md, marginHorizontal: spacing.md, marginBottom: spacing.md, padding: spacing.lg, alignItems: 'center' },
  boardColumn: { marginBottom: spacing.md },
  columnTitle: { fontSize: 12, fontWeight: '700', marginHorizontal: spacing.lg, marginBottom: spacing.xs },
  workItem: { borderWidth: 1, borderRadius: radius.md, marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: spacing.md, gap: spacing.xs },
  workTitle: { fontSize: 15, fontWeight: '700' },
  workBody: { fontSize: 13, lineHeight: 18 },
  workMetaRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  workMeta: { fontSize: 11, fontWeight: '600' },
  instructionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  instructionInput: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 13 },
  sendInstruction: { borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  sendInstructionText: { color: '#fff', fontSize: 13, fontWeight: '700' },
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

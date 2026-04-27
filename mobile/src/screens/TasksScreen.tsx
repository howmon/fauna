// Tasks list screen — shows all tasks with live status updates

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  useColorScheme, Alert,
} from 'react-native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

const STATUS_ICONS: Record<string, string> = {
  idle: '○',
  pending: '◔',
  running: '⟳',
  completed: '✓',
  failed: '✗',
  paused: '||',
};

const STATUS_COLORS = (t: typeof dark) => ({
  idle: t.textMuted,
  pending: t.warn,
  running: t.teal,
  completed: t.success,
  failed: t.error,
  paused: t.textDim,
});

interface Props {
  navigation: any;
}

export default function TasksScreen({ navigation }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const colors = STATUS_COLORS(t);
  const [tasks, setTasks] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.getTasks();
      setTasks(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchTasks();
    // Subscribe to live updates
    const unsub = api.streamTasks((evt) => {
      if (evt.event === 'connected') {
        fetchTasks();
      } else {
        fetchTasks(); // Re-fetch on any task event
      }
    });
    return unsub;
  }, [fetchTasks]);

  // Refresh on focus
  useEffect(() => {
    const unsub = navigation.addListener('focus', fetchTasks);
    return unsub;
  }, [navigation, fetchTasks]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchTasks();
    setRefreshing(false);
  };

  function renderTask({ item }: { item: any }) {
    const status = item.status || 'idle';
    const icon = STATUS_ICONS[status] || '?';
    const color = (colors as any)[status] || t.textMuted;
    const pct = item.result?.stats?.pct;
    const isRunning = status === 'running' || !!item._running;

    return (
      <TouchableOpacity
        style={[s.card, { backgroundColor: t.surface, borderColor: isRunning ? t.teal : t.border }]}
        onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })}
        activeOpacity={0.7}
      >
        <View style={s.cardHeader}>
          <Text style={[s.statusIcon, { color }]}>{icon}</Text>
          <View style={s.cardMeta}>
            <Text style={[s.taskTitle, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
            <Text style={[s.taskId, { color: t.textMuted }]}>{item.id}</Text>
          </View>
        </View>
        {item.description ? (
          <Text style={[s.desc, { color: t.textDim }]} numberOfLines={2}>{item.description}</Text>
        ) : null}
        <View style={s.cardFooter}>
          <Text style={[s.statusText, { color }]}>{status.toUpperCase()}</Text>
          {pct !== undefined && <Text style={[s.pct, { color: t.teal }]}>{pct}%</Text>}
          {item.agents?.length > 0 && (
            <Text style={[s.agentTag, { color: t.textMuted }]}>Agent: {item.agents.join(', ')}</Text>
          )}
        </View>
        {isRunning && (
          <View style={[s.progressBar, { backgroundColor: t.surface2 }]}>
            <View style={[s.progressFill, { backgroundColor: t.teal, width: `${pct || 10}%` }]} />
          </View>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        renderItem={renderTask}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.teal} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={[s.emptyText, { color: t.textMuted }]}>No tasks yet</Text>
            <Text style={[s.emptyHint, { color: t.textDim }]}>
              Create tasks from the desktop app or chat
            </Text>
          </View>
        }
      />
      <TouchableOpacity
        style={[s.fab, { backgroundColor: t.teal }]}
        onPress={() => navigation.navigate('TaskCreate')}
      >
        <Text style={s.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.md, paddingBottom: 80 },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  statusIcon: { fontSize: 20, marginRight: spacing.md, width: 24, textAlign: 'center' },
  cardMeta: { flex: 1 },
  taskTitle: { fontSize: 16, fontWeight: '600' },
  taskId: { fontSize: 11, marginTop: 2 },
  desc: { fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  pct: { fontSize: 11, fontWeight: '600' },
  agentTag: { fontSize: 11 },
  progressBar: { height: 3, borderRadius: 2, marginTop: spacing.sm, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '300', marginTop: -2 },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { fontSize: 18, fontWeight: '600', marginBottom: spacing.sm },
  emptyHint: { fontSize: 14, textAlign: 'center' },
});

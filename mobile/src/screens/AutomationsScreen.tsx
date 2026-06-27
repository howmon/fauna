// Automations screen — shows scheduled workflows and lets the user run or pause them

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  useColorScheme, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

export default function AutomationsScreen() {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [workflows, setWorkflows] = useState<api.WorkflowAutomation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getWorkflows();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      Alert.alert('Automations unavailable', e.message || 'Could not load automations');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function runNow(id: string) {
    setBusyId(id);
    try {
      await api.runWorkflowNow(id);
      await load();
    } catch (e: any) {
      Alert.alert('Run failed', e.message || 'Could not run automation');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(item: api.WorkflowAutomation) {
    setBusyId(item.id);
    try {
      await api.updateWorkflow(item.id, { enabled: item.enabled === false });
      await load();
    } catch (e: any) {
      Alert.alert('Update failed', e.message || 'Could not update automation');
    } finally {
      setBusyId(null);
    }
  }

  function renderWorkflow({ item }: { item: api.WorkflowAutomation }) {
    const enabled = item.enabled !== false;
    const name = item.name || item.title || 'Untitled automation';
    const next = item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : 'Manual';
    const last = item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : 'Never';
    return (
      <View style={[s.card, { backgroundColor: t.surface, borderColor: enabled ? t.border : t.surface3 }]}>
        <View style={s.cardTop}>
          <View style={s.cardMeta}>
            <Text style={[s.title, { color: t.text }]} numberOfLines={1}>{name}</Text>
            {!!item.description && <Text style={[s.desc, { color: t.textDim }]} numberOfLines={2}>{item.description}</Text>}
          </View>
          <Text style={[s.badge, { color: enabled ? t.success : t.textMuted, borderColor: enabled ? t.success : t.border }]}>
            {enabled ? 'ON' : 'OFF'}
          </Text>
        </View>
        <View style={s.metaGrid}>
          <Meta label="Schedule" value={item.schedule || 'Manual'} t={t} />
          <Meta label="Next" value={next} t={t} />
          <Meta label="Last" value={last} t={t} />
        </View>
        <View style={s.actions}>
          <TouchableOpacity
            style={[s.actionBtn, { borderColor: t.border, opacity: busyId === item.id ? 0.5 : 1 }]}
            onPress={() => toggleEnabled(item)}
            disabled={busyId === item.id}
          >
            <Text style={[s.actionText, { color: t.text }]}>{enabled ? 'Pause' : 'Enable'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: t.teal, borderColor: t.teal, opacity: busyId === item.id ? 0.5 : 1 }]}
            onPress={() => runNow(item.id)}
            disabled={busyId === item.id}
          >
            <Text style={[s.actionText, { color: '#fff' }]}>Run now</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      <FlatList
        data={workflows}
        keyExtractor={(item) => item.id}
        renderItem={renderWorkflow}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.teal} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={[s.emptyTitle, { color: t.text }]}>No automations</Text>
            <Text style={[s.emptyHint, { color: t.textMuted }]}>Create workflows on desktop; they will appear here.</Text>
          </View>
        }
      />
    </View>
  );
}

function Meta({ label, value, t }: { label: string; value: string; t: typeof dark }) {
  return (
    <View style={s.metaItem}>
      <Text style={[s.metaLabel, { color: t.textMuted }]}>{label}</Text>
      <Text style={[s.metaValue, { color: t.textDim }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.md, paddingBottom: 80 },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md, gap: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardMeta: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '700' },
  desc: { fontSize: 13, lineHeight: 18, marginTop: spacing.xs },
  badge: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: '700' },
  metaGrid: { gap: spacing.xs },
  metaItem: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  metaLabel: { fontSize: 12 },
  metaValue: { flex: 1, textAlign: 'right', fontSize: 12 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  actionText: { fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', paddingTop: 90, paddingHorizontal: spacing.xl },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginBottom: spacing.sm },
  emptyHint: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
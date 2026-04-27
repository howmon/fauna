// Task detail + live stream + actions (run, stop, steer)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, useColorScheme, RefreshControl,
} from 'react-native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

interface Props {
  route: any;
  navigation: any;
}

export default function TaskDetailScreen({ route, navigation }: Props) {
  const { taskId } = route.params;
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [task, setTask] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [steerMsg, setSteerMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const fetchTask = useCallback(async () => {
    try {
      const data = await api.getTask(taskId);
      setTask(data);
      navigation.setOptions({ title: data.title || taskId });
    } catch {}
  }, [taskId, navigation]);

  useEffect(() => {
    fetchTask();
    const unsub = api.streamTask(taskId, (evt) => {
      if (evt.event === 'step' || evt.event === 'content' || evt.event === 'tool_call' || evt.event === 'reasoning') {
        setEvents((prev) => [...prev.slice(-100), evt]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
      }
      if (evt.event === 'done' || evt.event === 'failed' || evt.event === 'stopped') {
        fetchTask();
      }
      if (evt.event === 'progress') {
        setTask((prev: any) => prev ? { ...prev, _running: { ...prev._running, ...evt } } : prev);
      }
    });
    return unsub;
  }, [taskId, fetchTask]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchTask();
    setRefreshing(false);
  };

  const isRunning = task?.status === 'running' || !!task?._running;

  async function handleRun() {
    try {
      await api.runTask(taskId);
      fetchTask();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  async function handleStop() {
    try {
      await api.stopTask(taskId);
      fetchTask();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  async function handleSteer() {
    if (!steerMsg.trim()) return;
    try {
      await api.steerTask(taskId, steerMsg.trim());
      setSteerMsg('');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  async function handleDelete() {
    Alert.alert('Delete Task', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTask(taskId);
            navigation.goBack();
          } catch (e: any) {
            Alert.alert('Error', e.message);
          }
        },
      },
    ]);
  }

  if (!task) {
    return (
      <View style={[s.container, { backgroundColor: t.bg }]}>
        <Text style={[s.loading, { color: t.textDim }]}>Loading…</Text>
      </View>
    );
  }

  const result = task.result;
  const reasoning = task.result?.reasoning || [];
  const lastSteps = reasoning.slice(-15);
  const statusColor = task.status === 'completed' ? t.success
    : task.status === 'failed' ? t.error
    : task.status === 'running' ? t.teal
    : t.textMuted;

  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.teal} />}
      >
        {/* Header */}
        <View style={[s.section, { backgroundColor: t.surface }]}>
          <View style={s.row}>
            <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[s.statusLabel, { color: statusColor }]}>{(task.status || 'idle').toUpperCase()}</Text>
            {result?.stats?.pct !== undefined && (
              <Text style={[s.pct, { color: t.teal }]}>{result.stats.pct}%</Text>
            )}
          </View>
          <Text style={[s.title, { color: t.text }]}>{task.title}</Text>
          {task.description ? <Text style={[s.desc, { color: t.textDim }]}>{task.description}</Text> : null}
          <Text style={[s.meta, { color: t.textMuted }]}>ID: {task.id}</Text>
          {task.model && <Text style={[s.meta, { color: t.textMuted }]}>Model: {task.model}</Text>}
          {task.agents?.length > 0 && <Text style={[s.meta, { color: t.textMuted }]}>Agents: {task.agents.join(', ')}</Text>}
        </View>

        {/* Result */}
        {result && (
          <View style={[s.section, { backgroundColor: t.surface }]}>
            <Text style={[s.sectionTitle, { color: t.text }]}>Result</Text>
            {result.ok !== undefined && (
              <Text style={[s.resultStatus, { color: result.ok ? t.success : t.error }]}>
                {result.ok ? '✓ Succeeded' : '✗ Failed'}
              </Text>
            )}
            {result.summary && <Text style={[s.resultText, { color: t.text }]}>{result.summary}</Text>}
            {result.error && <Text style={[s.resultText, { color: t.error }]}>{result.error}</Text>}
            {result.duration && <Text style={[s.meta, { color: t.textMuted }]}>Duration: {Math.round(result.duration / 1000)}s</Text>}
            {result.totalSteps && <Text style={[s.meta, { color: t.textMuted }]}>Steps: {result.totalSteps}</Text>}
          </View>
        )}

        {/* Reasoning chain */}
        {lastSteps.length > 0 && (
          <View style={[s.section, { backgroundColor: t.surface }]}>
            <Text style={[s.sectionTitle, { color: t.text }]}>Reasoning Chain</Text>
            {lastSteps.map((step: any, i: number) => (
              <View key={i} style={[s.stepRow, { borderLeftColor: step.ok !== false ? t.teal : t.error }]}>
                <Text style={[s.stepIdx, { color: t.textMuted }]}>#{reasoning.length - lastSteps.length + i + 1}</Text>
                <View style={s.stepContent}>
                  <Text style={[s.stepAction, { color: t.text }]}>{step.action || step.type || 'step'}</Text>
                  {step.summary && <Text style={[s.stepSummary, { color: t.textDim }]} numberOfLines={3}>{step.summary}</Text>}
                </View>
                <Text style={{ color: step.ok !== false ? t.success : t.error, fontSize: 14 }}>
                  {step.ok !== false ? '✓' : '✗'}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Live stream events */}
        {events.length > 0 && (
          <View style={[s.section, { backgroundColor: t.surface }]}>
            <Text style={[s.sectionTitle, { color: t.text }]}>Live Stream</Text>
            {events.slice(-20).map((evt, i) => (
              <Text key={i} style={[s.eventLine, { color: t.textDim }]} numberOfLines={2}>
                {evt.event}: {evt.content || evt.name || evt.message || JSON.stringify(evt).slice(0, 100)}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Action bar */}
      <View style={[s.actionBar, { backgroundColor: t.surface, borderTopColor: t.border }]}>
        {isRunning ? (
          <>
            <TextInput
              style={[s.steerInput, { backgroundColor: t.surface2, color: t.text }]}
              placeholder="Steer task…"
              placeholderTextColor={t.textMuted}
              value={steerMsg}
              onChangeText={setSteerMsg}
              onSubmitEditing={handleSteer}
            />
            <TouchableOpacity style={[s.actionBtn, { backgroundColor: t.teal }]} onPress={handleSteer}>
              <Text style={s.actionBtnText}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.actionBtn, { backgroundColor: t.error }]} onPress={handleStop}>
              <Text style={s.actionBtnText}>■</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity style={[s.actionBtnWide, { backgroundColor: t.teal }]} onPress={handleRun}>
              <Text style={s.actionBtnText}>▶ Run</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.actionBtnWide, { backgroundColor: t.error }]} onPress={handleDelete}>
              <Text style={s.actionBtnText}>Delete</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  loading: { textAlign: 'center', marginTop: 80, fontSize: 16 },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.md, paddingBottom: 80 },
  section: { borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.sm },
  statusLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  pct: { marginLeft: 'auto', fontSize: 14, fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '700', marginBottom: spacing.xs },
  desc: { fontSize: 14, lineHeight: 20, marginBottom: spacing.sm },
  meta: { fontSize: 12, marginTop: 2 },
  resultStatus: { fontSize: 15, fontWeight: '600', marginBottom: spacing.xs },
  resultText: { fontSize: 14, lineHeight: 20 },
  stepRow: { flexDirection: 'row', alignItems: 'center', borderLeftWidth: 3, paddingLeft: spacing.md, paddingVertical: spacing.xs, marginBottom: spacing.xs },
  stepIdx: { fontSize: 11, width: 28 },
  stepContent: { flex: 1 },
  stepAction: { fontSize: 13, fontWeight: '600' },
  stepSummary: { fontSize: 12, marginTop: 2 },
  eventLine: { fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
  actionBar: { flexDirection: 'row', alignItems: 'center', padding: spacing.sm, borderTopWidth: 1, gap: spacing.sm },
  steerInput: { flex: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 14 },
  actionBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  actionBtnWide: { flex: 1, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  actionBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

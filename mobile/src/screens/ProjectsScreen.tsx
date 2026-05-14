// Projects screen — list all projects, create new, enter project detail

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  useColorScheme, ActivityIndicator, Modal, TextInput, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

// Map server color names → hex
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
const COLOR_OPTIONS = Object.keys(COLOR_MAP);

function projectColor(color: string): string {
  return COLOR_MAP[color] ?? COLOR_MAP.teal;
}

interface Props {
  onOpenProject: (project: api.Project) => void;
  onNewChatInProject: (project: api.Project) => void;
}

export default function ProjectsScreen({ onOpenProject, onNewChatInProject }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [projects, setProjects] = useState<api.Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newColor, setNewColor] = useState('teal');
  const [creating, setCreating] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      api.getProjects().then(data => {
        if (!cancelled) {
          // Sort by lastActiveAt desc
          const sorted = [...data].sort((a, b) =>
            new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
          );
          setProjects(sorted);
          setLoading(false);
        }
      }).catch(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [])
  );

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const p = await api.createProject({ name, description: newDesc.trim(), color: newColor });
      setProjects(prev => [p, ...prev]);
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      setNewColor('teal');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setCreating(false);
    }
  }

  function handleLongPress(item: api.Project) {
    Alert.alert(item.name, undefined, [
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          Alert.alert('Delete project?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete', style: 'destructive', onPress: async () => {
                try {
                  await api.deleteProject(item.id);
                  setProjects(prev => prev.filter(p => p.id !== item.id));
                } catch (e: any) {
                  Alert.alert('Error', e.message);
                }
              }
            },
          ]);
        }
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function renderItem({ item }: { item: api.Project }) {
    const accentColor = projectColor(item.color);
    const convCount = item.conversationIds?.length ?? 0;
    return (
      <TouchableOpacity
        style={[s.card, { backgroundColor: t.surface, borderColor: t.border }]}
        onPress={() => onOpenProject(item)}
        onLongPress={() => handleLongPress(item)}
        activeOpacity={0.75}
      >
        <View style={[s.colorBar, { backgroundColor: accentColor }]} />
        <View style={s.cardContent}>
          <View style={s.cardRow}>
            <Text style={[s.cardName, { color: t.text }]} numberOfLines={1}>{item.name}</Text>
            <TouchableOpacity
              style={[s.newChatBtn, { borderColor: accentColor }]}
              onPress={() => onNewChatInProject(item)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[s.newChatBtnLabel, { color: accentColor }]}>＋ Chat</Text>
            </TouchableOpacity>
          </View>
          {!!item.description && (
            <Text style={[s.cardDesc, { color: t.textMuted }]} numberOfLines={2}>{item.description}</Text>
          )}
          <Text style={[s.cardMeta, { color: t.textMuted }]}>
            {convCount} conversation{convCount !== 1 ? 's' : ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  const styles_t = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
      backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
    },
    headerTitle: { fontSize: 17, fontWeight: '600', color: t.text },
    addBtn: { padding: 4 },
    addBtnLabel: { fontSize: 22, color: t.teal },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
    emptyText: { color: t.textMuted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  });

  return (
    <View style={styles_t.container}>
      <View style={styles_t.header}>
        <Text style={styles_t.headerTitle}>Projects</Text>
        <TouchableOpacity style={styles_t.addBtn} onPress={() => setShowCreate(true)}>
          <Text style={styles_t.addBtnLabel}>＋</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={t.teal} />
        </View>
      ) : projects.length === 0 ? (
        <View style={styles_t.empty}>
          <Text style={styles_t.emptyText}>No projects yet.{'\n'}Tap ＋ to create one.</Text>
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={p => p.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        />
      )}

      {/* Create project modal */}
      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <View style={[sm.overlay]}>
          <View style={[sm.sheet, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Text style={[sm.title, { color: t.text }]}>New Project</Text>

            <Text style={[sm.label, { color: t.textDim }]}>Name</Text>
            <TextInput
              style={[sm.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface2 }]}
              placeholder="Project name"
              placeholderTextColor={t.textMuted}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              returnKeyType="next"
            />

            <Text style={[sm.label, { color: t.textDim }]}>Description (optional)</Text>
            <TextInput
              style={[sm.input, sm.multiline, { color: t.text, borderColor: t.border, backgroundColor: t.surface2 }]}
              placeholder="Short description"
              placeholderTextColor={t.textMuted}
              value={newDesc}
              onChangeText={setNewDesc}
              multiline
              numberOfLines={2}
            />

            <Text style={[sm.label, { color: t.textDim }]}>Color</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
              {COLOR_OPTIONS.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setNewColor(c)}
                  style={[sm.colorDot, { backgroundColor: projectColor(c), borderWidth: newColor === c ? 3 : 0, borderColor: t.text }]}
                />
              ))}
            </ScrollView>

            <View style={sm.actions}>
              <TouchableOpacity style={[sm.btn, sm.cancelBtn, { borderColor: t.border }]} onPress={() => setShowCreate(false)}>
                <Text style={[sm.btnLabel, { color: t.textDim }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[sm.btn, sm.createBtn, { backgroundColor: t.teal, opacity: creating || !newName.trim() ? 0.5 : 1 }]}
                onPress={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={[sm.btnLabel, { color: '#fff' }]}>Create</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  colorBar: {
    width: 4,
  },
  cardContent: {
    flex: 1,
    padding: spacing.md,
    gap: 4,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    marginRight: spacing.sm,
  },
  cardDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
  cardMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  newChatBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  newChatBtnLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
});

const sm = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    marginBottom: spacing.md,
  },
  multiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  colorDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    borderWidth: 1,
  },
  createBtn: {},
  btnLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});

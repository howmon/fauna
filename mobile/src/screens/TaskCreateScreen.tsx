// Create task screen

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  Switch, Alert, useColorScheme,
} from 'react-native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';

interface Props {
  navigation: any;
}

export default function TaskCreateScreen({ navigation }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [shellPerm, setShellPerm] = useState(false);
  const [browserPerm, setBrowserPerm] = useState(false);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim()) {
      Alert.alert('Title required', 'Give your task a name.');
      return;
    }
    setCreating(true);
    try {
      const task = await api.createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        context: context.trim() || undefined,
        permissions: { shell: shellPerm, browser: browserPerm, figma: false },
        schedule: { type: 'manual' },
      });
      navigation.navigate('TaskDetail', { taskId: task.id });
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <ScrollView style={[s.container, { backgroundColor: t.bg }]} contentContainerStyle={s.content}>
      <Text style={[s.label, { color: t.text }]}>Title</Text>
      <TextInput
        style={[s.input, { backgroundColor: t.surface, color: t.text, borderColor: t.border }]}
        placeholder="What should Fauna do?"
        placeholderTextColor={t.textMuted}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={[s.label, { color: t.text }]}>Description</Text>
      <TextInput
        style={[s.input, s.multiline, { backgroundColor: t.surface, color: t.text, borderColor: t.border }]}
        placeholder="Detailed instructions…"
        placeholderTextColor={t.textMuted}
        value={description}
        onChangeText={setDescription}
        multiline
        numberOfLines={4}
      />

      <Text style={[s.label, { color: t.text }]}>Context</Text>
      <TextInput
        style={[s.input, s.multiline, { backgroundColor: t.surface, color: t.text, borderColor: t.border }]}
        placeholder="Background info, credentials, etc."
        placeholderTextColor={t.textMuted}
        value={context}
        onChangeText={setContext}
        multiline
        numberOfLines={3}
      />

      <Text style={[s.sectionTitle, { color: t.text }]}>Permissions</Text>
      <View style={[s.permRow, { backgroundColor: t.surface }]}>
        <Text style={[s.permLabel, { color: t.text }]}>Shell access</Text>
        <Switch
          value={shellPerm}
          onValueChange={setShellPerm}
          trackColor={{ false: t.surface3, true: t.teal }}
          thumbColor="#fff"
        />
      </View>
      <View style={[s.permRow, { backgroundColor: t.surface }]}>
        <Text style={[s.permLabel, { color: t.text }]}>Browser access</Text>
        <Switch
          value={browserPerm}
          onValueChange={setBrowserPerm}
          trackColor={{ false: t.surface3, true: t.teal }}
          thumbColor="#fff"
        />
      </View>

      <TouchableOpacity
        style={[s.createBtn, { backgroundColor: t.teal, opacity: creating ? 0.5 : 1 }]}
        onPress={handleCreate}
        disabled={creating}
      >
        <Text style={s.createBtnText}>{creating ? 'Creating…' : 'Create Task'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 40 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: spacing.xs, marginTop: spacing.lg },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginTop: spacing.xl, marginBottom: spacing.md, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 15 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  permRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  permLabel: { fontSize: 15 },
  createBtn: { marginTop: spacing.xl, padding: 16, borderRadius: radius.md, alignItems: 'center' },
  createBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

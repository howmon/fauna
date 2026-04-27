// Settings / connection screen

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, useColorScheme,
} from 'react-native';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';
import { clearConnection, loadConnection, ConnectionInfo } from '../lib/storage';

interface Props {
  onDisconnect: () => void;
}

export default function SettingsScreen({ onDisconnect }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  const [system, setSystem] = useState<any>(null);

  useEffect(() => {
    loadConnection().then(setConn);
    api.getSystemContext().then(setSystem).catch(() => {});
  }, []);

  function handleDisconnect() {
    Alert.alert('Disconnect', 'Remove this server connection?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          await clearConnection();
          onDisconnect();
        },
      },
    ]);
  }

  return (
    <ScrollView style={[s.container, { backgroundColor: t.bg }]} contentContainerStyle={s.content}>
      {/* Connection info */}
      <View style={[s.card, { backgroundColor: t.surface }]}>
        <Text style={[s.sectionTitle, { color: t.text }]}>Connection</Text>
        {conn && (
          <>
            <Row label="Server" value={conn.serverName || conn.host} t={t} />
            <Row label="Host" value={`${conn.host}:${conn.port}`} t={t} />
            <Row label="Auth" value={system?.permissions?.auth === 'granted' ? '✓ Granted' : '✗ Denied'} t={t} valueColor={system?.permissions?.auth === 'granted' ? t.success : t.error} />
          </>
        )}
      </View>

      {/* System info */}
      {system && (
        <View style={[s.card, { backgroundColor: t.surface }]}>
          <Text style={[s.sectionTitle, { color: t.text }]}>Server</Text>
          <Row label="OS" value={`${system.os} ${system.release || ''}`} t={t} />
          <Row label="Host" value={system.hostname || '—'} t={t} />
          <Row label="User" value={system.user || '—'} t={t} />
          <Row label="CWD" value={system.cwd || '—'} t={t} />
          {system.installedAgents && (
            <Row label="Agents" value={`${system.installedAgents.length} installed`} t={t} />
          )}
        </View>
      )}

      {/* About */}
      <View style={[s.card, { backgroundColor: t.surface }]}>
        <Text style={[s.sectionTitle, { color: t.text }]}>About</Text>
        <Row label="App" value="Fauna Mobile v1.0.0" t={t} />
        <Row label="Protocol" value="HTTP + SSE over LAN" t={t} />
      </View>

      <TouchableOpacity style={[s.disconnectBtn, { borderColor: t.error }]} onPress={handleDisconnect}>
        <Text style={{ color: t.error, fontWeight: '600', fontSize: 15 }}>Disconnect</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Row({ label, value, t, valueColor }: { label: string; value: string; t: typeof dark; valueColor?: string }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, { color: t.textDim }]}>{label}</Text>
      <Text style={[s.rowValue, { color: valueColor || t.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: 40 },
  card: { borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.md, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.xs },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '500', maxWidth: '60%', textAlign: 'right' },
  disconnectBtn: { borderWidth: 1.5, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: spacing.lg },
});

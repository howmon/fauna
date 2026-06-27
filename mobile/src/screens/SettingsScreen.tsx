// Settings / connection screen

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, useColorScheme, TextInput,
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
  const [syncState, setSyncState] = useState<{ settings?: api.ServerlessSyncSettings; peers: api.ServerlessPeer[]; conflicts: any[] }>({ peers: [], conflicts: [] });
  const [pairingUrl, setPairingUrl] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);

  useEffect(() => {
    loadConnection().then(setConn);
    api.getSystemContext().then(setSystem).catch(() => {});
    loadServerlessSync();
  }, []);

  async function loadServerlessSync() {
    try {
      const data = await api.getServerlessPeers();
      setSyncState({ settings: data.settings, peers: data.peers || [], conflicts: data.conflicts || [] });
    } catch {
      setSyncState({ peers: [], conflicts: [] });
    }
  }

  async function handleImportPeer() {
    const raw = pairingUrl.trim();
    if (!raw) return;
    setSyncBusy(true);
    try {
      await api.importServerlessPeer(raw);
      setPairingUrl('');
      await loadServerlessSync();
      Alert.alert('Device synced', 'This phone asked Fauna desktop to import and pair with the device.');
    } catch (e: any) {
      Alert.alert('Pairing failed', e.message || 'Could not import serverless sync link');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleRunSync() {
    setSyncBusy(true);
    try {
      await api.runServerlessAutoSync(true);
      await loadServerlessSync();
    } catch (e: any) {
      Alert.alert('Sync failed', e.message || 'Could not run serverless sync');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleToggleAutoSync() {
    setSyncBusy(true);
    try {
      const current = syncState.settings;
      await api.updateServerlessAutoSync({ autoSync: !(current?.autoSync === true), intervalMs: current?.intervalMs || 900000, includeFiles: current?.includeFiles === true, push: current?.push !== false });
      await loadServerlessSync();
    } catch (e: any) {
      Alert.alert('Update failed', e.message || 'Could not update serverless sync');
    } finally {
      setSyncBusy(false);
    }
  }

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
            <Row label="Host" value={conn.tunnelUrl || `${conn.host}:${conn.port}`} t={t} />
            {conn.tunnelUrl && <Row label="Mode" value="Tunnel (remote)" t={t} valueColor={t.teal} />}
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

      {/* Serverless sync */}
      <View style={[s.card, { backgroundColor: t.surface }]}> 
        <Text style={[s.sectionTitle, { color: t.text }]}>Serverless Sync</Text>
        <Row label="Peers" value={`${syncState.peers.length} paired`} t={t} />
        <Row label="Auto-sync" value={syncState.settings?.autoSync ? 'On' : 'Off'} t={t} valueColor={syncState.settings?.autoSync ? t.success : t.textMuted} />
        {syncState.conflicts.length > 0 && <Row label="Conflicts" value={`${syncState.conflicts.length} need review`} t={t} valueColor={t.warn} />}
        {syncState.peers.map(peer => (
          <View key={peer.id} style={[s.peerRow, { borderColor: t.border }]}> 
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.peerName, { color: t.text }]} numberOfLines={1}>{peer.name || 'Fauna device'}</Text>
              <Text style={[s.peerMeta, { color: peer.lastError ? t.error : t.textMuted }]} numberOfLines={1}>
                {peer.lastError?.message || (peer.lastSyncAt ? `Last sync ${new Date(peer.lastSyncAt).toLocaleString()}` : 'Not synced yet')}
              </Text>
            </View>
          </View>
        ))}
        <TextInput
          style={[s.pairInput, { backgroundColor: t.surface2, color: t.text, borderColor: t.border }]}
          placeholder="Paste fauna://serverless-sync link"
          placeholderTextColor={t.textMuted}
          value={pairingUrl}
          onChangeText={setPairingUrl}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <View style={s.syncActions}>
          <TouchableOpacity style={[s.smallBtn, { borderColor: t.border, opacity: syncBusy ? 0.5 : 1 }]} onPress={handleImportPeer} disabled={syncBusy}>
            <Text style={[s.smallBtnText, { color: t.text }]}>Import peer</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.smallBtn, { borderColor: t.border, opacity: syncBusy ? 0.5 : 1 }]} onPress={handleToggleAutoSync} disabled={syncBusy}>
            <Text style={[s.smallBtnText, { color: t.text }]}>{syncState.settings?.autoSync ? 'Disable auto' : 'Enable auto'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.smallBtn, { backgroundColor: t.teal, borderColor: t.teal, opacity: syncBusy ? 0.5 : 1 }]} onPress={handleRunSync} disabled={syncBusy}>
            <Text style={[s.smallBtnText, { color: '#fff' }]}>Sync now</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* About */}
      <View style={[s.card, { backgroundColor: t.surface }]}>
        <Text style={[s.sectionTitle, { color: t.text }]}>About</Text>
        <Row label="App" value="Fauna Mobile v1.0.0" t={t} />
        <Row label="Protocol" value={conn?.tunnelUrl ? 'HTTPS Tunnel' : 'HTTP + SSE over LAN'} t={t} />
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
  peerRow: { borderTopWidth: 1, paddingTop: spacing.sm, marginTop: spacing.sm },
  peerName: { fontSize: 14, fontWeight: '700' },
  peerMeta: { fontSize: 12, marginTop: 2 },
  pairInput: { minHeight: 72, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, fontSize: 13, marginTop: spacing.md, textAlignVertical: 'top' },
  syncActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  smallBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  smallBtnText: { fontSize: 12, fontWeight: '700' },
  disconnectBtn: { borderWidth: 1.5, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: spacing.lg },
});

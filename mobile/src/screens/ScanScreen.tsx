// QR Scanner screen — auto-detects the Fauna server by scanning the QR code
// shown in the desktop app (Settings → Mobile) or CLI (/pair command).
// QR payload: fauna://pair?host=<ip>&port=<port>&token=<token>&name=<hostname>

import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, useColorScheme, Animated, Keyboard,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { dark, light, spacing, radius } from '../lib/theme';
import * as api from '../lib/api';
import { saveConnection } from '../lib/storage';

interface Props {
  onConnected: () => void;
}

export default function ScanScreen({ onConnected }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualToken, setManualToken] = useState('');
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse the corner brackets while scanning
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  async function handlePair(host: string, port: number, token: string, name?: string) {
    setConnecting(true);
    setStatusMsg(`Connecting to ${name || host}…`);
    try {
      api.configure(host, port, token);
      const ok = await api.verifyConnection();
      if (!ok) throw new Error('Connection failed — server rejected auth');
      await saveConnection({ host, port, token, serverName: name });
      setStatusMsg('Connected!');
      onConnected();
    } catch (e: any) {
      Alert.alert('Connection Failed', e.message);
      setScanned(false);
      setStatusMsg('');
    } finally {
      setConnecting(false);
    }
  }

  function handleBarCodeScanned({ data }: { data: string }) {
    if (scanned || connecting) return;
    setScanned(true);
    try {
      const url = new URL(data);
      if (url.protocol !== 'fauna:' || url.pathname !== '//pair') throw new Error('Not a Fauna QR code');
      const host = url.searchParams.get('host') || '';
      const port = parseInt(url.searchParams.get('port') || '3737', 10);
      const token = url.searchParams.get('token') || '';
      const name = url.searchParams.get('name') || undefined;
      if (!host || !token) throw new Error('Incomplete QR data');
      handlePair(host, port, token, name);
    } catch (e: any) {
      Alert.alert('Invalid QR Code', e.message);
      setScanned(false);
    }
  }

  function handleManualConnect() {
    Keyboard.dismiss();
    const raw = manualHost.trim();
    if (!raw) return;
    // Accept "host:port" or just "host"
    const [h, p] = raw.includes(':') ? raw.split(':') : [raw, '3737'];
    handlePair(h, parseInt(p, 10) || 3737, manualToken.trim(), h);
  }

  // ── No permissions yet ──────────────────────────────────────────────
  if (!permission) return <View style={[s.container, { backgroundColor: t.bg }]} />;

  if (!permission.granted) {
    return (
      <View style={[s.container, { backgroundColor: t.bg }]}>
        <Text style={[s.logo, { color: t.teal }]}>◉</Text>
        <Text style={[s.title, { color: t.text }]}>Fauna</Text>
        <Text style={[s.subtitle, { color: t.textDim }]}>
          Point your camera at the QR code shown in{'\n'}Fauna desktop or CLI to connect automatically.
        </Text>
        <TouchableOpacity style={[s.btn, { backgroundColor: t.teal }]} onPress={requestPermission}>
          <Text style={s.btnText}>Enable Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { requestPermission(); setShowManual(true); }} style={s.linkBtn}>
          <Text style={[s.linkText, { color: t.textMuted }]}>or connect by IP address</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Manual entry (collapsed by default) ─────────────────────────────
  if (showManual) {
    return (
      <View style={[s.container, { backgroundColor: t.bg }]}>
        <Text style={[s.title, { color: t.text }]}>Connect by IP</Text>
        <Text style={[s.hint, { color: t.textDim }]}>
          Enter the IP shown when Fauna starts (e.g. 192.168.1.15:3737)
        </Text>
        <TextInput
          style={[s.input, { backgroundColor: t.surface, color: t.text, borderColor: t.border }]}
          placeholder="host:port  (e.g. 192.168.1.15:3737)"
          placeholderTextColor={t.textMuted}
          value={manualHost}
          onChangeText={setManualHost}
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleManualConnect}
        />
        <TextInput
          style={[s.input, { backgroundColor: t.surface, color: t.text, borderColor: t.border }]}
          placeholder="Pair token (from /pair command)"
          placeholderTextColor={t.textMuted}
          value={manualToken}
          onChangeText={setManualToken}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={handleManualConnect}
        />
        <TouchableOpacity
          style={[s.btn, { backgroundColor: t.teal, opacity: connecting ? 0.5 : 1 }]}
          onPress={handleManualConnect}
          disabled={connecting}
        >
          <Text style={s.btnText}>{connecting ? 'Connecting…' : 'Connect'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowManual(false)} style={s.linkBtn}>
          <Text style={[s.linkText, { color: t.teal }]}>← Scan QR code instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Primary view: QR scanner ────────────────────────────────────────
  return (
    <View style={[s.container, { backgroundColor: t.bg }]}>
      <Text style={[s.logo, { color: t.teal }]}>◉</Text>
      <Text style={[s.title, { color: t.text }]}>Fauna</Text>
      <Text style={[s.hint, { color: t.textDim }]}>
        Scan the QR code from Fauna desktop or CLI
      </Text>

      <View style={s.cameraWrap}>
        <CameraView
          style={s.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />
        {/* Animated corner brackets */}
        <View style={s.overlay} pointerEvents="none">
          {(['TL', 'TR', 'BL', 'BR'] as const).map(pos => (
            <Animated.View
              key={pos}
              style={[
                s.corner,
                s[`corner${pos}`],
                { borderColor: t.teal, opacity: connecting ? 1 : pulseAnim },
              ]}
            />
          ))}
        </View>
      </View>

      {(connecting || statusMsg) ? (
        <Text style={[s.statusText, { color: t.teal }]}>{statusMsg}</Text>
      ) : null}

      <TouchableOpacity onPress={() => setShowManual(true)} style={s.linkBtn}>
        <Text style={[s.linkText, { color: t.textMuted }]}>Connect by IP address</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  logo: { fontSize: 48, marginBottom: 4 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 22, paddingHorizontal: spacing.md },
  hint: { fontSize: 13, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 20 },
  btn: { paddingVertical: 14, paddingHorizontal: 32, borderRadius: radius.md, marginTop: spacing.md, width: '100%', alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  linkBtn: { marginTop: spacing.lg, padding: spacing.sm },
  linkText: { fontSize: 13 },
  statusText: { fontSize: 14, fontWeight: '600', marginTop: spacing.md },
  input: { width: '100%', borderWidth: 1, borderRadius: radius.md, padding: 14, fontSize: 16, marginBottom: spacing.md },
  cameraWrap: { width: 260, height: 260, borderRadius: radius.lg, overflow: 'hidden', position: 'relative', marginTop: spacing.md },
  camera: { width: '100%', height: '100%' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  corner: { position: 'absolute', width: 36, height: 36, borderWidth: 3 },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: radius.md },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: radius.md },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: radius.md },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: radius.md },
});

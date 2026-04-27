// Artifact viewer panel — displays HTML, SVG, markdown, JSON, CSV artifacts

import React, { useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  useColorScheme, Platform, Share,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';
import { dark, light, spacing, radius } from '../lib/theme';
import type { ParsedArtifact } from './MessageBubble';

interface Props {
  artifact: ParsedArtifact;
  onClose: () => void;
}

export default function ArtifactPanel({ artifact, onClose }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;

  const mdStyles = useMemo(() => ({
    body: { color: t.text, fontSize: 15, lineHeight: 22 },
    heading1: { color: t.text, fontSize: 22, fontWeight: '700' as const, marginBottom: 8, marginTop: 12 },
    heading2: { color: t.text, fontSize: 19, fontWeight: '600' as const, marginBottom: 6, marginTop: 10 },
    heading3: { color: t.text, fontSize: 16, fontWeight: '600' as const, marginBottom: 4, marginTop: 8 },
    strong: { fontWeight: '600' as const },
    link: { color: t.teal },
    code_inline: { backgroundColor: t.codeBg, color: t.tealLight, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, paddingHorizontal: 4, borderRadius: 3 },
    code_block: { backgroundColor: t.codeBg, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: t.text },
    fence: { backgroundColor: t.codeBg, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: t.text },
    blockquote: { backgroundColor: t.surface2, borderLeftColor: t.teal, borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4 },
    hr: { backgroundColor: t.border, height: 1, marginVertical: 10 },
    list_item: { marginBottom: 4, flexDirection: 'row' as const },
    bullet_list_icon: { color: t.teal, marginRight: 6, fontSize: 14, lineHeight: 22 },
    ordered_list_icon: { color: t.teal, marginRight: 6, fontSize: 14, lineHeight: 22, fontWeight: '600' as const },
    table: { borderColor: t.border, borderWidth: 1, borderRadius: 6, marginVertical: 6 },
    tr: { borderBottomColor: t.border, borderBottomWidth: 1 },
    th: { padding: 6, fontWeight: '600' as const },
    td: { padding: 6 },
  }), [t]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(artifact.content);
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: artifact.content, title: artifact.title });
    } catch {}
  };

  const renderContent = () => {
    switch (artifact.type) {
      case 'markdown':
        return <Markdown style={mdStyles}>{artifact.content}</Markdown>;

      case 'json':
        try {
          const formatted = JSON.stringify(JSON.parse(artifact.content), null, 2);
          return (
            <View style={[s.codeWrap, { backgroundColor: t.codeBg }]}>
              <Text style={[s.codeText, { color: t.text }]} selectable>{formatted}</Text>
            </View>
          );
        } catch {
          return (
            <View style={[s.codeWrap, { backgroundColor: t.codeBg }]}>
              <Text style={[s.codeText, { color: t.text }]} selectable>{artifact.content}</Text>
            </View>
          );
        }

      case 'html':
      case 'svg':
      case 'csv':
      default:
        return (
          <View style={[s.codeWrap, { backgroundColor: t.codeBg }]}>
            <Text style={[s.codeText, { color: t.text }]} selectable>{artifact.content}</Text>
          </View>
        );
    }
  };

  return (
    <View style={[s.container, { backgroundColor: t.surface }]}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: t.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: t.text }]}>{artifact.title}</Text>
          <Text style={[s.subtitle, { color: t.textMuted }]}>{artifact.type.toUpperCase()} · {artifact.content.length} chars</Text>
        </View>
        <TouchableOpacity style={[s.headerBtn, { backgroundColor: t.surface2 }]} onPress={handleCopy}>
          <Text style={[s.headerBtnText, { color: t.text }]}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.headerBtn, { backgroundColor: t.surface2 }]} onPress={handleShare}>
          <Text style={[s.headerBtnText, { color: t.text }]}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.headerBtn, { backgroundColor: t.surface2 }]} onPress={onClose}>
          <Text style={[s.headerBtnText, { color: t.text }]}>Close</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {renderContent()}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, gap: 8 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11, marginTop: 2 },
  headerBtn: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 16 },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  codeWrap: { padding: spacing.md, borderRadius: radius.md },
  codeText: { fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18 },
});

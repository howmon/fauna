// Rich message bubble with markdown, chain-of-thought, copy & share

import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, Image,
  useColorScheme, Share, Alert,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';
import { dark, light, spacing, radius, type Theme } from '../lib/theme';

// ── Types ────────────────────────────────────────────────────────────────

interface Props {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  images?: Array<{ uri: string; mime?: string }>;
  agentName?: string;
  streaming?: boolean;
  onViewArtifact?: (artifact: ParsedArtifact) => void;
}

export interface ParsedArtifact {
  id: string;
  type: string;
  title: string;
  content: string;
  lang?: string;
}

// ── Action-block stripping ───────────────────────────────────────────────

const ACTION_BLOCK_RE = /```(?:browser-ext-action|shell-exec|write-file|task-create|patch-agent|figma-exec|update-prompt)[^]*?```/g;

function stripActionBlocks(text: string): string {
  return text.replace(ACTION_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Chain-of-thought parsing removed — Markdown handles code blocks natively

// ── Artifact extraction (mirrors web UI) ─────────────────────────────────

const ARTIFACT_RE = /```(html|svg|markdown|json|csv)\n([\s\S]*?)```/g;

function extractArtifacts(text: string): ParsedArtifact[] {
  const artifacts: ParsedArtifact[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ARTIFACT_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const lang = m[1];
    const content = m[2].trim();
    // Only treat it as an artifact if it's large enough to be meaningful
    if (content.length < 100) continue;
    const typeMap: Record<string, string> = { html: 'html', svg: 'svg', markdown: 'markdown', json: 'json', csv: 'csv' };
    const titleMap: Record<string, string> = { html: 'HTML Preview', svg: 'SVG Image', markdown: 'Document', json: 'JSON Data', csv: 'CSV Data' };
    artifacts.push({
      id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: typeMap[lang] || lang,
      title: titleMap[lang] || lang.toUpperCase(),
      content,
      lang,
    });
  }
  return artifacts;
}

// ── Code block pill (chain of thought style) ─────────────────────────────

// CodePill removed — code blocks are rendered inline by Markdown

// ── Main component ───────────────────────────────────────────────────────

export default function MessageBubble({ role, content, images, agentName, streaming, onViewArtifact }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const isUser = role === 'user';
  const isTool = role === 'tool';
  const [showActions, setShowActions] = useState(false);

  const cleaned = isUser ? content : stripActionBlocks(content || '');

  // ALL hooks must be called unconditionally (React rules of hooks)
  const artifacts = useMemo(() => (isUser || isTool) ? [] : extractArtifacts(content || ''), [content, isUser, isTool]);

  const mdStyles = useMemo(() => ({
    body: { color: t.text, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 6 },
    heading1: { color: t.text, fontSize: 22, fontWeight: '700' as const, marginBottom: 8, marginTop: 12 },
    heading2: { color: t.text, fontSize: 19, fontWeight: '600' as const, marginBottom: 6, marginTop: 10 },
    heading3: { color: t.text, fontSize: 16, fontWeight: '600' as const, marginBottom: 4, marginTop: 8 },
    strong: { fontWeight: '600' as const },
    em: { fontStyle: 'italic' as const },
    link: { color: t.teal },
    blockquote: { backgroundColor: t.surface2, borderLeftColor: t.teal, borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4, marginVertical: 6 },
    code_inline: { backgroundColor: t.codeBg, color: t.tealLight, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, paddingHorizontal: 4, borderRadius: 3 },
    code_block: { backgroundColor: t.codeBg, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: t.text },
    fence: { backgroundColor: t.codeBg, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: t.text },
    list_item: { marginBottom: 4, flexDirection: 'row' as const },
    bullet_list: { marginBottom: 6 },
    ordered_list: { marginBottom: 6 },
    bullet_list_icon: { color: t.teal, marginRight: 6, fontSize: 14, lineHeight: 22 },
    ordered_list_icon: { color: t.teal, marginRight: 6, fontSize: 14, lineHeight: 22, fontWeight: '600' as const },
    table: { borderColor: t.border, borderWidth: 1, borderRadius: 6, marginVertical: 6 },
    tr: { borderBottomColor: t.border, borderBottomWidth: 1 },
    th: { padding: 6, fontWeight: '600' as const },
    td: { padding: 6 },
    hr: { backgroundColor: t.border, height: 1, marginVertical: 10 },
    image: { borderRadius: 8 },
  }), [t]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(cleaned);
    setShowActions(false);
    Alert.alert('Copied', 'Message copied to clipboard');
  };

  const handleShare = async () => {
    setShowActions(false);
    try {
      await Share.share({ message: cleaned });
    } catch {}
  };

  // ── Render ──────────────────────────────────────────────────────────────

  // Tool messages — compact mono style
  if (isTool) {
    return (
      <View style={[styles.toolBubble, { backgroundColor: t.surface2 }]}>
        <Text style={[styles.toolText, { color: t.textDim }]}>{content}</Text>
      </View>
    );
  }

  // Empty assistant message (still streaming) — show nothing yet
  if (!isUser && !cleaned) return null;

  // User message — render as plain text (with images)
  if (isUser) {
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={() => setShowActions(!showActions)}
        style={[styles.bubble, { backgroundColor: t.userBg, alignSelf: 'flex-end' }]}
      >
        {images && images.length > 0 && (
          <View style={styles.imageRow}>
            {images.map((img, i) => (
              <Image key={i} source={{ uri: img.uri }} style={styles.attachedImage} resizeMode="cover" />
            ))}
          </View>
        )}
        <Text style={[styles.msgText, { color: t.text }]} selectable>{content}</Text>
        {showActions && <ActionBar t={t} onCopy={handleCopy} onShare={handleShare} />}
      </TouchableOpacity>
    );
  }

  // AI message with chain-of-thought rendering
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onLongPress={() => setShowActions(!showActions)}
      style={[styles.bubble, { backgroundColor: t.aiBg, alignSelf: 'flex-start' }]}
    >
      <Text style={[styles.roleLabel, { color: t.teal }]}>
        {agentName || 'Fauna'}{streaming ? ' ...' : ''}
      </Text>

      <Markdown style={mdStyles}>{cleaned}</Markdown>

      {/* Artifact cards */}
      {artifacts.length > 0 && (
        <View style={styles.artifactRow}>
          {artifacts.map((art) => (
            <TouchableOpacity
              key={art.id}
              style={[styles.artifactCard, { backgroundColor: t.surface2, borderColor: t.border }]}
              onPress={() => onViewArtifact?.(art)}
            >
              <Text style={[styles.artifactIcon, { color: t.teal }]}>
                {art.type === 'html' ? 'HTML' : art.type === 'svg' ? 'SVG' : art.type === 'json' ? 'JSON' : 'DOC'}
              </Text>
              <Text style={[styles.artifactLabel, { color: t.text }]} numberOfLines={1}>{art.title}</Text>
              <Text style={{ color: t.textMuted, fontSize: 11 }}>Open</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {showActions && <ActionBar t={t} onCopy={handleCopy} onShare={handleShare} />}
    </TouchableOpacity>
  );
}

// ── Action bar (copy / share) ────────────────────────────────────────────

function ActionBar({ t, onCopy, onShare }: { t: Theme; onCopy: () => void; onShare: () => void }) {
  return (
    <View style={[styles.actionBar, { backgroundColor: t.surface3, borderColor: t.border }]}>
      <TouchableOpacity style={styles.actionBtn} onPress={onCopy}>
        <Text style={[styles.actionBtnText, { color: t.text }]}>Copy</Text>
      </TouchableOpacity>
      <View style={[styles.actionDivider, { backgroundColor: t.border }]} />
      <TouchableOpacity style={styles.actionBtn} onPress={onShare}>
        <Text style={[styles.actionBtnText, { color: t.text }]}>Share</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bubble: { maxWidth: '90%', padding: spacing.md, borderRadius: radius.lg, marginBottom: spacing.sm },
  toolBubble: { alignSelf: 'flex-start', padding: spacing.sm, borderRadius: radius.sm, marginBottom: spacing.xs, marginLeft: spacing.sm },
  toolText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  roleLabel: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  msgText: { fontSize: 15, lineHeight: 22 },

  // Code pill (chain of thought)
  codePill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, gap: 6 },
  codePillIcon: { fontSize: 12, fontWeight: '700' },
  codePillLabel: { fontSize: 13, fontWeight: '500', flex: 1 },
  codeBlock: { padding: 10, borderRadius: 8, marginTop: 2 },
  codeText: { fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18 },

  // Images
  imageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  attachedImage: { width: 120, height: 120, borderRadius: 8 },

  // Artifacts
  artifactRow: { marginTop: 8, gap: 6 },
  artifactCard: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 10, borderWidth: 1, gap: 8 },
  artifactIcon: { fontSize: 16, fontWeight: '700' },
  artifactLabel: { fontSize: 14, fontWeight: '500', flex: 1 },

  // Action bar
  actionBar: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, marginTop: 8, overflow: 'hidden' },
  actionBtn: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  actionBtnText: { fontSize: 13, fontWeight: '500' },
  actionDivider: { width: 1 },
});

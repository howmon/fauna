// Gen-UI block renderer — renders Fauna's gen-ui JSON spec as React Native components
// Spec format: { root: "id", state?: {...}, elements: { id: { type, props, children?, visible? } } }

import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, TextInput,
  Platform, useColorScheme,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import { dark, light, type Theme } from '../lib/theme';

// ── Types ─────────────────────────────────────────────────────────────────

interface GenUISpec {
  root: string;
  state?: Record<string, any>;
  elements: Record<string, GenUIElement>;
}

interface GenUIElement {
  type: string;
  props?: Record<string, any>;
  children?: string[];
  visible?: any;
}

interface RenderCtx {
  elements: Record<string, GenUIElement>;
  state: Record<string, any>;
  dispatch: (action: string, params: any) => void;
  t: Theme;
}

// ── State helpers ─────────────────────────────────────────────────────────

function getPath(obj: Record<string, any>, path: string): any {
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function setPath(obj: Record<string, any>, path: string, value: any): Record<string, any> {
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  const next = { ...obj };
  let cur: any = next;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = typeof cur[parts[i]] === 'object' ? { ...cur[parts[i]] } : {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}

// ── Expression resolution ─────────────────────────────────────────────────

function resolve(expr: any, state: Record<string, any>): any {
  if (expr === null || expr === undefined || typeof expr !== 'object') return expr;
  if (expr.$state !== undefined) return getPath(state, expr.$state);
  if (expr.$template) {
    return (expr.$template as string).replace(/\$\{([^}]+)\}/g, (_: string, p: string) => {
      const v = getPath(state, p); return v != null ? String(v) : '';
    });
  }
  if (expr.$cond !== undefined) {
    const cond = resolve(expr.$cond, state);
    const result = expr.eq !== undefined ? cond == expr.eq : !!cond;
    return result ? resolve(expr.$then, state) : resolve(expr.$else, state);
  }
  return expr;
}

function resolveProps(raw: Record<string, any> | undefined, state: Record<string, any>): Record<string, any> {
  if (!raw) return {};
  const out: Record<string, any> = {};
  for (const k of Object.keys(raw)) out[k] = resolve(raw[k], state);
  return out;
}

// ── Visibility check ──────────────────────────────────────────────────────

function isVisible(el: GenUIElement, state: Record<string, any>): boolean {
  if (!el.visible) return true;
  const rules = Array.isArray(el.visible) ? el.visible : [el.visible];
  return rules.every((rule: any) => {
    const val = getPath(state, rule.$state);
    const result = rule.eq !== undefined ? val == rule.eq : !!val;
    return rule.not ? !result : result;
  });
}

// ── Format helper ─────────────────────────────────────────────────────────

function formatValue(val: any, fmt?: string): string {
  if (val == null) return '';
  const s = String(val);
  if (fmt === 'currency' && !isNaN(parseFloat(s)))
    return '$' + parseFloat(s).toLocaleString('en-US', { minimumFractionDigits: 0 });
  if (fmt === 'percent') return s + '%';
  if (fmt === 'number' && !isNaN(parseFloat(s)))
    return parseFloat(s).toLocaleString();
  return s;
}

function optionParts(opt: any): { label: string; value: any } {
  if (typeof opt === 'string' || typeof opt === 'number') return { label: String(opt), value: opt };
  return { label: String(opt?.label ?? opt?.value ?? ''), value: opt?.value ?? opt?.label ?? '' };
}

function boundStatePath(value: any): string | null {
  return value && typeof value === 'object' && value.$bindState ? String(value.$bindState) : null;
}

function sanitizeSvg(markup: string): string {
  return String(markup || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>\/]+/gi, '')
    .replace(/href\s*=\s*(["'])javascript:.*?\1/gi, 'href="#"')
    .replace(/xlink:href\s*=\s*(["'])javascript:.*?\1/gi, 'xlink:href="#"');
}

// ── Component renderers ───────────────────────────────────────────────────

function renderEl(id: string, ctx: RenderCtx): React.ReactNode {
  const el = ctx.elements[id];
  if (!el || !isVisible(el, ctx.state)) return null;
  const props = resolveProps(el.props, ctx.state);
  const children = (el.children || []).map((cid, i) => (
    <React.Fragment key={cid + i}>{renderEl(cid, ctx)}</React.Fragment>
  ));
  const { t } = ctx;

  switch (el.type) {
    case 'Card': {
      return (
        <View style={[gs.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          {props.title ? <Text style={[gs.cardTitle, { color: t.text }]}>{props.title}</Text> : null}
          {props.description ? <Text style={[gs.cardDesc, { color: t.textMuted }]}>{props.description}</Text> : null}
          {children}
        </View>
      );
    }

    case 'Stack': {
      const isRow = props.direction === 'horizontal';
      return (
        <View style={[
          gs.stack,
          isRow ? gs.stackRow : gs.stackCol,
          props.wrap && { flexWrap: 'wrap' },
          props.gap ? { gap: typeof props.gap === 'number' ? props.gap : 8 } : undefined,
        ]}>
          {children}
        </View>
      );
    }

    case 'Grid': {
      const cols = props.columns || 2;
      return (
        <View style={[gs.grid, { gap: props.gap || 8 }]}>
          {(el.children || []).map((cid, i) => (
            <View key={cid + i} style={{ width: `${100 / cols}%` as any }}>
              {renderEl(cid, ctx)}
            </View>
          ))}
        </View>
      );
    }

    case 'Heading': {
      const lvl = parseInt(props.level) || 2;
      const sizes: Record<number, number> = { 1: 22, 2: 19, 3: 16, 4: 15, 5: 14, 6: 13 };
      return (
        <Text style={[gs.heading, { color: t.text, fontSize: sizes[lvl] || 16, marginTop: lvl <= 2 ? 10 : 6 }]}>
          {props.text || ''}
        </Text>
      );
    }

    case 'Text': {
      return (
        <Text style={[
          gs.text,
          { color: props.muted ? t.textMuted : t.text },
          props.strong && { fontWeight: '600' as const },
          props.small && { fontSize: 12 },
          props.code && { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 },
        ]}>
          {props.text || ''}
        </Text>
      );
    }

    case 'Badge': {
      const varColors: Record<string, { bg: string; text: string }> = {
        default:  { bg: t.surface2,              text: t.textMuted },
        success:  { bg: 'rgba(46,164,79,.15)',    text: '#2ea44f'   },
        warning:  { bg: 'rgba(210,153,34,.15)',   text: '#d29922'   },
        error:    { bg: 'rgba(207,34,46,.15)',     text: '#cf222e'   },
        info:     { bg: 'rgba(9,105,218,.12)',     text: '#0969da'   },
      };
      const variant = props.variant || 'default';
      const vc = varColors[variant] || varColors.default;
      return (
        <View style={[gs.badge, { backgroundColor: vc.bg }]}>
          <Text style={[gs.badgeText, { color: vc.text }]}>{props.label || props.text || ''}</Text>
        </View>
      );
    }

    case 'Stat': {
      const val = formatValue(props.value, props.format);
      const trend = props.trend != null ? parseFloat(String(props.trend)) : null;
      return (
        <View style={[gs.stat, { backgroundColor: t.surface2, borderRadius: 10 }]}>
          <Text style={[gs.statValue, { color: t.text }]}>{val}</Text>
          <Text style={[gs.statLabel, { color: t.textMuted }]}>{props.label || ''}</Text>
          {trend != null ? (
            <Text style={[gs.statTrend, { color: trend >= 0 ? '#2ea44f' : '#cf222e' }]}>
              {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
            </Text>
          ) : null}
        </View>
      );
    }

    case 'Alert': {
      const variant = props.variant || props.type || 'info';
      const alertColors: Record<string, { border: string; bg: string; icon: string }> = {
        info:    { border: '#0969da', bg: 'rgba(9,105,218,.08)',  icon: 'ℹ' },
        success: { border: '#2ea44f', bg: 'rgba(46,164,79,.08)',  icon: '✓' },
        warning: { border: '#d29922', bg: 'rgba(210,153,34,.08)', icon: '⚠' },
        error:   { border: '#cf222e', bg: 'rgba(207,34,46,.08)',  icon: '✕' },
      };
      const ac = alertColors[variant] || alertColors.info;
      return (
        <View style={[gs.alert, { borderLeftColor: ac.border, backgroundColor: ac.bg }]}>
          <Text style={[gs.alertIcon, { color: ac.border }]}>{ac.icon}</Text>
          <View style={{ flex: 1 }}>
            {props.title ? <Text style={[gs.alertTitle, { color: t.text }]}>{props.title}</Text> : null}
            {props.message ? <Text style={[gs.alertMsg, { color: t.text }]}>{props.message}</Text> : null}
            {children}
          </View>
        </View>
      );
    }

    case 'Button': {
      const variant = props.variant || 'default';
      const btnColors: Record<string, { bg: string; text: string }> = {
        default:  { bg: t.surface2,  text: t.text   },
        primary:  { bg: t.teal,      text: '#fff'    },
        danger:   { bg: '#cf222e',   text: '#fff'    },
        ghost:    { bg: 'transparent', text: t.teal  },
      };
      const bc = btnColors[variant] || btnColors.default;
      return (
        <TouchableOpacity
          style={[gs.btn, { backgroundColor: bc.bg, borderColor: t.border, opacity: props.disabled ? 0.5 : 1 }]}
          disabled={!!props.disabled}
          onPress={() => props.action && ctx.dispatch(props.action, props.actionParams || {})}
        >
          <Text style={[gs.btnText, { color: bc.text }]}>{props.label || props.text || 'Button'}</Text>
        </TouchableOpacity>
      );
    }

    case 'Divider': {
      return props.label
        ? (
          <View style={gs.dividerLabeled}>
            <View style={[gs.dividerLine, { backgroundColor: t.border }]} />
            <Text style={[gs.dividerLabel, { color: t.textMuted }]}>{props.label}</Text>
            <View style={[gs.dividerLine, { backgroundColor: t.border }]} />
          </View>
        )
        : <View style={[gs.divider, { backgroundColor: t.border }]} />;
    }

    case 'KeyValue': {
      const items: Array<{ key: string; value: any }> = props.items || [];
      return (
        <View style={[gs.kvList, { borderColor: t.border }]}>
          {items.map((item, i) => (
            <View key={i} style={[gs.kvRow, i < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border }]}>
              <Text style={[gs.kvKey, { color: t.textMuted }]}>{item.key}</Text>
              <Text style={[gs.kvVal, { color: t.text }]}>{String(item.value ?? '')}</Text>
            </View>
          ))}
        </View>
      );
    }

    case 'List': {
      const items: string[] = props.items || [];
      const ordered = props.ordered;
      return (
        <View style={gs.listContainer}>
          {items.map((item, i) => (
            <View key={i} style={gs.listItem}>
              <Text style={[gs.listBullet, { color: t.teal }]}>{ordered ? `${i + 1}.` : '•'}</Text>
              <Text style={[gs.listText, { color: t.text }]}>{String(item)}</Text>
            </View>
          ))}
        </View>
      );
    }

    case 'Table': {
      const columns: string[] = props.columns || [];
      const rows: string[][] = props.rows || [];
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[gs.table, { borderColor: t.border }]}>
            {/* Header */}
            <View style={[gs.tableRow, gs.tableHead, { backgroundColor: t.surface2, borderBottomColor: t.border }]}>
              {columns.map((col, i) => (
                <Text key={i} style={[gs.tableCell, gs.tableCellHead, { color: t.text, borderRightColor: t.border }]}>{col}</Text>
              ))}
            </View>
            {rows.map((row, ri) => (
              <View key={ri} style={[gs.tableRow, { borderBottomColor: ri < rows.length - 1 ? t.border : 'transparent' }]}>
                {row.map((cell, ci) => (
                  <Text key={ci} style={[gs.tableCell, { color: t.text, borderRightColor: t.border }]}>{String(cell ?? '')}</Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }

    case 'Progress': {
      const pct = Math.max(0, Math.min(100, parseFloat(String(props.value ?? 0))));
      const barColor = props.color || t.teal;
      return (
        <View style={gs.progressWrap}>
          {props.label ? <Text style={[gs.progressLabel, { color: t.text }]}>{props.label}</Text> : null}
          <View style={[gs.progressTrack, { backgroundColor: t.surface2 }]}>
            <View style={[gs.progressFill, { width: `${pct}%` as any, backgroundColor: barColor }]} />
          </View>
          {props.showValue !== false ? (
            <Text style={[gs.progressValue, { color: t.textMuted }]}>{pct.toFixed(0)}%</Text>
          ) : null}
        </View>
      );
    }

    case 'Code': {
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[gs.codeBlock, { backgroundColor: t.codeBg }]}>
            {props.language ? (
              <Text style={[gs.codeLang, { color: t.textMuted }]}>{props.language}</Text>
            ) : null}
            <Text style={[gs.codeText, { color: t.text }]} selectable>{props.code || ''}</Text>
          </View>
        </ScrollView>
      );
    }

    case 'Image': {
      const src = props.src || props.url;
      if (!src || !/^https?:\/\/|^data:image\//.test(String(src))) return null;
      const height = typeof props.height === 'number' ? props.height : 180;
      return (
        <View style={gs.mediaWrap}>
          <Image source={{ uri: String(src) }} style={[gs.image, { height }]} resizeMode="contain" accessibilityLabel={props.alt || ''} />
          {props.caption ? <Text style={[gs.caption, { color: t.textMuted }]}>{props.caption}</Text> : null}
        </View>
      );
    }

    case 'SVG': {
      const markup = sanitizeSvg(props.markup || props.svg || '');
      if (!markup) return <Text style={[gs.text, { color: t.textMuted }]}>(no SVG markup)</Text>;
      const height = typeof props.height === 'number' ? props.height : 220;
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}svg{max-width:100%;height:auto;display:block}</style></head><body>${markup}</body></html>`;
      return <View style={[gs.svgWrap, { height }]}><WebView originWhitelist={['*']} source={{ html }} scrollEnabled={false} style={{ backgroundColor: 'transparent' }} /></View>;
    }

    case 'Select': {
      const options = (props.options || []).map(optionParts);
      const bind = boundStatePath(props.value);
      const selected = bind ? getPath(ctx.state, bind) : props.value;
      return (
        <View style={gs.inputWrap}>
          {props.label ? <Text style={[gs.inputLabel, { color: t.textMuted }]}>{props.label}</Text> : null}
          <View style={gs.segmentRow}>
            {options.map((opt: { label: string; value: any }, i: number) => {
              const active = String(selected ?? options[0]?.value ?? '') === String(opt.value);
              return (
                <TouchableOpacity key={i} style={[gs.segment, { borderColor: t.border, backgroundColor: active ? t.teal : t.surface2 }]} onPress={() => bind && ctx.dispatch('setState', { statePath: bind, value: opt.value })}>
                  <Text style={[gs.segmentText, { color: active ? '#fff' : t.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      );
    }

    case 'Input': {
      const bind = boundStatePath(props.value);
      const value = String((bind ? getPath(ctx.state, bind) : props.value) ?? '');
      return (
        <View style={gs.inputWrap}>
          {props.label ? <Text style={[gs.inputLabel, { color: t.textMuted }]}>{props.label}</Text> : null}
          <TextInput
            style={[gs.input, { color: t.text, backgroundColor: t.surface2, borderColor: t.border }]}
            placeholder={props.placeholder || ''}
            placeholderTextColor={t.textMuted}
            value={value}
            secureTextEntry={props.type === 'password'}
            keyboardType={props.type === 'number' ? 'numeric' : 'default'}
            onChangeText={(next) => bind && ctx.dispatch('setState', { statePath: bind, value: next })}
          />
        </View>
      );
    }

    case 'Tabs': {
      const tabs = props.tabs || [];
      const statePath = props.statePath || '__tabs';
      const active = getPath(ctx.state, statePath) ?? (tabs[0] && (typeof tabs[0] === 'string' ? tabs[0] : tabs[0].id));
      const activeIndex = Math.max(0, tabs.findIndex((tab: any) => String(typeof tab === 'string' ? tab : tab.id) === String(active)));
      return (
        <View style={gs.tabs}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={gs.tabBar}>
            {tabs.map((tab: any, i: number) => {
              const id = typeof tab === 'string' ? tab : tab.id;
              const label = typeof tab === 'string' ? tab : (tab.label || tab.id);
              const isActive = String(id) === String(active);
              return <TouchableOpacity key={String(id || i)} style={[gs.tabBtn, { backgroundColor: isActive ? t.teal : t.surface2 }]} onPress={() => ctx.dispatch('setState', { statePath, value: id })}><Text style={[gs.tabText, { color: isActive ? '#fff' : t.text }]}>{label}</Text></TouchableOpacity>;
            })}
          </ScrollView>
          <View>{children[activeIndex] || null}</View>
        </View>
      );
    }

    case 'Carousel': {
      if (!children.length) return null;
      const statePath = props.statePath || '__carousel';
      const idx = Math.max(0, Math.min(children.length - 1, Number(getPath(ctx.state, statePath) ?? 0)));
      const go = (delta: number) => {
        const next = props.loop ? (idx + delta + children.length) % children.length : Math.max(0, Math.min(children.length - 1, idx + delta));
        ctx.dispatch('setState', { statePath, value: next });
      };
      return (
        <View style={gs.carousel}>
          <View>{children[idx]}</View>
          <View style={gs.carouselNav}>
            <TouchableOpacity style={[gs.navBtn, { borderColor: t.border }]} onPress={() => go(-1)}><Text style={{ color: t.text }}>{'<'}</Text></TouchableOpacity>
            <Text style={[gs.caption, { color: t.textMuted }]}>{idx + 1} / {children.length}</Text>
            <TouchableOpacity style={[gs.navBtn, { borderColor: t.border }]} onPress={() => go(1)}><Text style={{ color: t.text }}>{'>'}</Text></TouchableOpacity>
          </View>
        </View>
      );
    }

    case 'MediaPlayer': {
      const src = props.src || '';
      const type = props.type || (/\.(png|jpe?g|gif|webp)$/i.test(src) ? 'image' : 'media');
      return (
        <View style={[gs.mediaCard, { backgroundColor: t.surface2, borderColor: t.border }]}> 
          {props.title ? <Text style={[gs.cardTitle, { color: t.text }]}>{props.title}</Text> : null}
          {type === 'image' && src ? <Image source={{ uri: src }} style={[gs.image, { height: 180 }]} resizeMode="contain" /> : <Text style={[gs.text, { color: t.text }]}>{src || 'Media item'}</Text>}
        </View>
      );
    }

    case 'Playlist': {
      const items = props.items || [];
      return (
        <View style={[gs.mediaCard, { backgroundColor: t.surface2, borderColor: t.border }]}> 
          {props.title ? <Text style={[gs.cardTitle, { color: t.text }]}>{props.title}</Text> : null}
          {items.map((item: any, i: number) => (
            <View key={i} style={[gs.playlistItem, i < items.length - 1 && { borderBottomColor: t.border, borderBottomWidth: StyleSheet.hairlineWidth }]}> 
              <Text style={[gs.text, { color: t.text, fontWeight: '600' }]}>{item.title || item.src || `Item ${i + 1}`}</Text>
              {item.description ? <Text style={[gs.caption, { color: t.textMuted }]}>{item.description}</Text> : null}
            </View>
          ))}
        </View>
      );
    }

    default:
      return <Text style={[gs.text, { color: t.textMuted }]}>Unsupported gen-ui component: {el.type}</Text>;
  }
}

// ── Main component ────────────────────────────────────────────────────────

interface Props {
  spec: GenUISpec;
}

export default function GenUIBlock({ spec }: Props) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [state, setState] = useState<Record<string, any>>(spec.state || {});

  const dispatch = useCallback((action: string, params: any) => {
    switch (action) {
      case 'setState':
        if (params?.statePath != null) {
          setState(prev => setPath(prev, params.statePath, params.value));
        }
        break;
      case 'toggle_visible':
        if (params?.statePath) {
          setState(prev => setPath(prev, params.statePath, !getPath(prev, params.statePath)));
        }
        break;
      case 'copy_text':
        if (params?.text) Clipboard.setStringAsync(String(params.text)).catch(() => {});
        break;
      default: break;
    }
  }, []);

  if (!spec.root || !spec.elements) return null;

  const ctx: RenderCtx = { elements: spec.elements, state, dispatch, t };
  return <View style={gs.root}>{renderEl(spec.root, ctx)}</View>;
}

// ── Styles ────────────────────────────────────────────────────────────────

const gs = StyleSheet.create({
  root: { marginTop: 4 },
  // Card
  card: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  cardDesc: { fontSize: 13, marginBottom: 8 },
  // Stack / Grid
  stack: { gap: 6 },
  stackRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  stackCol: { flexDirection: 'column' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Text
  heading: { fontWeight: '700', marginBottom: 4 },
  text: { fontSize: 14, lineHeight: 20, marginBottom: 2 },
  // Badge
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  // Stat
  stat: { padding: 12, alignItems: 'center', minWidth: 80 },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 12, marginTop: 2 },
  statTrend: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  // Alert
  alert: { flexDirection: 'row', borderLeftWidth: 3, padding: 10, borderRadius: 8, gap: 8, marginBottom: 4 },
  alertIcon: { fontSize: 14, fontWeight: '700', marginTop: 1 },
  alertTitle: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  alertMsg: { fontSize: 13 },
  // Button
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 4 },
  btnText: { fontSize: 14, fontWeight: '600' },
  // Divider
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  dividerLabeled: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerLabel: { fontSize: 12 },
  // KeyValue
  kvList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden', marginBottom: 4 },
  kvRow: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 7 },
  kvKey: { flex: 1, fontSize: 13 },
  kvVal: { flex: 2, fontSize: 13, fontWeight: '500' },
  // List
  listContainer: { marginBottom: 4 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 },
  listBullet: { marginRight: 6, fontWeight: '700', lineHeight: 20 },
  listText: { flex: 1, fontSize: 14, lineHeight: 20 },
  // Table
  table: { borderWidth: 1, borderRadius: 8, overflow: 'hidden', marginBottom: 4 },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tableHead: { borderBottomWidth: 1 },
  tableCell: { minWidth: 80, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, borderRightWidth: StyleSheet.hairlineWidth },
  tableCellHead: { fontWeight: '600' },
  // Progress
  progressWrap: { marginBottom: 8 },
  progressLabel: { fontSize: 13, marginBottom: 4 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  progressValue: { fontSize: 11, marginTop: 2, textAlign: 'right' },
  // Code
  codeBlock: { padding: 10, borderRadius: 8, marginBottom: 4 },
  codeLang: { fontSize: 10, fontWeight: '600', marginBottom: 4 },
  codeText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18 },
  // Media / form / navigation controls
  mediaWrap: { marginBottom: 8 },
  image: { width: '100%', borderRadius: 10, backgroundColor: 'transparent' },
  svgWrap: { width: '100%', borderRadius: 10, overflow: 'hidden', marginBottom: 8 },
  caption: { fontSize: 12, marginTop: 4 },
  inputWrap: { marginBottom: 8, gap: 6 },
  inputLabel: { fontSize: 12, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  segmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  segmentText: { fontSize: 13, fontWeight: '600' },
  tabs: { gap: 8, marginBottom: 8 },
  tabBar: { gap: 6, paddingBottom: 2 },
  tabBtn: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  tabText: { fontSize: 13, fontWeight: '600' },
  carousel: { gap: 8, marginBottom: 8 },
  carouselNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  navBtn: { width: 32, height: 28, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  mediaCard: { borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 8 },
  playlistItem: { paddingVertical: 8 },
});

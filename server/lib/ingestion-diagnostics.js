const KNOWN_SOURCE_TYPES = new Set(['file', 'url', 'note', 'pasted', 'github', 'folder', 'conversation', 'transcript']);

export function detectIngestionFormat(input = {}) {
  const sourceType = String(input.sourceType || '').trim().toLowerCase();
  const text = typeof input.text === 'string' ? input.text : '';
  if (input.formatVersion) return { format: String(input.formatVersion), confidence: 'explicit' };
  if (sourceType && KNOWN_SOURCE_TYPES.has(sourceType)) return { format: sourceType, confidence: 'sourceType' };
  if (/^\s*[{[]/.test(text)) return { format: 'json-like-text', confidence: 'heuristic' };
  if (/^\s*---\s*\n/.test(text)) return { format: 'markdown-frontmatter', confidence: 'heuristic' };
  if (text.trim()) return { format: 'plain-text', confidence: 'fallback' };
  return { format: 'empty', confidence: 'fallback' };
}

export function buildIngestionDiagnostics(input = {}, result = {}) {
  const detected = detectIngestionFormat(input);
  const warnings = [];
  const text = typeof input.text === 'string' ? input.text : '';
  const sourceType = input.sourceType || null;
  const sourceId = input.sourceId || input.sourcePath || null;

  if (sourceType && !KNOWN_SOURCE_TYPES.has(String(sourceType).toLowerCase())) {
    warnings.push(`unknown sourceType "${sourceType}"`);
  }
  if (!text.trim()) {
    warnings.push('empty input text');
  }
  if (result.ok && Number(result.added || 0) === 0) {
    warnings.push('ingestion succeeded with zero chunks');
  }
  if (!result.ok && /text is required|empty after chunking/i.test(result.error || '')) {
    warnings.push('empty extraction; check upstream parser or source format');
  }

  return {
    status: result.ok ? (warnings.length ? 'ok-with-warnings' : 'ok') : 'failed',
    sourceFormat: detected.format,
    confidence: detected.confidence,
    sourceType,
    sourceId,
    warnings,
  };
}

export function appendIngestionDiagnostics(result, input = {}) {
  return {
    ...result,
    diagnostics: buildIngestionDiagnostics(input, result),
  };
}

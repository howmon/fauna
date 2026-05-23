// Internal AI caller used by heartbeat, workflows, Teams bridge, etc.
// Falls back across models when the requested one returns a 400 (unsupported).

export function createInternalAICaller({ getCopilotClient, getActiveModel }) {
  // Lightweight per-caller telemetry — accumulated since process start.
  // Surfaced via the returned `getTelemetry()` so health endpoints / status
  // panels can detect a misbehaving downstream (e.g. all calls failing or
  // every request falling back).
  const telemetry = {
    calls: 0,
    fallbacks: 0,
    errors: 0,
    totalMs: 0,
    lastError: null,
    lastErrorAt: null,
    lastCallAt: null,
    byModel: Object.create(null),
  };
  function _record(model, ms, ok, err) {
    telemetry.calls++;
    telemetry.totalMs += ms;
    telemetry.lastCallAt = Date.now();
    const bm = telemetry.byModel[model] || (telemetry.byModel[model] = { calls: 0, errors: 0, totalMs: 0 });
    bm.calls++;
    bm.totalMs += ms;
    if (!ok) {
      telemetry.errors++;
      bm.errors++;
      telemetry.lastError = err?.message || String(err || 'unknown');
      telemetry.lastErrorAt = Date.now();
    }
  }

  const internalAICaller = async function internalAICaller(prompt, model) {
    const activeModel = getActiveModel?.() || 'gpt-4.1';
    const useModel = model || activeModel;
    const client = getCopilotClient();
    const callModel = async (m) => {
      const start = Date.now();
      try {
        const resp = await client.chat.completions.create({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
        });
        _record(m, Date.now() - start, true, null);
        return resp.choices[0]?.message?.content?.trim() || '';
      } catch (err) {
        _record(m, Date.now() - start, false, err);
        throw err;
      }
    };
    try {
      return await callModel(useModel);
    } catch (e) {
      if (e.status === 400 && useModel !== activeModel && activeModel) {
        console.log(`[ai-caller] model "${useModel}" not supported, falling back to "${activeModel}"`);
        telemetry.fallbacks++;
        return await callModel(activeModel);
      }
      if (e.status === 400 && useModel !== 'gpt-4.1') {
        console.log(`[ai-caller] model "${useModel}" not supported, falling back to "gpt-4.1"`);
        telemetry.fallbacks++;
        return await callModel('gpt-4.1');
      }
      throw e;
    }
  };
  internalAICaller.getTelemetry = () => ({
    ...telemetry,
    avgMs: telemetry.calls ? Math.round(telemetry.totalMs / telemetry.calls) : 0,
    byModel: Object.fromEntries(
      Object.entries(telemetry.byModel).map(([k, v]) => [k, {
        ...v,
        avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0,
      }])
    ),
  });
  return internalAICaller;
}

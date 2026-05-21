// Internal AI caller used by heartbeat, workflows, Teams bridge, etc.
// Falls back across models when the requested one returns a 400 (unsupported).

export function createInternalAICaller({ getCopilotClient, getActiveModel }) {
  return async function internalAICaller(prompt, model) {
    const activeModel = getActiveModel?.() || 'gpt-4.1';
    const useModel = model || activeModel;
    const client = getCopilotClient();
    const callModel = async (m) => {
      const resp = await client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      });
      return resp.choices[0]?.message?.content?.trim() || '';
    };
    try {
      return await callModel(useModel);
    } catch (e) {
      if (e.status === 400 && useModel !== activeModel && activeModel) {
        console.log(`[ai-caller] model "${useModel}" not supported, falling back to "${activeModel}"`);
        return await callModel(activeModel);
      }
      if (e.status === 400 && useModel !== 'gpt-4.1') {
        console.log(`[ai-caller] model "${useModel}" not supported, falling back to "gpt-4.1"`);
        return await callModel('gpt-4.1');
      }
      throw e;
    }
  };
}

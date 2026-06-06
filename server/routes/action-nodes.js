// ── Action-node routes — connector catalog for the pipeline builder ────────
//
// Exposes the action-node registry's descriptors (label, icon, color,
// credential type, and config field metadata) so the UI can render the node
// palette and per-node config forms without hardcoding each connector.

import { listActionNodeDescriptors } from '../lib/action-nodes.js';

export function registerActionNodeRoutes(app) {
  app.get('/api/action-nodes', (_req, res) => {
    res.json({ nodes: listActionNodeDescriptors() });
  });
}

function permissionValue(projectPermissions, agentPermissions, key, fallback = true) {
  if (projectPermissions && projectPermissions[key] !== undefined) return projectPermissions[key];
  if (agentPermissions && agentPermissions[key] !== undefined) return agentPermissions[key];
  return fallback;
}

function capability(enabled, reason = null, detail = null) {
  return { enabled: !!enabled, reason: enabled ? null : reason, detail };
}

export function projectCapabilities({
  model = {},
  projectPermissions = {},
  agentPermissions = {},
  requested = {},
  runtime = {},
  tools = [],
} = {}) {
  const toolsEnabled = model.tools !== false && requested.noTools !== true;
  const shellPermission = permissionValue(projectPermissions, agentPermissions, 'shell');
  const browserPermission = permissionValue(projectPermissions, agentPermissions, 'browser', false);
  const figmaPermission = permissionValue(projectPermissions, agentPermissions, 'figma', false);
  const readPermission = permissionValue(projectPermissions, agentPermissions, 'fileRead', []);
  const writePermission = permissionValue(projectPermissions, agentPermissions, 'fileWrite', []);
  const toolNames = [...new Set((tools || []).map(tool => tool?.function?.name || tool?.name).filter(Boolean))].sort();

  const capabilities = {
    streaming: capability(model.streaming !== false, 'model-does-not-support-streaming'),
    tools: capability(toolsEnabled, model.tools === false ? 'model-does-not-support-tools' : 'disabled-for-run'),
    shell: capability(toolsEnabled && shellPermission !== false, !toolsEnabled ? 'tools-disabled' : 'permission-denied'),
    browser: capability(toolsEnabled && requested.browser === true && browserPermission !== false && runtime.browser !== false,
      !toolsEnabled ? 'tools-disabled' : requested.browser !== true ? 'not-requested' : browserPermission === false ? 'permission-denied' : 'runtime-unavailable'),
    figma: capability(toolsEnabled && requested.figma === true && figmaPermission !== false && runtime.figma !== false,
      !toolsEnabled ? 'tools-disabled' : requested.figma !== true ? 'not-requested' : figmaPermission === false ? 'permission-denied' : 'runtime-unavailable'),
    fileRead: capability(toolsEnabled && (readPermission === null || readPermission === true || (Array.isArray(readPermission) && readPermission.length > 0)),
      !toolsEnabled ? 'tools-disabled' : 'no-readable-paths'),
    fileWrite: capability(toolsEnabled && (writePermission === null || writePermission === true || (Array.isArray(writePermission) && writePermission.length > 0)),
      !toolsEnabled ? 'tools-disabled' : 'no-writable-paths'),
    mcp: capability(toolsEnabled && requested.mcp !== false && runtime.mcp !== false,
      !toolsEnabled ? 'tools-disabled' : requested.mcp === false ? 'not-requested' : 'runtime-unavailable'),
  };

  return Object.freeze({
    version: 1,
    projectedAt: Date.now(),
    capabilities,
    toolNames,
    toolCount: toolNames.length,
  });
}

const UI_TEXT = /\b(?:ui|ux|frontend|front-end|web\s*app|website|web\s*page|dashboard|sidebar|modal|carousel|kanban|renderer|html|css|jsx|tsx|svelte|storybook|button|dropdown|dialog|layout|navigation|form)\b/i;

export function isUiChange(text = '', files = []) {
  const documentationOnly = /\b(?:documentation|readme|docs)\b/i.test(text)
    && !/\b(?:implement|refactor|frontend|front-end)\b/i.test(text);
  return (!documentationOnly && UI_TEXT.test(text)) || files.some(file => {
    const name = typeof file === 'string' ? file : file?.path || '';
    if (/\.(?:md|txt|rst|adoc|test\.[cm]?[jt]s|spec\.[cm]?[jt]s)$/i.test(name)) return false;
    return /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i.test(name)
      || /(?:^|[/\\])(?:public|renderer|components|pages|views)[/\\].*\.[cm]?[jt]s$/i.test(name);
  });
}

// Only the native journey executor can produce this evidence. Screenshots,
// arbitrary evaluate results, and the model's completion prose are not checks.
export function passedBrowserVerification(result) {
  return result?.ok === true && result?.kind === 'browser-journey'
    && result?.source === 'internal' && typeof result.url === 'string'
    && /^(?:https?:\/\/|file:\/\/)/i.test(result.url)
    && result.navigated === true && result.consoleChecked === true
    && Array.isArray(result.consoleErrors) && result.consoleErrors.length === 0
    && Array.isArray(result.steps) && result.steps.some(s => s.ok === true && /^(?:click|type)$/.test(s.action))
    && result.steps.every(s => s.ok === true)
    && Array.isArray(result.checks) && result.checks.length > 0
    && result.checks.every(c => c.ok === true && c.selector
      && /^(?:count|text|value|visible)$/.test(c.property)
      && Object.hasOwn(c, 'actual') && Object.hasOwn(c, 'expected') && c.actual === c.expected);
}

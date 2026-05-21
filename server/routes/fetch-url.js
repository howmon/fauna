// /api/fetch-url — server-side URL content fetcher with SSRF guard.
//
// Used by the chat UI / agents to pull readable text or JSON from an
// external URL. Blocks loopback, link-local and private (RFC1918) ranges
// and enforces http(s) only.

import { validateExternalUrl } from '../lib/url-validate.js';

export function registerFetchUrlRoutes(app) {
  app.post('/api/fetch-url', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
      const safeUrl = validateExternalUrl(url);
      const response = await fetch(safeUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
        signal:  AbortSignal.timeout(12000),
        redirect: 'follow',
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let content, title = url;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        content = JSON.stringify(json, null, 2);
        title   = `JSON from ${new URL(url).hostname}`;
      } else {
        const html = await response.text();
        // Extract title
        title   = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || url).trim().replace(/[<>"'`]/g, '');
        // Strip scripts, styles, nav, footer then HTML tags
        content = html
          .replace(/<script[\s\S]*?<\/script>/gi,   '')
          .replace(/<style[\s\S]*?<\/style>/gi,      '')
          .replace(/<nav[\s\S]*?<\/nav>/gi,          '')
          .replace(/<footer[\s\S]*?<\/footer>/gi,    '')
          .replace(/<header[\s\S]*?<\/header>/gi,    '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 20000);
      }

      res.json({ url, title, content, chars: content.length });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

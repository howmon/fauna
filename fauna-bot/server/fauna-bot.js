/**
 * Fauna Teams Bot — ActivityHandler
 *
 * Routes all incoming Teams activities to the right handler:
 *  - Slash commands  → commands.js dispatcher
 *  - Freeform text   → relay.chat() → AI response card
 *  - File attachments → pass content to AI as context
 *  - Installs        → welcome card
 *
 * Typing indicators are sent before any async Fauna call so the
 * user sees feedback immediately.
 */

import { ActivityHandler, MessageFactory, CardFactory } from 'botbuilder';
import { handleCommand }  from './commands.js';
import { relay }          from './relay.js';
import {
  helpCard, responseCard, errorCard, disconnectedCard,
} from './cards.js';

export class FaunaBot extends ActivityHandler {
  constructor() {
    super();

    // ── Member added (bot installed) ────────────────────────────────────
    this.onMembersAdded(async (ctx, next) => {
      for (const member of ctx.activity.membersAdded ?? []) {
        if (member.id !== ctx.activity.recipient.id) continue;
        await ctx.sendActivity(
          MessageFactory.attachment(CardFactory.adaptiveCard(helpCard().content))
        );
      }
      await next();
    });

    // ── Incoming message ─────────────────────────────────────────────────
    this.onMessage(async (ctx, next) => {
      const raw  = (ctx.activity.text || '').replace(/<at>[^<]+<\/at>/gi, '').trim();
      const text = raw;

      if (!text && !ctx.activity.attachments?.length) {
        await next();
        return;
      }

      // Send typing indicator immediately
      await ctx.sendActivity({ type: 'typing' });

      try {
        // ── Slash command ──────────────────────────────────────────────
        const cmdResult = await handleCommand(text);
        if (cmdResult) {
          await _replyCard(ctx, cmdResult.card);
          await next();
          return;
        }

        // ── File attachment — extract text content and prepend to message
        let messageText = text;
        if (ctx.activity.attachments?.length) {
          const fileTexts = await _extractAttachments(ctx.activity.attachments);
          if (fileTexts) messageText = `${fileTexts}\n\n${text}`.trim();
        }

        // ── Freeform AI chat ───────────────────────────────────────────
        if (!relay.isConnected) {
          await _replyCard(ctx, disconnectedCard());
          await next();
          return;
        }

        const model  = '';   // use whatever is active on the desktop
        const aiText = await relay.chat(messageText || 'Hello', model);
        await _replyCard(ctx, responseCard(aiText, { model }));

      } catch (err) {
        console.error('[fauna-bot] message handler error:', err.message);
        await _replyCard(ctx, errorCard(`Something went wrong: ${err.message}`));
      }

      await next();
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _replyCard(ctx, cardAttachment) {
  const msg = MessageFactory.attachment(
    CardFactory.adaptiveCard(cardAttachment.content)
  );
  await ctx.sendActivity(msg);
}

async function _extractAttachments(attachments) {
  const texts = [];

  for (const att of attachments) {
    try {
      if (att.contentType === 'text/plain' && att.contentUrl) {
        const res = await fetch(att.contentUrl);
        if (res.ok) texts.push(await res.text());
      } else if (att.contentType?.startsWith('application/json') && att.content) {
        texts.push(JSON.stringify(att.content, null, 2));
      }
    } catch (e) {
      console.warn('[fauna-bot] Could not read attachment:', e.message);
    }
  }

  return texts.join('\n---\n');
}

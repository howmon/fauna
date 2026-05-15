/**
 * Gateway activity handler.
 *
 * This runs behind the PHP edge gateway at bot.pointlabel.com. The gateway owns
 * Microsoft Bot Framework authentication and sends activities here with an HMAC
 * signature. This module returns Bot Framework activities for the gateway to
 * deliver back to Teams, so the local Fauna app never needs the Microsoft app
 * password.
 */

import { handleCommand } from './commands.js';
import { relay } from './relay.js';
import {
  helpCard, responseCard, errorCard, disconnectedCard,
} from './cards.js';

export async function handleGatewayActivity(activity) {
  if (activity.type === 'conversationUpdate' || activity.type === 'installationUpdate') {
    return { activities: [_cardActivity(helpCard())] };
  }

  if (activity.type !== 'message') {
    return { activities: [] };
  }

  const raw = (activity.text || '').replace(/<at>[^<]+<\/at>/gi, '').trim();
  if (!raw && !activity.attachments?.length) return { activities: [] };

  try {
    const cmdResult = await handleCommand(raw);
    if (cmdResult) return { activities: [_cardActivity(cmdResult.card)] };

    if (!relay.isConnected) {
      return { activities: [_cardActivity(disconnectedCard())] };
    }

    const model = '';
    const aiText = await relay.chat(raw || 'Hello', model);
    return { activities: [_cardActivity(responseCard(aiText, { model }))] };
  } catch (err) {
    console.error('[gateway-handler] message error:', err.message);
    return { activities: [_cardActivity(errorCard(`Something went wrong: ${err.message}`))] };
  }
}

function _cardActivity(cardAttachment) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: cardAttachment.content,
      },
    ],
  };
}
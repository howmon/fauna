/**
 * Fauna Teams Bot — Command Parser & Dispatcher
 *
 * Slash commands are parsed from incoming Teams messages.
 * Each command calls the appropriate relay method and returns
 * an Adaptive Card attachment or a plain text string.
 */

import { relay }            from './relay.js';
import QRCode               from 'qrcode';
import {
  helpCard, statusCard, shellCard, agentListCard, taskCard,
  screenshotCard, modelsCard, playbookCard, pairCard, errorCard,
  responseCard, disconnectedCard,
} from './cards.js';

const BOT_DOMAIN = process.env.BOT_DOMAIN || 'localhost:3000';

// ── Command registry ────────────────────────────────────────────────────────

const COMMANDS = {
  help:       cmdHelp,
  status:     cmdStatus,
  shell:      cmdShell,
  browse:     cmdBrowse,
  screenshot: cmdScreenshot,
  agents:     cmdAgents,
  task:       cmdTask,
  search:     cmdSearch,
  models:     cmdModels,
  playbook:   cmdPlaybook,
  pair:       cmdPair,
};

/**
 * Parse a message text and, if it starts with `/cmd`, dispatch to handler.
 * Returns { card } for Adaptive Card responses or { text } for plain text,
 * or null if the message is not a slash command.
 */
export async function handleCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const [rawCmd, ...argParts] = trimmed.slice(1).split(/\s+/);
  const cmd  = rawCmd.toLowerCase();
  const args = argParts.join(' ');

  const handler = COMMANDS[cmd];
  if (!handler) {
    return { card: errorCard(`Unknown command: \`/${cmd}\`. Type \`/help\` to see available commands.`) };
  }

  try {
    return await handler(args);
  } catch (err) {
    console.error(`[commands] /${cmd} error:`, err.message);
    return { card: errorCard(`Command failed: ${err.message}`) };
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function cmdHelp() {
  return { card: helpCard() };
}

async function cmdStatus() {
  const s = await relay.status();
  return { card: statusCard(s) };
}

async function cmdShell(command) {
  if (!command) return { card: errorCard('Usage: `/shell <command>`') };
  if (!relay.isConnected) return { card: disconnectedCard() };

  const { output, exitCode } = await relay.shell(command);
  return { card: shellCard(command, output, exitCode) };
}

async function cmdBrowse(url) {
  if (!url) return { card: errorCard('Usage: `/browse <url>`') };
  if (!relay.isConnected) return { card: disconnectedCard() };

  const content = await relay.browse(url.startsWith('http') ? url : `https://${url}`);
  const preview = content ? content.slice(0, 1500) : '(no content returned)';
  return { card: responseCard(preview, { title: `🌐 ${url}` }) };
}

async function cmdScreenshot() {
  if (!relay.isConnected) return { card: disconnectedCard() };
  const dataUrl = await relay.screenshot();
  return { card: screenshotCard(dataUrl) };
}

async function cmdAgents() {
  if (!relay.isConnected) return { card: disconnectedCard() };
  const agents = await relay.listAgents();
  return { card: agentListCard(agents) };
}

async function cmdTask(description) {
  if (!description) return { card: errorCard('Usage: `/task <description>`') };
  if (!relay.isConnected) return { card: disconnectedCard() };

  const task = await relay.createTask(description);
  return { card: taskCard(task) };
}

async function cmdSearch(query) {
  if (!query) return { card: errorCard('Usage: `/search <query>`') };
  if (!relay.isConnected) return { card: disconnectedCard() };

  // Delegate to Fauna AI with a web-search instruction
  const text = await relay.chat(`Search the web for: ${query}`);
  return { card: responseCard(text, { title: `🔍 ${query}` }) };
}

async function cmdModels() {
  if (!relay.isConnected) return { card: disconnectedCard() };
  const models = await relay.listModels();
  return { card: modelsCard(models) };
}

async function cmdPlaybook() {
  if (!relay.isConnected) return { card: disconnectedCard() };
  const instructions = await relay.getPlaybook();
  return { card: playbookCard(instructions) };
}

async function cmdPair() {
  const pairingUrl = `https://${BOT_DOMAIN}/pair`;
  let qrDataUrl = null;

  try {
    qrDataUrl = await QRCode.toDataURL(pairingUrl, { width: 256 });
  } catch (err) {
    console.error('[commands] QR generation failed:', err.message);
  }

  return { card: pairCard(qrDataUrl, pairingUrl) };
}

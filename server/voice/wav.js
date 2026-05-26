// ── Minimal WAV (RIFF) header for PCM16 mono ────────────────────────────
// Whisper.cpp accepts a WAV file at 16 kHz mono int16 with no further
// processing. We already capture in that format, so this is the cheapest
// possible encode step.

import fs from 'fs';

const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS    = 1;

/**
 * Build a 44-byte WAV header for the given PCM16 mono payload.
 * @param {number} pcmByteLength  length of the raw PCM payload (bytes)
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function buildWavHeader(pcmByteLength, sampleRate) {
  const byteRate   = sampleRate * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcmByteLength, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);                  // PCM chunk size
  hdr.writeUInt16LE(1, 20);                   // audio format = PCM
  hdr.writeUInt16LE(NUM_CHANNELS, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28);
  hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(BITS_PER_SAMPLE, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcmByteLength, 40);
  return hdr;
}

/** Write a PCM16 mono buffer to disk as a valid .wav file. */
export function writePcmAsWav(filePath, pcm, sampleRate) {
  const header = buildWavHeader(pcm.length, sampleRate);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

import sharp from 'sharp';

const DEFAULT_SIZE = 256;

export async function compareImages(reference, actual, options = {}) {
  const size = Math.max(32, Math.min(1024, Number(options.size) || DEFAULT_SIZE));
  const pixelThreshold = Math.max(0, Math.min(1, Number(options.pixelThreshold) || 0.1));
  const normalize = input => sharp(input)
    .flatten({ background: '#ffffff' })
    .resize(size, size, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  const [referencePixels, actualPixels] = await Promise.all([
    normalize(reference),
    normalize(actual),
  ]);

  let absoluteDifference = 0;
  let changedPixels = 0;
  const channels = 3;
  const pixelCount = size * size;
  for (let offset = 0; offset < referencePixels.length; offset += channels) {
    let pixelDifference = 0;
    for (let channel = 0; channel < channels; channel++) {
      pixelDifference += Math.abs(referencePixels[offset + channel] - actualPixels[offset + channel]);
    }
    absoluteDifference += pixelDifference;
    if (pixelDifference / (channels * 255) > pixelThreshold) changedPixels++;
  }

  const meanAbsoluteError = absoluteDifference / (referencePixels.length * 255);
  return {
    similarity: Number((1 - meanAbsoluteError).toFixed(6)),
    meanAbsoluteError: Number(meanAbsoluteError.toFixed(6)),
    changedPixelRatio: Number((changedPixels / pixelCount).toFixed(6)),
    width: size,
    height: size,
  };
}

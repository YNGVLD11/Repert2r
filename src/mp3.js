import { Mp3Encoder } from '@breezystack/lamejs';

const SUPPORTED_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

function toInt16(float32) {
  const result = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return result;
}

async function resample(buffer, targetRate) {
  const context = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.ceil(buffer.duration * targetRate),
    targetRate,
  );
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return context.startRendering();
}

export async function encodeMp3(audioBuffer, onProgress) {
  const buffer = SUPPORTED_RATES.has(audioBuffer.sampleRate)
    ? audioBuffer
    : await resample(audioBuffer, 44100);

  const channels = Math.min(buffer.numberOfChannels, 2);
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, 192);
  const chunks = [];
  const blockSize = 1152;

  const left = toInt16(buffer.getChannelData(0));
  const right = channels > 1 ? toInt16(buffer.getChannelData(1)) : null;

  let blockCount = 0;
  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    const rightChunk = right ? right.subarray(i, i + blockSize) : null;
    const encoded = channels > 1
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk);
    if (encoded.length) chunks.push(new Uint8Array(encoded));

    blockCount += 1;
    if (blockCount % 64 === 0) {
      if (onProgress) onProgress(Math.min(1, i / left.length));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  if (onProgress) onProgress(1);

  return new Blob(chunks, { type: 'audio/mpeg' });
}

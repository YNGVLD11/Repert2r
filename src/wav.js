function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export async function encodeWav(audioBuffer, onProgress) {
  const channelCount = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const blockAlign = channelCount * 2;
  const dataSize = frames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(audioBuffer.getChannelData(channel));
  }

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    if (i > 0 && i % 262144 === 0) {
      if (onProgress) onProgress(Math.min(1, i / frames));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(1);
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

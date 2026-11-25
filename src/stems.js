import { invoke } from '@tauri-apps/api/core';

export async function resampleTo44100Stereo(audioBuffer) {
  if (audioBuffer.sampleRate === 44100 && audioBuffer.numberOfChannels === 2) {
    return audioBuffer;
  }
  const targetLen = Math.ceil(audioBuffer.duration * 44100);
  const offline = new OfflineAudioContext(2, targetLen, 44100);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

export function packStereoPlanar(buffer) {
  const len = buffer.length;
  const packed = new Float32Array(len * 2);
  packed.set(buffer.getChannelData(0), 0);
  packed.set(buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0), len);
  return new Uint8Array(packed.buffer);
}

export function unpackStereoPlanar(context, rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
  const floats = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  const len = floats.length / 2;
  const out = context.createBuffer(2, len, 44100);
  out.getChannelData(0).set(floats.subarray(0, len));
  out.getChannelData(1).set(floats.subarray(len, len * 2));
  return out;
}

export async function runStemSeparation(audioBuffer, context) {
  const prepared = await resampleTo44100Stereo(audioBuffer);
  const payload = packStereoPlanar(prepared);
  await invoke('separate_track', payload);

  const [vocalsRaw, instRaw] = await Promise.all([
    invoke('get_stem', { kind: 'vocals' }),
    invoke('get_stem', { kind: 'instrumental' }),
  ]);

  return {
    vocalsBuffer: unpackStereoPlanar(context, vocalsRaw),
    instBuffer: unpackStereoPlanar(context, instRaw),
  };
}

export function mixStemsBuffer(context, stems, vocalsLevel, instLevel) {
  const len = stems.vocalsBuffer.length;
  const out = context.createBuffer(2, len, stems.vocalsBuffer.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const v = stems.vocalsBuffer.getChannelData(ch);
    const inst = stems.instBuffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < len; i += 1) {
      dst[i] = v[i] * vocalsLevel + inst[i] * instLevel;
    }
  }
  return out;
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

self.onmessage = (event) => {
  const { samples, sampleRate } = event.data;
  try {
    const key = detectKey(samples, sampleRate);
    const bpm = detectBpm(samples, sampleRate);
    self.postMessage({ ...key, bpm });
  } catch {
    self.postMessage({ noteIndex: 0, mode: 'major', confidence: 0, bpm: 120 });
  }
};

function fft(real, imag) {
  const n = real.length;

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = real[i];
      real[i] = real[j];
      real[j] = t;
      t = imag[i];
      imag[i] = imag[j];
      imag[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;

      for (let j = 0; j < half; j += 1) {
        const a = i + j;
        const b = a + half;
        const vr = real[b] * wr - imag[b] * wi;
        const vi = real[b] * wi + imag[b] * wr;

        real[b] = real[a] - vr;
        imag[b] = imag[a] - vi;
        real[a] += vr;
        imag[a] += vi;

        const nextWr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nextWr;
      }
    }
  }
}

function detectKey(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const rate = sampleRate / factor;
  const length = Math.floor(samples.length / factor);
  const mono = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    const from = i * factor;
    for (let j = 0; j < factor; j += 1) sum += samples[from + j] || 0;
    mono[i] = sum / factor;
  }

  const size = 4096;
  const hop = 2048;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }

  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  const chroma = new Float32Array(12);
  const minBin = Math.max(2, Math.floor((55 * size) / rate));
  const maxBin = Math.min(size / 2 - 2, Math.floor((5000 * size) / rate));
  const magnitudes = new Float32Array(maxBin + 2);

  for (let offset = 0; offset + size <= length; offset += hop) {
    for (let i = 0; i < size; i += 1) {
      real[i] = mono[offset + i] * window[i];
      imag[i] = 0;
    }

    fft(real, imag);

    let frameMax = 0;
    for (let k = minBin; k <= maxBin; k += 1) {
      const magnitude = Math.hypot(real[k], imag[k]);
      magnitudes[k] = magnitude;
      if (magnitude > frameMax) frameMax = magnitude;
    }
    if (frameMax < 1e-7) continue;

    const threshold = frameMax * 0.02;

    for (let k = minBin; k <= maxBin; k += 1) {
      const magnitude = magnitudes[k];
      if (magnitude < threshold) continue;
      if (magnitude < magnitudes[k - 1] || magnitude < magnitudes[k + 1]) continue;

      const denominator = magnitudes[k - 1] - 2 * magnitude + magnitudes[k + 1];
      let shift = 0;
      if (denominator !== 0) {
        shift = (0.5 * (magnitudes[k - 1] - magnitudes[k + 1])) / denominator;
        shift = Math.max(-0.5, Math.min(0.5, shift));
      }

      const frequency = ((k + shift) * rate) / size;
      if (frequency < 55 || frequency > 5000) continue;

      for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
        const hz = frequency * harmonic;
        if (hz > 8000) break;
        const midi = 69 + 12 * Math.log2(hz / 440);
        const note = Math.round(midi);
        const cents = Math.abs(midi - note);
        if (cents > 0.45) continue;
        chroma[((note % 12) + 12) % 12] += magnitude * (1 / harmonic) * (1 - cents);
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < 12; i += 1) if (chroma[i] > peak) peak = chroma[i];
  if (peak <= 0) return { noteIndex: 0, mode: 'major', confidence: 0 };
  for (let i = 0; i < 12; i += 1) chroma[i] /= peak;

  let best = { noteIndex: 0, mode: 'major', confidence: -2 };

  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor']) {
      const profile = mode === 'major' ? MAJOR : MINOR;
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;

      for (let degree = 0; degree < 12; degree += 1) {
        const value = chroma[(tonic + degree) % 12];
        sx += value;
        sy += profile[degree];
        sxy += value * profile[degree];
        sxx += value * value;
        syy += profile[degree] * profile[degree];
      }

      const numerator = 12 * sxy - sx * sy;
      const denominator = Math.sqrt(12 * sxx - sx * sx) * Math.sqrt(12 * syy - sy * sy);
      const correlation = denominator > 0 ? numerator / denominator : 0;

      if (correlation > best.confidence) {
        best = { noteIndex: tonic, mode, confidence: correlation };
      }
    }
  }

  return best;
}

function detectBpm(samples, sampleRate) {
  const frameRate = 100;
  const frameSize = Math.max(1, Math.floor(sampleRate / frameRate));
  const maxFrames = Math.min(Math.floor(samples.length / frameSize), frameRate * 90);
  if (maxFrames < frameRate * 4) return 120;

  const energy = new Float32Array(maxFrames);
  for (let f = 0; f < maxFrames; f += 1) {
    let sum = 0;
    const start = f * frameSize;
    for (let i = 0; i < frameSize; i += 1) {
      const s = samples[start + i] || 0;
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / frameSize);
  }

  const flux = new Float32Array(maxFrames);
  for (let f = 1; f < maxFrames; f += 1) {
    const diff = energy[f] - energy[f - 1];
    flux[f] = diff > 0 ? diff : 0;
  }

  const minBpm = 70;
  const maxBpm = 175;
  let bestBpm = 120;
  let bestScore = -1;

  for (let bpm = minBpm; bpm <= maxBpm; bpm += 1) {
    const lag = Math.round((60 * frameRate) / bpm);
    let score = 0;
    for (let f = lag; f < maxFrames; f += 1) {
      score += flux[f] * flux[f - lag];
    }
    const weight = bpm >= 85 && bpm <= 155 ? 1.08 : 1.0;
    const weighted = score * weight;
    if (weighted > bestScore) {
      bestScore = weighted;
      bestBpm = bpm;
    }
  }

  return bestBpm;
}

export const EQ_BANDS = [
  { freq: 60, label: '60 Hz', type: 'lowshelf' },
  { freq: 230, label: '230 Hz', type: 'peaking' },
  { freq: 910, label: '910 Hz', type: 'peaking' },
  { freq: 3600, label: '3.6 kHz', type: 'peaking' },
  { freq: 14000, label: '14 kHz', type: 'highshelf' },
];

const MIN_DB = -12;
const MAX_DB = 12;

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 560;
const VIEW_H = 190;
const PAD_TOP = 34;
const PAD_BOTTOM = 34;
const TRACK_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
const BAND_XS = [64, 172, 280, 388, 496];

function dbToY(db) {
  const ratio = (MAX_DB - db) / (MAX_DB - MIN_DB);
  return PAD_TOP + ratio * TRACK_H;
}

function yToDb(y) {
  const clamped = Math.max(PAD_TOP, Math.min(VIEW_H - PAD_BOTTOM, y));
  const ratio = (clamped - PAD_TOP) / TRACK_H;
  const raw = MAX_DB - ratio * (MAX_DB - MIN_DB);
  return Math.round(raw * 10) / 10;
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function buildCurvePath(points) {
  let d = `M 0 ${points[0].y.toFixed(1)} L ${points[0].x} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx.toFixed(1)} ${p0.y.toFixed(1)}, ${cx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x} ${p1.y.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${VIEW_W} ${last.y.toFixed(1)}`;
  return d;
}

export function createEqNodes(audioContext, gains) {
  const filters = EQ_BANDS.map((band, index) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.freq;
    if (band.type === 'peaking') filter.Q.value = 1.0;
    filter.gain.value = gains[index] ?? 0;
    return filter;
  });

  for (let i = 0; i < filters.length - 1; i += 1) {
    filters[i].connect(filters[i + 1]);
  }

  return {
    input: filters[0],
    output: filters[filters.length - 1],
    filters,
  };
}

export async function applyEqToBuffer(audioBuffer, gains) {
  if (gains.every((g) => Math.abs(g) < 0.05)) return audioBuffer;

  const offline = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate,
  );
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  const eq = createEqNodes(offline, gains);
  src.connect(eq.input);
  eq.output.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

export function createEqController({ svg, canvas, resetButton, onChange }) {
  const gains = EQ_BANDS.map(() => 0);
  const ctx = canvas.getContext('2d');
  let activeBand = -1;
  let waveBins = null;

  const zeroY = dbToY(0);
  svg.appendChild(
    createSvgEl('line', {
      x1: 0,
      y1: zeroY,
      x2: VIEW_W,
      y2: zeroY,
      stroke: 'rgba(155, 140, 255, 0.16)',
      'stroke-width': 1,
    }),
  );

  for (let i = 0; i < EQ_BANDS.length; i += 1) {
    svg.appendChild(
      createSvgEl('line', {
        x1: BAND_XS[i],
        y1: PAD_TOP - 6,
        x2: BAND_XS[i],
        y2: VIEW_H - PAD_BOTTOM + 6,
        stroke: 'rgba(155, 140, 255, 0.1)',
        'stroke-width': 1,
      }),
    );
  }

  const curvePath = createSvgEl('path', {
    fill: 'none',
    stroke: '#a694ff',
    'stroke-width': 2.2,
    'stroke-linecap': 'round',
  });
  svg.appendChild(curvePath);

  const valueLabels = [];
  const handles = [];

  for (let i = 0; i < EQ_BANDS.length; i += 1) {
    const x = BAND_XS[i];

    const valText = createSvgEl('text', {
      x,
      y: 19,
      'text-anchor': 'middle',
      fill: '#9793b8',
      'font-size': 12.5,
      'font-family': 'inherit',
    });
    valText.textContent = '0.0';
    svg.appendChild(valText);
    valueLabels.push(valText);

    const freqText = createSvgEl('text', {
      x,
      y: VIEW_H - 10,
      'text-anchor': 'middle',
      fill: '#8985aa',
      'font-size': 12.5,
      'font-family': 'inherit',
    });
    freqText.textContent = EQ_BANDS[i].label;
    svg.appendChild(freqText);

    const circle = createSvgEl('circle', {
      cx: x,
      cy: zeroY,
      r: 6.5,
      fill: '#141126',
      stroke: '#a694ff',
      'stroke-width': 2.2,
    });
    svg.appendChild(circle);
    handles.push(circle);
  }

  function render() {
    const points = gains.map((db, i) => ({ x: BAND_XS[i], y: dbToY(db) }));
    curvePath.setAttribute('d', buildCurvePath(points));

    let isFlat = true;
    for (let i = 0; i < gains.length; i += 1) {
      const db = gains[i];
      if (Math.abs(db) >= 0.05) isFlat = false;
      handles[i].setAttribute('cy', points[i].y.toFixed(1));
      const formatted = db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
      valueLabels[i].textContent = formatted;
      valueLabels[i].setAttribute('fill', Math.abs(db) < 0.05 ? '#6c6c78' : '#c8c8d2');
    }

    resetButton.disabled = isFlat;
  }

  function pointerToSvg(event) {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_H;
    return { x, y };
  }

  function nearestBand(x) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < BAND_XS.length; i += 1) {
      const d = Math.abs(BAND_XS[i] - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function updateBandFromY(index, y) {
    const next = yToDb(y);
    if (next === gains[index]) return;
    gains[index] = next;
    render();
    onChange(index, next, gains);
  }

  svg.addEventListener('pointerdown', (event) => {
    const { x, y } = pointerToSvg(event);
    activeBand = nearestBand(x);
    svg.setPointerCapture(event.pointerId);
    updateBandFromY(activeBand, y);
  });

  svg.addEventListener('pointermove', (event) => {
    if (activeBand < 0) return;
    const { y } = pointerToSvg(event);
    updateBandFromY(activeBand, y);
  });

  const endDrag = (event) => {
    if (activeBand < 0) return;
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    activeBand = -1;
  };

  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('dblclick', (event) => {
    const { x } = pointerToSvg(event);
    const idx = nearestBand(x);
    gains[idx] = 0;
    render();
    onChange(idx, 0, gains);
  });

  resetButton.addEventListener('click', () => {
    for (let i = 0; i < gains.length; i += 1) {
      gains[i] = 0;
      onChange(i, 0, gains);
    }
    render();
  });

  function drawWave(analyser, isPlaying) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pointsCount = 36;
    if (!waveBins || waveBins.length !== pointsCount) {
      waveBins = new Float32Array(pointsCount);
    }

    if (analyser && isPlaying) {
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freqData);
      const usableBins = Math.floor(freqData.length * 0.72);
      for (let i = 0; i < pointsCount; i += 1) {
        const start = Math.floor((i / pointsCount) * usableBins);
        const end = Math.max(start + 1, Math.floor(((i + 1) / pointsCount) * usableBins));
        let sum = 0;
        for (let b = start; b < end; b += 1) sum += freqData[b];
        const target = sum / ((end - start) * 255);
        waveBins[i] += (target - waveBins[i]) * 0.35;
      }
    } else {
      let any = false;
      for (let i = 0; i < pointsCount; i += 1) {
        waveBins[i] *= 0.85;
        if (waveBins[i] > 0.002) any = true;
      }
      if (!any) return;
    }

    const baseY = height * 0.82;
    const maxAmp = height * 0.56;
    const stepX = width / (pointsCount - 1);

    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (let i = 0; i < pointsCount; i += 1) {
      const x = i * stepX;
      const y = baseY - waveBins[i] * maxAmp;
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = (i - 1) * stepX;
        const prevY = baseY - waveBins[i - 1] * maxAmp;
        const cx = (prevX + x) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
      }
    }
    ctx.lineTo(width, baseY);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, baseY - maxAmp, 0, baseY);
    grad.addColorStop(0, 'rgba(130, 82, 248, 0.34)');
    grad.addColorStop(1, 'rgba(72, 48, 175, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < pointsCount; i += 1) {
      const x = i * stepX;
      const y = baseY - waveBins[i] * maxAmp;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (i - 1) * stepX;
        const prevY = baseY - waveBins[i - 1] * maxAmp;
        const cx = (prevX + x) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
      }
    }
    ctx.strokeStyle = 'rgba(155, 125, 255, 0.42)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  render();

  return {
    getGains: () => gains,
    reset() {
      for (let i = 0; i < gains.length; i += 1) {
        gains[i] = 0;
        onChange(i, 0, gains);
      }
      render();
    },
    drawWave,
  };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_INTERVALS = new Set([0, 2, 4, 5, 7, 9, 11]);
const MINOR_INTERVALS = new Set([0, 2, 3, 5, 7, 8, 10]);

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_DEFS = [
  { semitone: 1, afterWhite: 0 },
  { semitone: 3, afterWhite: 1 },
  { semitone: 6, afterWhite: 3 },
  { semitone: 8, afterWhite: 4 },
  { semitone: 10, afterWhite: 5 },
];

const KEYBOARD_MAP = {
  KeyZ: 0,
  KeyS: 1,
  KeyX: 2,
  KeyD: 3,
  KeyC: 4,
  KeyV: 5,
  KeyG: 6,
  KeyB: 7,
  KeyH: 8,
  KeyN: 9,
  KeyJ: 10,
  KeyM: 11,
  KeyQ: 12,
  Digit2: 13,
  KeyW: 14,
  Digit3: 15,
  KeyE: 16,
  KeyR: 17,
  Digit5: 18,
  KeyT: 19,
  Digit6: 20,
  KeyY: 21,
  Digit7: 22,
  KeyU: 23,
};

const HINT_BY_OFFSET = Object.fromEntries(
  Object.entries(KEYBOARD_MAP).map(([code, offset]) => [
    offset,
    code.replace('Key', '').replace('Digit', ''),
  ]),
);

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createPianoController({
  keysEl,
  octaveLabel,
  octaveDownBtn,
  octaveUpBtn,
  scaleToggle,
  volumeRange,
  volumeLabel,
  getContext,
}) {
  let baseOctave = 3;
  let pianoVolume = 0.75;
  let highlightScale = true;
  let currentKey = null;
  let pianoGain = null;
  let pointerActive = false;
  let pointerMidi = null;

  const activeVoices = new Map();
  const keyElements = new Map();

  function ensurePianoGain() {
    const ctx = getContext();
    if (!ctx) return null;
    if (!pianoGain || pianoGain.context !== ctx) {
      pianoGain = ctx.createGain();
      pianoGain.gain.value = pianoVolume;
      pianoGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return { ctx, out: pianoGain };
  }

  function startNote(midi) {
    if (activeVoices.has(midi)) return;
    const audio = ensurePianoGain();
    if (!audio) return;
    const { ctx, out } = audio;

    const now = ctx.currentTime;
    const freq = midiToFreq(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(7200, freq * 8), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(900, freq * 2.5), now + 0.45);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.42, now + 0.012);
    env.gain.exponentialRampToValueAtTime(0.18, now + 0.35);

    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    const harmGain = ctx.createGain();
    harmGain.gain.setValueAtTime(0.22, now);

    osc1.connect(filter);
    osc2.connect(harmGain);
    harmGain.connect(filter);
    filter.connect(env);
    env.connect(out);

    osc1.start(now);
    osc2.start(now);

    activeVoices.set(midi, { osc1, osc2, env, ctx });
    const el = keyElements.get(midi);
    if (el) el.classList.add('pressed');
  }

  function stopNote(midi) {
    const voice = activeVoices.get(midi);
    if (!voice) return;
    activeVoices.delete(midi);

    const { osc1, osc2, env, ctx } = voice;
    const now = ctx.currentTime;
    env.gain.cancelScheduledValues(now);
    env.gain.setValueAtTime(Math.max(0.0001, env.gain.value), now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc1.stop(now + 0.3);
    osc2.stop(now + 0.3);

    const el = keyElements.get(midi);
    if (el) el.classList.remove('pressed');
  }

  function stopAllNotes() {
    for (const midi of Array.from(activeVoices.keys())) {
      stopNote(midi);
    }
  }

  function isNoteInScale(noteIndex) {
    if (!highlightScale || !currentKey) return false;
    const diff = (((noteIndex - currentKey.noteIndex) % 12) + 12) % 12;
    const set = currentKey.mode === 'minor' ? MINOR_INTERVALS : MAJOR_INTERVALS;
    return set.has(diff);
  }

  function updateScaleHighlights() {
    for (const [midi, el] of keyElements.entries()) {
      const noteIndex = midi % 12;
      const inScale = isNoteInScale(noteIndex);
      const isRoot = highlightScale && currentKey && noteIndex === currentKey.noteIndex;
      el.classList.toggle('in-scale', inScale);
      el.classList.toggle('is-root', Boolean(isRoot));
    }
  }

  function buildKeyboard() {
    stopAllNotes();
    keysEl.innerHTML = '';
    keyElements.clear();

    const totalWhites = 14;
    const whiteWidthPct = 100 / totalWhites;

    for (let oct = 0; oct < 2; oct += 1) {
      const octave = baseOctave + oct;
      WHITE_OFFSETS.forEach((semi, idx) => {
        const midi = (octave + 1) * 12 + semi;
        const offset = oct * 12 + semi;
        const key = document.createElement('div');
        key.className = 'piano-key white';
        key.dataset.midi = String(midi);

        const hint = document.createElement('span');
        hint.className = 'piano-hint';
        hint.textContent = HINT_BY_OFFSET[offset] || '';

        const note = document.createElement('span');
        note.className = 'piano-note';
        note.textContent = `${NOTE_NAMES[semi]}${octave}`;

        key.append(hint, note);
        keysEl.appendChild(key);
        keyElements.set(midi, key);
      });

      BLACK_DEFS.forEach(({ semitone, afterWhite }) => {
        const midi = (octave + 1) * 12 + semitone;
        const offset = oct * 12 + semitone;
        const whiteIndex = oct * 7 + afterWhite;
        const key = document.createElement('div');
        key.className = 'piano-key black';
        key.dataset.midi = String(midi);
        key.style.left = `${(whiteIndex + 1) * whiteWidthPct}%`;

        const hint = document.createElement('span');
        hint.className = 'piano-hint';
        hint.textContent = HINT_BY_OFFSET[offset] || '';

        key.appendChild(hint);
        keysEl.appendChild(key);
        keyElements.set(midi, key);
      });
    }

    octaveLabel.textContent = `C${baseOctave} – B${baseOctave + 1}`;
    octaveDownBtn.disabled = baseOctave <= 2;
    octaveUpBtn.disabled = baseOctave >= 5;
    updateScaleHighlights();
  }

  function midiFromEvent(event) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const keyEl = target?.closest?.('.piano-key');
    return keyEl ? Number(keyEl.dataset.midi) : null;
  }

  keysEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    pointerActive = true;
    keysEl.setPointerCapture(event.pointerId);
    const midi = midiFromEvent(event);
    if (midi !== null) {
      pointerMidi = midi;
      startNote(midi);
    }
  });

  keysEl.addEventListener('pointermove', (event) => {
    if (!pointerActive) return;
    const midi = midiFromEvent(event);
    if (midi === pointerMidi) return;
    if (pointerMidi !== null) stopNote(pointerMidi);
    pointerMidi = midi;
    if (midi !== null) startNote(midi);
  });

  const endPointer = (event) => {
    if (!pointerActive) return;
    pointerActive = false;
    if (pointerMidi !== null) {
      stopNote(pointerMidi);
      pointerMidi = null;
    }
    if (keysEl.hasPointerCapture(event.pointerId)) {
      keysEl.releasePointerCapture(event.pointerId);
    }
  };

  keysEl.addEventListener('pointerup', endPointer);
  keysEl.addEventListener('pointercancel', endPointer);

  octaveDownBtn.addEventListener('click', () => {
    if (baseOctave <= 2) return;
    baseOctave -= 1;
    buildKeyboard();
  });

  octaveUpBtn.addEventListener('click', () => {
    if (baseOctave >= 5) return;
    baseOctave += 1;
    buildKeyboard();
  });

  scaleToggle.addEventListener('change', () => {
    highlightScale = scaleToggle.checked;
    updateScaleHighlights();
  });

  volumeRange.addEventListener('input', () => {
    pianoVolume = Number(volumeRange.value) / 100;
    volumeLabel.textContent = `${Math.round(pianoVolume * 100)}%`;
    if (pianoGain && pianoGain.context) {
      pianoGain.gain.setTargetAtTime(pianoVolume, pianoGain.context.currentTime, 0.015);
    }
  });

  function handleKeyDown(event) {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
    const offset = KEYBOARD_MAP[event.code];
    if (offset === undefined) return false;
    const midi = (baseOctave + 1) * 12 + offset;
    startNote(midi);
    return true;
  }

  function handleKeyUp(event) {
    const offset = KEYBOARD_MAP[event.code];
    if (offset === undefined) return false;
    const midi = (baseOctave + 1) * 12 + offset;
    stopNote(midi);
    return true;
  }

  buildKeyboard();

  return {
    setSongKey(keyInfo) {
      currentKey = keyInfo;
      updateScaleHighlights();
    },
    handleKeyDown,
    handleKeyUp,
    stopAllNotes,
  };
}

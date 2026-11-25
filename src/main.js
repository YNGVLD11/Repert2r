import './style.css';
import { SoundTouchNode, processOffline } from '@soundtouchjs/audio-worklet';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { audioDir, join } from '@tauri-apps/api/path';
import { encodeWav } from './wav.js';
import { encodeMp3 } from './mp3.js';
import { applyEqToBuffer, createEqController, createEqNodes } from './eq.js';
import { createLibraryController } from './library.js';
import { mixStemsBuffer, runStemSeparation } from './stems.js';
import { createPianoController } from './piano.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_SEMITONES = -12;
const MAX_SEMITONES = 12;
const STRETCH_QUALITY = {
  sequenceMs: 40,
  seekWindowMs: 15,
  overlapMs: 12,
  quickSeek: false,
};
const processorUrl = new URL('soundtouch-processor.js', document.baseURI).href;

const stage = document.getElementById('stage');
const empty = document.getElementById('empty');
const trackInfo = document.getElementById('track-info');
const infoName = document.getElementById('info-name');
const infoKey = document.getElementById('info-key');
const infoBpm = document.getElementById('info-bpm');
const helpButton = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const confirmModal = document.getElementById('confirm-modal');
const confirmOk = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');
const propsModal = document.getElementById('props-modal');
const tunerRow = document.getElementById('tuner-row');
const tuner = document.getElementById('tuner');
const bpmDownButton = document.getElementById('bpm-down');
const bpmUpButton = document.getElementById('bpm-up');
const bpmValueLabel = document.getElementById('bpm-value');
const bpmResetButton = document.getElementById('bpm-reset');
const eqWrap = document.getElementById('eq-wrap');
const eqSvg = document.getElementById('eq-svg');
const eqWave = document.getElementById('eq-wave');
const eqResetButton = document.getElementById('eq-reset');
const player = document.getElementById('player');
const fileInput = document.getElementById('file');
const downButton = document.getElementById('down');
const upButton = document.getElementById('up');
const keyResetButton = document.getElementById('key-reset');
const semitonesLabel = document.getElementById('semitones');
const keyLabel = document.getElementById('key');
const playPauseButton = document.getElementById('playpause');
const openButton = document.getElementById('open');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const seekInput = document.getElementById('seek');
const currentLabel = document.getElementById('current');
const durationLabel = document.getElementById('duration');
const volumeInput = document.getElementById('volume');
const muteButton = document.getElementById('mute');
const volumeIcon = document.getElementById('volume-icon');
const muteIcon = document.getElementById('mute-icon');
const speedButton = document.getElementById('speed');
const speedMenu = document.getElementById('speed-menu');
const saveButton = document.getElementById('save');
const saveMenu = document.getElementById('save-menu');
const exportBox = document.getElementById('export-box');
const exportLabel = document.getElementById('export-label');
const exportFill = document.getElementById('export-fill');
const revealFolderLink = document.getElementById('reveal-folder');
const rightPanel = document.getElementById('right-panel');
const rightCollapse = document.getElementById('right-collapse');
const rightExpand = document.getElementById('right-expand');
const navStudio = document.getElementById('nav-studio');
const navMinus = document.getElementById('nav-minus');
const navPiano = document.getElementById('nav-piano');
const minusView = document.getElementById('minus-view');
const pianoView = document.getElementById('piano-view');
const separateButton = document.getElementById('separate-btn');
const sepIdle = document.getElementById('sep-idle');
const sepProgress = document.getElementById('sep-progress');
const sepLabel = document.getElementById('sep-label');
const sepFill = document.getElementById('sep-fill');
const stemsCard = document.getElementById('stems-card');
const vocalsRange = document.getElementById('vocals-range');
const vocalsVal = document.getElementById('vocals-val');
const instRange = document.getElementById('inst-range');
const instVal = document.getElementById('inst-val');
const stemMinusBtn = document.getElementById('stem-minus');
const stemResetBtn = document.getElementById('stem-reset');

let context;
let gain;
let analyser;
let eqNodes;
let soundTouch;
let registration;
let source;
let stems = null;
let vocalsSource = null;
let instSource = null;
let vocalsGain = null;
let instGain = null;
let vocalsLevel = 1;
let instLevel = 1;
let separating = false;
let centerMode = 'studio';

let audioBuffer = null;
let activeLibraryId = null;
let baseName = '';
let detectedKey = null;
let semitones = 0;
let originalBpm = 120;
let currentBpm = 120;
let listeningSpeed = 1;
let savedSinceEdit = true;

let isPlaying = false;
let isSeeking = false;
let startedAt = 0;
let pausedAt = 0;
let progressFrame = 0;
let saving = false;
let lastSavedPath = null;

let volume = 1;
let muted = false;
let lastVolume = 1;

const eq = createEqController({
  svg: eqSvg,
  canvas: eqWave,
  resetButton: eqResetButton,
  onChange: (index, value) => {
    savedSinceEdit = false;
    if (eqNodes && context) {
      eqNodes.filters[index].gain.setTargetAtTime(value, context.currentTime, 0.015);
    }
  },
});

const library = createLibraryController({
  sidebar: document.getElementById('sidebar'),
  expandButton: document.getElementById('lib-expand'),
  collapseButton: document.getElementById('lib-collapse'),
  addButton: document.getElementById('lib-add'),
  sortButton: document.getElementById('lib-sort-btn'),
  sortMenu: document.getElementById('lib-sort-menu'),
  searchInput: document.getElementById('lib-search'),
  listEl: document.getElementById('lib-list'),
  emptyEl: document.getElementById('lib-empty'),
  menuEl: document.getElementById('lib-menu'),
  propsModal,
  propsList: document.getElementById('props-list'),
  propsClose: document.getElementById('props-close'),
  importBox: document.getElementById('import-box'),
  importLabel: document.getElementById('import-label'),
  importFill: document.getElementById('import-fill'),
  onSelectTrack: (item) => openLibraryTrack(item),
  getActiveTrackInfo: (id) => {
    if (id !== activeLibraryId || !audioBuffer) return null;
    return {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    };
  },
});

const piano = createPianoController({
  keysEl: document.getElementById('piano-keys'),
  octaveLabel: document.getElementById('piano-oct-label'),
  octaveDownBtn: document.getElementById('piano-oct-down'),
  octaveUpBtn: document.getElementById('piano-oct-up'),
  scaleToggle: document.getElementById('piano-scale-toggle'),
  volumeRange: document.getElementById('piano-vol'),
  volumeLabel: document.getElementById('piano-vol-val'),
  getContext: () => {
    if (!context) context = new AudioContext();
    return context;
  },
});

const keyWorker = new Worker(new URL('./key-detection.worker.js', import.meta.url), { type: 'module' });
keyWorker.onmessage = (event) => {
  detectedKey = event.data;
  if (event.data.bpm) {
    originalBpm = event.data.bpm;
    currentBpm = event.data.bpm;
    updateBpmUI();
  }
  updateKeyLabel();
  if (activeLibraryId) {
    library.updateTrackMeta(activeLibraryId, {
      keyLabel: formatKey(),
      bpm: event.data.bpm || null,
    });
  }
};

function formatSigned(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function formatKey() {
  if (!detectedKey) return '—';
  const index = (((detectedKey.noteIndex + semitones) % 12) + 12) % 12;
  return NOTE_NAMES[index] + (detectedKey.mode === 'minor' ? 'm' : '');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function ensureAudio() {
  if (!context) {
    context = new AudioContext();
  }
  if (!gain) {
    gain = context.createGain();
    gain.gain.value = muted ? 0 : volume;
    gain.connect(context.destination);

    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(gain);

    eqNodes = createEqNodes(context, eq.getGains());
    eqNodes.output.connect(analyser);

    registration = SoundTouchNode.register(context, processorUrl);
    await registration;
    soundTouch = new SoundTouchNode({
      context,
      interpolationStrategy: 'lanczos',
    });
    soundTouch.setInterpolationStrategyParams({ zeroCrossings: 6, normalize: true });
    soundTouch.setStretchParameters(STRETCH_QUALITY);
    soundTouch.playbackRate.value = effectivePlaybackRate();
    soundTouch.pitchSemitones.value = semitones;
    soundTouch.connect(eqNodes.input);
  }

  if (context.state === 'suspended') await context.resume();
  await registration;
}

function isPitchTempoBypassed() {
  return semitones === 0 && Math.abs(effectivePlaybackRate() - 1) < 0.0001;
}

function routeSource(srcNode = source) {
  if (!srcNode || !eqNodes || !soundTouch) return;
  try {
    srcNode.disconnect();
  } catch {
    // ignore if not connected
  }
  srcNode.connect(isPitchTempoBypassed() ? eqNodes.input : soundTouch);
}

function routeStemGains() {
  if (!eqNodes || !soundTouch) return;
  const target = isPitchTempoBypassed() ? eqNodes.input : soundTouch;
  for (const gNode of [vocalsGain, instGain]) {
    if (!gNode) continue;
    try {
      gNode.disconnect();
    } catch {
      // ignore
    }
    gNode.connect(target);
  }
}

function stopSource() {
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    source = null;
  }
  for (const s of [vocalsSource, instSource]) {
    if (!s) continue;
    s.onended = null;
    try {
      s.stop();
    } catch {
      // already stopped
    }
    s.disconnect();
  }
  vocalsSource = null;
  instSource = null;
  if (vocalsGain) {
    vocalsGain.disconnect();
    vocalsGain = null;
  }
  if (instGain) {
    instGain.disconnect();
    instGain = null;
  }
}

function songTempoRatio() {
  return originalBpm > 0 ? currentBpm / originalBpm : 1;
}

function effectivePlaybackRate() {
  return songTempoRatio() * listeningSpeed;
}

function currentPosition() {
  if (!audioBuffer) return 0;
  const rate = effectivePlaybackRate();
  const active = Boolean(source || vocalsSource);
  const position = isPlaying && active ? pausedAt + (context.currentTime - startedAt) * rate : pausedAt;
  return Math.max(0, Math.min(audioBuffer.duration, position));
}

function updateProgress(position = currentPosition()) {
  if (isSeeking) return;
  const duration = audioBuffer ? audioBuffer.duration : 0;
  currentLabel.textContent = formatTime(position);
  seekInput.value = duration > 0 ? String(Math.round((position / duration) * 1000)) : '0';
}

function startProgressLoop() {
  if (progressFrame) return;
  const tick = () => {
    updateProgress();
    eq.drawWave(analyser, isPlaying);
    progressFrame = requestAnimationFrame(tick);
  };
  progressFrame = requestAnimationFrame(tick);
}

function stopProgressLoop() {
  if (!progressFrame) return;
  cancelAnimationFrame(progressFrame);
  progressFrame = 0;
  eq.drawWave(analyser, false);
}

function syncPlayButton() {
  playIcon.toggleAttribute('hidden', isPlaying);
  pauseIcon.toggleAttribute('hidden', !isPlaying);
}

async function playFrom(position) {
  if (!audioBuffer) return;
  await ensureAudio();
  stopSource();

  const startAt = Math.max(0, Math.min(position, audioBuffer.duration - 0.02));
  pausedAt = startAt;
  startedAt = context.currentTime;

  const onEnded = (endedNode) => {
    if (endedNode !== source && endedNode !== instSource) return;
    stopSource();
    isPlaying = false;
    pausedAt = 0;
    syncPlayButton();
    stopProgressLoop();
    updateProgress(0);
  };

  if (stems) {
    vocalsGain = context.createGain();
    vocalsGain.gain.value = vocalsLevel;
    instGain = context.createGain();
    instGain.gain.value = instLevel;
    routeStemGains();

    const vSrc = context.createBufferSource();
    vSrc.buffer = stems.vocalsBuffer;
    vSrc.playbackRate.value = effectivePlaybackRate();
    vSrc.connect(vocalsGain);

    const iSrc = context.createBufferSource();
    iSrc.buffer = stems.instBuffer;
    iSrc.playbackRate.value = effectivePlaybackRate();
    iSrc.connect(instGain);
    iSrc.onended = () => onEnded(iSrc);

    vocalsSource = vSrc;
    instSource = iSrc;
    vSrc.start(0, startAt);
    iSrc.start(0, startAt);
  } else {
    const next = context.createBufferSource();
    next.buffer = audioBuffer;
    next.playbackRate.value = effectivePlaybackRate();
    routeSource(next);
    next.onended = () => onEnded(next);
    source = next;
    next.start(0, startAt);
  }

  isPlaying = true;
  syncPlayButton();
  startProgressLoop();
}

function pausePlayback() {
  if (!isPlaying) return;
  const position = currentPosition();
  stopSource();
  pausedAt = position;
  isPlaying = false;
  syncPlayButton();
  stopProgressLoop();
  updateProgress(position);
}

function stopPlayback() {
  stopSource();
  pausedAt = 0;
  isPlaying = false;
  syncPlayButton();
  stopProgressLoop();
  updateProgress(0);
}

function togglePlayback() {
  if (isPlaying) pausePlayback();
  else playFrom(pausedAt);
}

function updateSemitoneUI() {
  semitonesLabel.textContent = formatSigned(semitones);
  downButton.disabled = semitones <= MIN_SEMITONES;
  upButton.disabled = semitones >= MAX_SEMITONES;
  keyResetButton.disabled = semitones === 0;
  updateKeyLabel();
}

function updateKeyLabel() {
  const formatted = formatKey();
  keyLabel.textContent = formatted;
  infoKey.textContent = formatted;
  if (detectedKey) {
    const noteIndex = (((detectedKey.noteIndex + semitones) % 12) + 12) % 12;
    piano.setSongKey({ noteIndex, mode: detectedKey.mode });
  } else {
    piano.setSongKey(null);
  }
}

function applyPlaybackRate() {
  if (isPlaying && context) {
    pausedAt = currentPosition();
    startedAt = context.currentTime;
  }
  const rate = effectivePlaybackRate();
  if (source) source.playbackRate.setValueAtTime(rate, context.currentTime);
  if (vocalsSource) vocalsSource.playbackRate.setValueAtTime(rate, context.currentTime);
  if (instSource) instSource.playbackRate.setValueAtTime(rate, context.currentTime);
  if (soundTouch) soundTouch.playbackRate.setValueAtTime(rate, context.currentTime);
  routeSource();
  routeStemGains();
}

function updateBpmUI() {
  bpmValueLabel.textContent = `${currentBpm} BPM`;
  infoBpm.textContent = `${currentBpm} BPM`;
  bpmResetButton.disabled = currentBpm === originalBpm;
}

function setBpm(value) {
  const next = Math.max(40, Math.min(240, Math.round(value)));
  if (next === currentBpm) return;
  currentBpm = next;
  savedSinceEdit = false;
  updateBpmUI();
  applyPlaybackRate();
}

function setListeningSpeed(speed) {
  listeningSpeed = speed;
  speedButton.textContent = `${speed}x`;
  for (const btn of speedMenu.querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.speed) === speed);
  }
  applyPlaybackRate();
}

function setSemitones(value) {
  const next = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, value));
  if (next === semitones) return;
  semitones = next;
  savedSinceEdit = false;
  updateSemitoneUI();
  if (soundTouch) {
    soundTouch.pitchSemitones.setTargetAtTime(semitones, context.currentTime, 0.015);
  }
  routeSource();
  routeStemGains();
}

function detectKey(buffer) {
  const first = buffer.getChannelData(0);
  const mono = new Float32Array(first.length);

  if (buffer.numberOfChannels === 1) {
    mono.set(first);
  } else {
    const second = buffer.getChannelData(1);
    for (let i = 0; i < first.length; i += 1) {
      mono[i] = (first[i] + second[i]) * 0.5;
    }
  }

  keyWorker.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
}

function hasUnsavedChanges() {
  if (!audioBuffer || savedSinceEdit) return false;
  const eqDirty = eq.getGains().some((g) => Math.abs(g) >= 0.05);
  const stemsDirty = Boolean(stems) && (Math.abs(vocalsLevel - 1) >= 0.01 || Math.abs(instLevel - 1) >= 0.01);
  return semitones !== 0 || currentBpm !== originalBpm || eqDirty || stemsDirty;
}

function confirmDiscard() {
  if (!hasUnsavedChanges()) return Promise.resolve(true);
  confirmModal.hidden = false;
  return new Promise((resolve) => {
    const finish = (accepted) => {
      confirmModal.hidden = true;
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      confirmModal.removeEventListener('click', onBackdrop);
      resolve(accepted);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      e.stopPropagation();
      if (e.target === confirmModal) finish(false);
    };
    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
    confirmModal.addEventListener('click', onBackdrop);
  });
}

function setCenterMode(mode) {
  centerMode = mode;
  navStudio.classList.toggle('active', mode === 'studio');
  navMinus.classList.toggle('active', mode === 'minus');
  navPiano.classList.toggle('active', mode === 'piano');
  if (mode !== 'piano') piano.stopAllNotes();

  if (!audioBuffer) {
    empty.hidden = mode !== 'studio';
    tunerRow.hidden = true;
    eqWrap.hidden = true;
    minusView.hidden = mode !== 'minus';
    pianoView.hidden = mode !== 'piano';
    return;
  }

  empty.hidden = true;
  tunerRow.hidden = mode !== 'studio';
  eqWrap.hidden = mode !== 'studio';
  minusView.hidden = mode !== 'minus';
  pianoView.hidden = mode !== 'piano';
}

function resetStemsUI() {
  stems = null;
  vocalsLevel = 1;
  instLevel = 1;
  vocalsRange.value = '100';
  vocalsVal.textContent = '100%';
  instRange.value = '100';
  instVal.textContent = '100%';
  stemsCard.hidden = true;
  sepIdle.hidden = false;
  sepProgress.hidden = true;
  separateButton.disabled = !audioBuffer || separating;
  invoke('clear_stems').catch(() => {});
}

async function loadAudioBytes(arrayBuffer, displayName, libraryId = null) {
  await ensureAudio();
  const decoded = await context.decodeAudioData(arrayBuffer);
  stopPlayback();
  audioBuffer = decoded;
  resetStemsUI();
  activeLibraryId = libraryId;
  library.setActiveId(libraryId);
  baseName = displayName;
  infoName.textContent = baseName;
  detectedKey = null;
  semitones = 0;
  originalBpm = 120;
  currentBpm = 120;
  eq.reset();
  if (soundTouch && context) {
    soundTouch.pitchSemitones.setValueAtTime(0, context.currentTime);
    soundTouch.playbackRate.setValueAtTime(effectivePlaybackRate(), context.currentTime);
  }
  savedSinceEdit = true;
  updateSemitoneUI();
  updateBpmUI();
  durationLabel.textContent = formatTime(decoded.duration);
  trackInfo.hidden = false;
  player.hidden = false;
  setCenterMode('studio');
  hideExportBox();
  detectKey(decoded);
  await playFrom(0);
}

async function loadFile(file) {
  if (!file) return;
  if (!(await confirmDiscard())) return;

  try {
    const data = await file.arrayBuffer();
    await loadAudioBytes(data, file.name.replace(/\.[^.]+$/, ''), null);
  } catch (error) {
    console.error('Не удалось открыть файл', error);
  }
}

async function openLibraryTrack(item) {
  if (!item) return;
  if (!(await confirmDiscard())) return;

  try {
    const raw = await invoke('read_audio_file', { path: item.path });
    const buffer = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
    library.markMissing(item.id, false);
    await loadAudioBytes(buffer, item.name, item.id);
  } catch (error) {
    console.error('Не удалось открыть трек из хранилища', error);
    library.markMissing(item.id, true);
  }
}

function setExportProgress(percent, text) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  exportFill.style.width = `${clamped}%`;
  exportLabel.textContent = text ?? `Конвертация… ${clamped}%`;
}

function hideExportBox() {
  exportBox.hidden = true;
  revealFolderLink.hidden = true;
  lastSavedPath = null;
}

async function saveFile(ext) {
  if (!audioBuffer || saving) return;

  saveMenu.hidden = true;

  const name = `${baseName} (${formatSigned(semitones)}).${ext}`;
  const musicDir = await audioDir().catch(() => null);
  const defaultPath = musicDir ? await join(musicDir, name) : name;
  const filePath = await save({
    title: 'Сохранить',
    defaultPath,
    filters: [
      ext === 'mp3'
        ? { name: 'MP3', extensions: ['mp3'] }
        : { name: 'WAV', extensions: ['wav'] },
    ],
  });

  if (!filePath) return;

  saving = true;
  saveButton.classList.add('busy');
  lastSavedPath = null;
  revealFolderLink.hidden = true;
  exportBox.hidden = false;
  setExportProgress(0);

  let fakeProgress = 0;
  const phaseOneTimer = setInterval(() => {
    fakeProgress = Math.min(38, fakeProgress + (38 - fakeProgress) * 0.14);
    setExportProgress(fakeProgress);
  }, 120);

  try {
    const sourceBuffer = stems
      ? mixStemsBuffer(context, stems, vocalsLevel, instLevel)
      : audioBuffer;
    const tempoRatio = songTempoRatio();
    const shifted = semitones === 0 && Math.abs(tempoRatio - 1) < 0.0001
      ? sourceBuffer
      : await processOffline({
          input: sourceBuffer,
          processorUrl,
          pitchSemitones: semitones,
          playbackRate: tempoRatio,
          interpolationStrategy: 'lanczos',
          stretchParameters: STRETCH_QUALITY,
        });
    const processed = await applyEqToBuffer(shifted, eq.getGains());
    clearInterval(phaseOneTimer);
    setExportProgress(40);

    const onEncodeProgress = (ratio) => {
      setExportProgress(40 + ratio * 58);
    };

    const blob = ext === 'wav'
      ? await encodeWav(processed, onEncodeProgress)
      : await encodeMp3(processed, onEncodeProgress);
    const data = await blob.arrayBuffer();
    await writeFile(filePath, new Uint8Array(data));

    lastSavedPath = filePath;
    savedSinceEdit = true;
    setExportProgress(100, 'Готово · 100%');
    revealFolderLink.hidden = false;
  } catch (error) {
    clearInterval(phaseOneTimer);
    console.error('Не удалось сохранить файл', error);
    setExportProgress(0, `Ошибка: ${error?.message || error}`);
  } finally {
    clearInterval(phaseOneTimer);
    saving = false;
    saveButton.classList.remove('busy');
  }
}

stage.addEventListener('click', (event) => {
  if (audioBuffer || centerMode !== 'studio') return;
  if (!event.target.closest('#empty')) return;
  fileInput.click();
});

openButton.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  loadFile(fileInput.files[0]);
  fileInput.value = '';
});

document.getElementById('app').addEventListener('dragover', (event) => {
  event.preventDefault();
  stage.classList.add('dragging');
});

document.getElementById('app').addEventListener('dragleave', (event) => {
  if (event.relatedTarget) return;
  stage.classList.remove('dragging');
});

document.getElementById('app').addEventListener('drop', (event) => {
  event.preventDefault();
  stage.classList.remove('dragging');
  loadFile(event.dataTransfer.files[0]);
});

downButton.addEventListener('click', () => setSemitones(semitones - 1));
upButton.addEventListener('click', () => setSemitones(semitones + 1));
keyResetButton.addEventListener('click', () => setSemitones(0));

bpmDownButton.addEventListener('click', (event) => setBpm(currentBpm - (event.shiftKey ? 5 : 1)));
bpmUpButton.addEventListener('click', (event) => setBpm(currentBpm + (event.shiftKey ? 5 : 1)));
bpmResetButton.addEventListener('click', () => setBpm(originalBpm));

helpButton.addEventListener('click', (event) => {
  event.stopPropagation();
  helpModal.hidden = !helpModal.hidden;
});

helpModal.addEventListener('click', (event) => {
  event.stopPropagation();
  if (event.target === helpModal) helpModal.hidden = true;
});

playPauseButton.addEventListener('click', togglePlayback);
document.getElementById('restart').addEventListener('click', () => playFrom(0));
document.getElementById('stop').addEventListener('click', stopPlayback);

seekInput.addEventListener('pointerdown', () => {
  isSeeking = true;
});

seekInput.addEventListener('input', () => {
  isSeeking = true;
  const duration = audioBuffer ? audioBuffer.duration : 0;
  currentLabel.textContent = formatTime((Number(seekInput.value) / 1000) * duration);
});

seekInput.addEventListener('change', () => {
  isSeeking = false;
  if (!audioBuffer) return;
  const target = (Number(seekInput.value) / 1000) * audioBuffer.duration;
  if (isPlaying) {
    playFrom(target);
  } else {
    pausedAt = target;
    updateProgress(target);
  }
});

seekInput.addEventListener('pointercancel', () => {
  isSeeking = false;
});

function applyVolume() {
  if (gain) gain.gain.value = muted ? 0 : volume;
  volumeInput.value = String(Math.round((muted ? 0 : volume) * 100));
  volumeIcon.toggleAttribute('hidden', muted || volume === 0);
  muteIcon.toggleAttribute('hidden', !muted && volume !== 0);
}

volumeInput.addEventListener('input', () => {
  volume = Number(volumeInput.value) / 100;
  if (volume > 0) {
    muted = false;
    lastVolume = volume;
  }
  applyVolume();
});

muteButton.addEventListener('click', () => {
  if (muted || volume === 0) {
    muted = false;
    volume = lastVolume || 1;
  } else {
    lastVolume = volume;
    muted = true;
  }
  applyVolume();
});

speedButton.addEventListener('click', (event) => {
  event.stopPropagation();
  saveMenu.hidden = true;
  speedMenu.hidden = !speedMenu.hidden;
});

speedMenu.addEventListener('click', (event) => {
  const value = Number(event.target.dataset.speed);
  if (value) {
    setListeningSpeed(value);
    speedMenu.hidden = true;
  }
});

saveButton.addEventListener('click', (event) => {
  event.stopPropagation();
  speedMenu.hidden = true;
  saveMenu.hidden = !saveMenu.hidden;
});

saveMenu.addEventListener('click', (event) => {
  const ext = event.target.dataset.ext;
  if (ext) saveFile(ext);
});

revealFolderLink.addEventListener('click', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (lastSavedPath) {
    await invoke('reveal_in_folder', { path: lastSavedPath });
  }
});

exportBox.addEventListener('click', (event) => {
  if (saving || event.target === revealFolderLink) return;
  hideExportBox();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.save-wrap')) saveMenu.hidden = true;
  if (!event.target.closest('.speed-wrap')) speedMenu.hidden = true;
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (
    event.key === 'F5' ||
    event.key === 'F12' ||
    (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) ||
    (mod && ['r', 'p', 's', 'u', 'f', 'g', '+', '-', '=', '0'].includes(key)) ||
    (mod && event.shiftKey && ['i', 'j', 'c', 'r'].includes(key))
  ) {
    event.preventDefault();
    return;
  }

  if (event.key === 'Escape') {
    if (!helpModal.hidden) helpModal.hidden = true;
    if (!propsModal.hidden) propsModal.hidden = true;
    if (!confirmModal.hidden) confirmCancel.click();
    return;
  }

  if (event.target.matches('input[type="text"], input[type="search"], textarea')) return;

  if (centerMode === 'piano' && piano.handleKeyDown(event)) {
    event.preventDefault();
    return;
  }

  if (event.target.matches('input, button')) return;

  if (event.code === 'Space') {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === 'ArrowLeft' && audioBuffer) {
    event.preventDefault();
    const target = Math.max(0, currentPosition() - 5);
    if (isPlaying) playFrom(target);
    else {
      pausedAt = target;
      updateProgress(target);
    }
  } else if (event.code === 'ArrowRight' && audioBuffer) {
    event.preventDefault();
    const target = Math.min(audioBuffer.duration, currentPosition() + 5);
    if (isPlaying) playFrom(target);
    else {
      pausedAt = target;
      updateProgress(target);
    }
  } else if (event.code === 'ArrowUp' && audioBuffer) {
    event.preventDefault();
    setSemitones(semitones + 1);
  } else if (event.code === 'ArrowDown' && audioBuffer) {
    event.preventDefault();
    setSemitones(semitones - 1);
  } else if (key === '0' && audioBuffer) {
    event.preventDefault();
    setSemitones(0);
  } else if (key === 'm' && audioBuffer) {
    event.preventDefault();
    muteButton.click();
  } else if (key === 'r' && audioBuffer) {
    event.preventDefault();
    playFrom(0);
  }
});

document.addEventListener('keyup', (event) => {
  if (centerMode === 'piano') {
    piano.handleKeyUp(event);
  }
});

getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type === 'enter' || event.payload.type === 'over') {
    stage.classList.add('dragging');
  } else if (event.payload.type === 'leave') {
    stage.classList.remove('dragging');
  } else if (event.payload.type === 'drop') {
    stage.classList.remove('dragging');
    const paths = event.payload.paths || [];
    if (!paths.length) return;
    const added = await library.addPaths(paths);
    if (added.length && !audioBuffer) {
      await openLibraryTrack(added[0]);
    }
  }
});

rightCollapse.addEventListener('click', () => {
  rightPanel.hidden = true;
  rightExpand.hidden = false;
});

rightExpand.addEventListener('click', () => {
  rightPanel.hidden = false;
  rightExpand.hidden = true;
});

navStudio.addEventListener('click', () => {
  navStudio.blur();
  setCenterMode('studio');
});
navMinus.addEventListener('click', () => {
  navMinus.blur();
  setCenterMode('minus');
});
navPiano.addEventListener('click', () => {
  navPiano.blur();
  setCenterMode('piano');
});

function applyStemLevels() {
  savedSinceEdit = false;
  vocalsVal.textContent = `${Math.round(vocalsLevel * 100)}%`;
  instVal.textContent = `${Math.round(instLevel * 100)}%`;
  vocalsRange.value = String(Math.round(vocalsLevel * 100));
  instRange.value = String(Math.round(instLevel * 100));
  if (vocalsGain && context) {
    vocalsGain.gain.setTargetAtTime(vocalsLevel, context.currentTime, 0.015);
  }
  if (instGain && context) {
    instGain.gain.setTargetAtTime(instLevel, context.currentTime, 0.015);
  }
}

vocalsRange.addEventListener('input', () => {
  vocalsLevel = Number(vocalsRange.value) / 100;
  applyStemLevels();
});

instRange.addEventListener('input', () => {
  instLevel = Number(instRange.value) / 100;
  applyStemLevels();
});

stemMinusBtn.addEventListener('click', () => {
  vocalsLevel = 0;
  instLevel = 1;
  applyStemLevels();
});

stemResetBtn.addEventListener('click', () => {
  vocalsLevel = 1;
  instLevel = 1;
  applyStemLevels();
});

separateButton.addEventListener('click', async () => {
  if (!audioBuffer || separating) return;
  separating = true;
  separateButton.disabled = true;
  sepIdle.hidden = true;
  sepProgress.hidden = false;
  sepFill.style.width = '0%';
  sepLabel.textContent = 'Извлечение… 0%';

  const unlisten = await listen('separation-progress', (event) => {
    const pct = Math.max(0, Math.min(100, Number(event.payload) || 0));
    sepFill.style.width = `${pct}%`;
    sepLabel.textContent = `Извлечение… ${pct}%`;
  });

  try {
    await ensureAudio();
    const result = await runStemSeparation(audioBuffer, context);
    stems = result;
    sepProgress.hidden = true;
    stemsCard.hidden = false;
    if (isPlaying) {
      await playFrom(currentPosition());
    }
  } catch (error) {
    console.error('Ошибка разделения', error);
    sepIdle.hidden = false;
    sepLabel.textContent = `Ошибка: ${error?.message || error}`;
  } finally {
    unlisten();
    separating = false;
    separateButton.disabled = !audioBuffer;
  }
});

updateSemitoneUI();
updateBpmUI();
setListeningSpeed(1);
updateProgress(0);
applyVolume();
library.init();

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'webm',
]);

function formatBytes(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 2)} ${units[idx]} (${bytes.toLocaleString('ru-RU')} Б)`;
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  return `${mins}:${secs} (${seconds.toFixed(2)} сек)`;
}

export function createLibraryController({
  sidebar,
  expandButton,
  collapseButton,
  addButton,
  sortButton,
  sortMenu,
  searchInput,
  listEl,
  emptyEl,
  menuEl,
  propsModal,
  propsList,
  propsClose,
  importBox,
  importLabel,
  importFill,
  onSelectTrack,
  getActiveTrackInfo,
}) {
  let items = [];
  let activeId = null;
  let sortBy = 'name';
  let sortDir = 'asc';
  let searchQuery = '';
  let menuTargetId = null;
  let renamingId = null;
  let draggingId = null;

  async function persist() {
    try {
      await invoke('save_library', { items });
    } catch (error) {
      console.error('Не удалось сохранить хранилище', error);
    }
  }

  function updateSortMenuUI() {
    for (const btn of sortMenu.querySelectorAll('button')) {
      if (btn.dataset.sort) btn.classList.toggle('active', btn.dataset.sort === sortBy);
      if (btn.dataset.dir) btn.classList.toggle('active', btn.dataset.dir === sortDir);
    }
  }

  function applySort() {
    const dir = sortDir === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      if (sortBy === 'date') {
        return ((a.modifiedMs || 0) - (b.modifiedMs || 0)) * dir;
      }
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) * dir;
    });
    persist();
    render();
  }

  function flashItem(id) {
    const el = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
  }

  function startRename(id) {
    renamingId = id;
    render();
    const input = listEl.querySelector('.lib-rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function openProps(item) {
    const props = await invoke('get_file_props', { path: item.path });
    const activeInfo = getActiveTrackInfo(item.id);

    const rows = [
      ['Название', item.name],
      ['Имя файла', props.fileName || '—'],
      ['Путь', props.path],
      ['Статус', props.exists ? 'Доступен' : 'Файл не найден'],
      ['Формат', (props.ext || item.ext || '—').toUpperCase()],
      ['Размер', formatBytes(props.sizeBytes)],
      ['Изменён', formatDate(props.modifiedMs)],
      ['Создан', formatDate(props.createdMs)],
    ];

    if (activeInfo) {
      rows.push(['Длительность', formatDuration(activeInfo.duration)]);
      rows.push(['Частота', `${activeInfo.sampleRate} Гц`]);
      rows.push(['Каналы', activeInfo.channels === 1 ? '1 (Моно)' : `${activeInfo.channels} (Стерео)`]);
      if (activeInfo.duration > 0 && props.sizeBytes > 0) {
        const kbps = Math.round((props.sizeBytes * 8) / activeInfo.duration / 1000);
        rows.push(['Битрейт (ср.)', `~${kbps} кбит/с`]);
      }
    }

    if (item.keyLabel) rows.push(['Тональность', item.keyLabel]);
    if (item.bpm) rows.push(['Темп', `${item.bpm} BPM`]);
    rows.push(['SHA-256', props.hash || item.hash || '—']);

    propsList.innerHTML = '';
    for (const [key, val] of rows) {
      const row = document.createElement('div');
      row.className = 'props-row';
      const k = document.createElement('span');
      k.className = 'props-key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'props-val';
      v.textContent = val;
      row.append(k, v);
      propsList.appendChild(row);
    }

    propsModal.hidden = false;
  }

  function render() {
    listEl.innerHTML = '';
    const q = searchQuery.trim().toLowerCase();
    const visible = q
      ? items.filter((item) => item.name.toLowerCase().includes(q))
      : items;

    emptyEl.hidden = items.length > 0;

    for (const item of visible) {
      const row = document.createElement('div');
      row.className = 'lib-item';
      if (item.id === activeId) row.classList.add('active');
      if (item.missing) row.classList.add('missing');
      row.dataset.id = item.id;
      row.draggable = renamingId !== item.id && !q;

      if (renamingId === item.id) {
        const input = document.createElement('input');
        input.className = 'lib-rename-input';
        input.type = 'text';
        input.value = item.name;
        const commit = () => {
          const next = input.value.trim();
          if (next && next !== item.name) {
            item.name = next;
            persist();
          }
          renamingId = null;
          render();
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            renamingId = null;
            render();
          }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(input);
      } else {
        const nameEl = document.createElement('span');
        nameEl.className = 'lib-item-name';
        nameEl.textContent = item.name;
        nameEl.title = item.path;
        row.appendChild(nameEl);

        const metaParts = [];
        if (item.keyLabel) metaParts.push(item.keyLabel);
        if (item.bpm) metaParts.push(item.bpm);
        if (metaParts.length) {
          const metaEl = document.createElement('span');
          metaEl.className = 'lib-item-meta';
          metaEl.textContent = metaParts.join(' · ');
          row.appendChild(metaEl);
        }
      }

      row.addEventListener('click', () => {
        if (renamingId === item.id) return;
        onSelectTrack(item);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        menuTargetId = item.id;
        menuEl.hidden = false;
        const x = Math.min(e.clientX, window.innerWidth - menuEl.offsetWidth - 8);
        const y = Math.min(e.clientY, window.innerHeight - menuEl.offsetHeight - 8);
        menuEl.style.left = `${Math.max(8, x)}px`;
        menuEl.style.top = `${Math.max(8, y)}px`;
      });

      row.addEventListener('dragstart', (e) => {
        if (renamingId === item.id || q) {
          e.preventDefault();
          return;
        }
        draggingId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-repert2r-id', item.id);
      });

      row.addEventListener('dragover', (e) => {
        if (!draggingId || draggingId === item.id) return;
        e.preventDefault();
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        row.classList.remove('drag-over');
        if (!draggingId || draggingId === item.id) return;
        e.preventDefault();
        e.stopPropagation();
        const fromIdx = items.findIndex((i) => i.id === draggingId);
        const toIdx = items.findIndex((i) => i.id === item.id);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [moved] = items.splice(fromIdx, 1);
          items.splice(toIdx, 0, moved);
          persist();
          render();
        }
        draggingId = null;
      });

      row.addEventListener('dragend', () => {
        draggingId = null;
        for (const el of listEl.querySelectorAll('.drag-over')) {
          el.classList.remove('drag-over');
        }
      });

      listEl.appendChild(row);
    }
  }

  async function addPaths(paths) {
    const audioPaths = paths.filter((p) => {
      const ext = p.split('.').pop()?.toLowerCase() || '';
      return AUDIO_EXTENSIONS.has(ext);
    });
    if (!audioPaths.length) return [];

    importBox.hidden = false;
    importFill.style.width = '0%';
    importLabel.textContent = `Добавление треков… 0 / ${audioPaths.length}`;

    const unlisten = await listen('library-import-progress', (event) => {
      const { current, total } = event.payload || {};
      if (!total) return;
      const pct = Math.round((current / total) * 100);
      importFill.style.width = `${pct}%`;
      importLabel.textContent = `Добавление треков… ${current} / ${total}`;
    });

    let inspected = [];
    try {
      inspected = await invoke('inspect_files', { paths: audioPaths });
    } finally {
      unlisten();
      importBox.hidden = true;
    }

    const existingHashes = new Map(items.map((item) => [item.hash, item]));
    const added = [];
    let duplicateId = null;

    for (const file of inspected) {
      const dup = existingHashes.get(file.hash);
      if (dup) {
        duplicateId = dup.id;
        continue;
      }
      const item = {
        id: crypto.randomUUID(),
        name: file.name,
        path: file.path,
        hash: file.hash,
        modifiedMs: file.modifiedMs,
        sizeBytes: file.sizeBytes,
        ext: file.ext,
        keyLabel: '',
        bpm: null,
      };
      items.push(item);
      existingHashes.set(item.hash, item);
      added.push(item);
    }

    if (added.length) {
      await persist();
      render();
    } else if (duplicateId) {
      flashItem(duplicateId);
    }

    return added;
  }

  async function pickFilesToAdd() {
    const selected = await open({
      multiple: true,
      title: 'Добавить аудиофайлы в хранилище',
      filters: [
        {
          name: 'Аудио',
          extensions: Array.from(AUDIO_EXTENSIONS),
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const added = await addPaths(paths);
    if (added.length && !activeId) {
      onSelectTrack(added[0]);
    }
  }

  collapseButton.addEventListener('click', () => {
    sidebar.hidden = true;
    expandButton.hidden = false;
  });

  expandButton.addEventListener('click', () => {
    sidebar.hidden = false;
    expandButton.hidden = true;
  });

  addButton.addEventListener('click', pickFilesToAdd);

  sortButton.addEventListener('click', (e) => {
    e.stopPropagation();
    sortMenu.hidden = !sortMenu.hidden;
  });

  sortMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.sort) sortBy = btn.dataset.sort;
    if (btn.dataset.dir) sortDir = btn.dataset.dir;
    updateSortMenuUI();
    applySort();
    sortMenu.hidden = true;
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    render();
  });

  menuEl.addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    if (!action || !menuTargetId) return;
    const item = items.find((i) => i.id === menuTargetId);
    menuEl.hidden = true;
    if (!item) return;

    if (action === 'reveal') {
      await invoke('reveal_in_folder', { path: item.path });
    } else if (action === 'rename') {
      startRename(item.id);
    } else if (action === 'props') {
      await openProps(item);
    } else if (action === 'remove') {
      items = items.filter((i) => i.id !== item.id);
      if (activeId === item.id) activeId = null;
      await persist();
      render();
    }
  });

  propsClose.addEventListener('click', () => {
    propsModal.hidden = true;
  });

  propsModal.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === propsModal) propsModal.hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sort-wrap')) sortMenu.hidden = true;
    if (!e.target.closest('#lib-menu')) menuEl.hidden = true;
  });

  async function init() {
    try {
      items = await invoke('load_library');
    } catch {
      items = [];
    }
    updateSortMenuUI();
    render();
  }

  return {
    init,
    addPaths,
    setActiveId(id) {
      activeId = id;
      render();
    },
    markMissing(id, missing) {
      const item = items.find((i) => i.id === id);
      if (item && item.missing !== missing) {
        item.missing = missing;
        render();
      }
    },
    updateTrackMeta(id, { keyLabel, bpm }) {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      let changed = false;
      if (keyLabel && item.keyLabel !== keyLabel) {
        item.keyLabel = keyLabel;
        changed = true;
      }
      if (bpm && item.bpm !== bpm) {
        item.bpm = bpm;
        changed = true;
      }
      if (changed) {
        persist();
        render();
      }
    },
  };
}

'use strict';

import { deleteTrack, fetchTracks, renameTrack, updateTrackDuration, uploadTrack } from './api.js';
import { Player } from './player.js';
import { formatSize, formatTime, formatUploadDate, initialOf, toneFor, truncate } from './utils.js';

const PER_PAGE = 16;
const SUPPORTED_EXTENSION = /\.(mp3|wav|m4a)$/i;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  tracks: [],
  query: '',
  page: 1,
  uploading: false,
  loadFailed: false,
  probingDurations: false,
};

const els = {
  cardGrid: document.getElementById('card-grid'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyText: document.getElementById('empty-text'),
  pagination: document.getElementById('pagination'),
  resultSummary: document.getElementById('result-summary'),
  trackCount: document.getElementById('track-count'),
  searchInput: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('notice-text'),
  noticeClose: document.getElementById('notice-close'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  uploadStatus: document.getElementById('upload-status'),
  uploadProgress: document.getElementById('upload-progress'),
  uploadProgressFill: document.getElementById('upload-progress-fill'),
  themeToggle: document.getElementById('theme-toggle'),
  collection: document.getElementById('collection'),
  themeMeta: document.querySelector('meta[name="theme-color"]'),
  renameDialog: document.getElementById('rename-dialog'),
  renameForm: document.getElementById('rename-form'),
  renameInput: document.getElementById('rename-input'),
  renameSave: document.getElementById('rename-save'),
  renameCancel: document.getElementById('rename-cancel'),
  renameClose: document.getElementById('rename-close'),
  renameError: document.getElementById('rename-error'),
  deleteDialog: document.getElementById('delete-dialog'),
  deleteTrackName: document.getElementById('delete-track-name'),
  deleteConfirm: document.getElementById('delete-confirm'),
  deleteCancel: document.getElementById('delete-cancel'),
  deleteClose: document.getElementById('delete-close'),
  deleteError: document.getElementById('delete-error'),
};

let player = null;
let noticeTimer = null;
let noticeLeaveTimer = null;
let searchTimer = null;
let uploadStatusTimer = null;
let dragDepth = 0;
let editingTrackId = null;
let deletingTrackId = null;

/* ------------------------------ small helpers ----------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function createIcon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, label, iconName) {
  const node = element('button', className);
  node.type = 'button';
  if (iconName) node.append(createIcon(iconName));
  if (label) {
    const text = element('span', '', label);
    node.append(text);
  }
  return node;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getFilteredTracks() {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query) return state.tracks;
  return state.tracks.filter((track) =>
    `${track.title} ${track.filename}`.toLocaleLowerCase().includes(query)
  );
}

function summarizeProblems(problems) {
  if (problems.length <= 2) return problems.join('；');
  return `${problems.slice(0, 2).join('；')}；另有 ${problems.length - 2} 个问题`;
}

/* --------------------------------- notices -------------------------------- */

function hideNotice() {
  if (els.notice.hidden) return;
  clearTimeout(noticeTimer);
  els.notice.classList.add('is-leaving');
  clearTimeout(noticeLeaveTimer);
  noticeLeaveTimer = setTimeout(() => {
    els.notice.hidden = true;
    els.notice.classList.remove('is-leaving');
  }, 280);
}

function showNotice(message, type = 'error') {
  if (!message) return;
  clearTimeout(noticeTimer);
  clearTimeout(noticeLeaveTimer);

  els.notice.className = `notice notice--${type}`;
  els.notice.hidden = false;
  els.noticeText.textContent = message;

  const timeout = type === 'error' ? 7600 : 4400;
  noticeTimer = setTimeout(hideNotice, timeout);
}

/* --------------------------------- theme ---------------------------------- */

function syncThemeUI() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  els.themeToggle.setAttribute('aria-label', isDark ? '切换到浅色模式' : '切换到深色模式');
  els.themeToggle.title = isDark ? '切换到浅色模式' : '切换到深色模式';
  if (els.themeMeta) els.themeMeta.setAttribute('content', isDark ? '#141917' : '#f4efe7');
}

function initTheme() {
  syncThemeUI();
  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('isle-theme', next);
    } catch {
      /* 忽略 */
    }
    syncThemeUI();
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', (event) => {
    let saved = null;
    try {
      saved = localStorage.getItem('isle-theme');
    } catch {
      /* 忽略 */
    }
    if (saved === 'dark' || saved === 'light') return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    syncThemeUI();
  });
}

/* -------------------------------- playback -------------------------------- */

function syncPlayingCards() {
  if (!player) return;
  const current = player.current;
  const playing = player.isPlaying;

  els.cardGrid.querySelectorAll('.track-card').forEach((card) => {
    const isCurrent = Boolean(current) && card.dataset.id === current.id;
    card.classList.toggle('is-current', isCurrent);
    card.classList.toggle('is-playing', isCurrent && playing);

    const listenButton = card.querySelector('.btn-listen');
    if (!listenButton) return;
    const label = isCurrent && playing ? '暂停' : '播放';
    listenButton.setAttribute('aria-label', `${label}《${card.dataset.title}》`);
    const labelNode = listenButton.querySelector('span');
    if (labelNode) labelNode.textContent = label;
    const use = listenButton.querySelector('use');
    if (use) use.setAttribute('href', isCurrent && playing ? '#i-pause' : '#i-play');
  });
}

function playFromList(list, index, { toggle = false } = {}) {
  const track = list[index];
  if (!track) return;

  if (player.current && player.current.id === track.id) {
    // 卡片本身遵循「点击即播放」：正在响就保持，暂停时继续；
    // 只有明确的播放按钮才承担暂停 / 继续的切换。
    if (toggle) player.toggle();
    else if (!player.isPlaying) player.play();
    return;
  }
  player.setQueue(list, index, true);
}

function addToQueue(track) {
  if (player.enqueue(track)) {
    showNotice(`《${truncate(track.title, 32)}》已排进队列末尾。`, 'success');
  } else {
    showNotice(`《${truncate(track.title, 32)}》已经在队列里了。`, 'info');
  }
}

/* --------------------------------- cards ---------------------------------- */

/** 卡片 meta 区域的时长节点：未知时先占位隐藏，探测到后填入 */
function createDurationNode(track) {
  const node = element('span', 'card-duration');
  node.hidden = true;
  if (Number(track.duration) > 0) {
    node.textContent = formatTime(track.duration);
    node.hidden = false;
  }
  return node;
}

function closeCardMenus() {
  document.querySelectorAll('.track-card.menu-open').forEach((card) => {
    card.classList.remove('menu-open');
    const toggle = card.querySelector('.card-more');
    const menu = card.querySelector('.card-menu');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

function createCardMenu(track) {  const menuId = `card-menu-${track.id}`;
  const moreButton = element('button', 'card-more');
  moreButton.type = 'button';
  moreButton.setAttribute('aria-label', `《${track.title}》的更多操作`);
  moreButton.setAttribute('aria-haspopup', 'menu');
  moreButton.setAttribute('aria-expanded', 'false');
  moreButton.setAttribute('aria-controls', menuId);
  moreButton.title = '重命名 / 删除';
  moreButton.append(createIcon('i-more'));

  const menu = element('div', 'card-menu');
  menu.id = menuId;
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `《${track.title}》的操作`);

  const renameButton = button('card-menu-item', '重命名', 'i-pencil');
  renameButton.setAttribute('role', 'menuitem');
  const deleteButton = button('card-menu-item card-menu-danger', '删除', 'i-trash');
  deleteButton.setAttribute('role', 'menuitem');
  menu.append(renameButton, deleteButton);

  moreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const card = moreButton.closest('.track-card');
    const willOpen = menu.hidden;
    closeCardMenus();
    if (!willOpen) return;

    menu.hidden = false;
    moreButton.setAttribute('aria-expanded', 'true');
    if (card) card.classList.add('menu-open');
  });

  renameButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closeCardMenus();
    openRenameDialog(track);
  });

  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closeCardMenus();
    openDeleteDialog(track);
  });

  menu.addEventListener('click', (event) => event.stopPropagation());

  return { moreButton, menu };
}

function createCard(track, absoluteIndex, pageIndex, list) {
  const card = element('article', 'track-card');
  card.dataset.id = track.id;
  card.dataset.title = track.title;
  card.style.setProperty('--i', String(pageIndex));

  const top = element('div', 'card-top');

  const vinyl = element('div', 'vinyl');
  vinyl.append(
    element('span', 'vinyl-sheen'),
    (() => {
      const label = element('span', `vinyl-label ${toneFor(track.title)}`);
      label.append(element('span', '', initialOf(track.title)));
      return label;
    })(),
    element('span', 'vinyl-hole')
  );

  const corner = element('div', 'card-corner');
  const equalizer = element('span', 'equalizer');
  equalizer.setAttribute('aria-hidden', 'true');
  equalizer.append(element('i'), element('i'), element('i'));
  const cardMenu = createCardMenu(track);

  corner.append(
    element('span', 'card-index', `No. ${String(absoluteIndex + 1).padStart(2, '0')}`),
    equalizer,
    cardMenu.moreButton,
    cardMenu.menu
  );

  top.append(vinyl, corner);

  const body = element('div', 'card-body');
  const title = element('h3', 'card-title', track.title);
  title.title = track.filename;

  const meta = element('div', 'card-meta');
  meta.append(
    element('span', 'format-chip', (track.extension || '').toUpperCase() || 'AUDIO'),
    createDurationNode(track),
    (() => {
      const time = document.createElement('time');
      time.className = 'card-date';
      time.dateTime = track.uploadedAt;
      time.textContent = formatUploadDate(track.uploadedAt);
      return time;
    })()
  );
  body.append(title, meta);

  const actions = element('div', 'card-actions');
  const listenButton = button('btn-listen', '播放', 'i-play');
  listenButton.setAttribute('aria-label', `播放《${track.title}》`);
  const queueButton = button('btn-queue', '加入队列', 'i-queue');
  queueButton.setAttribute('aria-label', `将《${track.title}》加入播放队列`);
  queueButton.title = '添加到队列末尾';
  actions.append(listenButton, queueButton);

  listenButton.addEventListener('click', (event) => {
    event.stopPropagation();
    playFromList(list, absoluteIndex, { toggle: true });
  });
  queueButton.addEventListener('click', (event) => {
    event.stopPropagation();
    addToQueue(track);
  });
  card.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    playFromList(list, absoluteIndex);
  });

  card.append(top, body, actions);
  return card;
}

/* ------------------------- rename / delete dialogs ------------------------ */

function setModalError(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function setRenameBusy(busy) {
  els.renameSave.disabled = busy;
  els.renameInput.disabled = busy;
  els.renameCancel.disabled = busy;
  els.renameClose.disabled = busy;
  els.renameSave.textContent = busy ? '保存中…' : '保存';
}

function setDeleteBusy(busy) {
  els.deleteConfirm.disabled = busy;
  els.deleteCancel.disabled = busy;
  els.deleteClose.disabled = busy;
  els.deleteConfirm.textContent = busy ? '删除中…' : '删除';
}

function openRenameDialog(track) {
  if (!track || !els.renameDialog) return;
  editingTrackId = track.id;
  els.renameInput.value = track.title;
  setModalError(els.renameError, '');
  setRenameBusy(false);

  if (typeof els.renameDialog.showModal === 'function') {
    if (!els.renameDialog.open) els.renameDialog.showModal();
  } else {
    els.renameDialog.setAttribute('open', '');
  }

  requestAnimationFrame(() => {
    els.renameInput.focus();
    els.renameInput.select();
  });
}

function closeRenameDialog() {
  if (typeof els.renameDialog.close === 'function') els.renameDialog.close();
  else els.renameDialog.removeAttribute('open');
}

function openDeleteDialog(track) {
  if (!track || !els.deleteDialog) return;
  deletingTrackId = track.id;
  els.deleteTrackName.textContent = `《${track.title}》`;
  setModalError(els.deleteError, '');
  setDeleteBusy(false);

  if (typeof els.deleteDialog.showModal === 'function') {
    if (!els.deleteDialog.open) els.deleteDialog.showModal();
  } else {
    els.deleteDialog.setAttribute('open', '');
  }

  requestAnimationFrame(() => els.deleteCancel.focus());
}

function closeDeleteDialog() {
  if (typeof els.deleteDialog.close === 'function') els.deleteDialog.close();
  else els.deleteDialog.removeAttribute('open');
}

async function handleRenameSubmit(event) {
  event.preventDefault();
  const id = editingTrackId;
  if (!id) return;

  const title = els.renameInput.value.trim();
  if (!title) {
    setModalError(els.renameError, '歌名不能为空。');
    els.renameInput.focus();
    return;
  }
  if (title.length > 120) {
    setModalError(els.renameError, '歌名最多 120 个字符。');
    els.renameInput.focus();
    return;
  }

  setModalError(els.renameError, '');
  setRenameBusy(true);

  try {
    const updated = await renameTrack(id, title);
    const index = state.tracks.findIndex((track) => track.id === updated.id);
    if (index !== -1) state.tracks[index] = updated;
    if (player) player.updateTrack(updated);

    renderTracks();
    closeRenameDialog();
    showNotice(`已重命名为《${updated.title}》。`, 'success');
  } catch (error) {
    setModalError(els.renameError, error.message || '改名没有完成，请再试一次。');
  } finally {
    setRenameBusy(false);
  }
}

async function handleDeleteConfirm() {
  const id = deletingTrackId;
  if (!id || !player) return;

  const track = state.tracks.find((item) => item.id === id);
  if (!track) {
    closeDeleteDialog();
    return;
  }

  const wasCurrent = Boolean(player.current) && player.current.id === id;
  const wasPlaying = player.isPlaying;
  if (wasCurrent) player.pause();

  setModalError(els.deleteError, '');
  setDeleteBusy(true);

  try {
    await deleteTrack(id);
    state.tracks = state.tracks.filter((item) => item.id !== id);
    player.removeTrack(id, { autoplay: wasCurrent && wasPlaying });

    renderTracks();
    closeDeleteDialog();
    showNotice(`《${track.title}》已从岛上删除。`, 'success');
  } catch (error) {
    if (wasCurrent && wasPlaying) player.play();
    setModalError(
      els.deleteError,
      error.message || '删除没有完成，请稍后再试。'
    );
  } finally {
    setDeleteBusy(false);
  }
}

function bindTrackActions() {
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.card-more, .card-menu')) return;
    closeCardMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCardMenus();
  });

  els.renameForm.addEventListener('submit', handleRenameSubmit);
  [els.renameCancel, els.renameClose].forEach((button) => {
    button.addEventListener('click', closeRenameDialog);
  });

  [els.deleteCancel, els.deleteClose].forEach((button) => {
    button.addEventListener('click', closeDeleteDialog);
  });
  els.deleteConfirm.addEventListener('click', handleDeleteConfirm);

  [els.renameDialog, els.deleteDialog].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const busy =
        dialog === els.renameDialog ? els.renameSave.disabled : els.deleteConfirm.disabled;
      if (!busy) dialog.close();
    });
  });

  els.renameDialog.addEventListener('cancel', (event) => {
    if (els.renameSave.disabled) event.preventDefault();
  });
  els.deleteDialog.addEventListener('cancel', (event) => {
    if (els.deleteConfirm.disabled) event.preventDefault();
  });

  els.renameDialog.addEventListener('close', () => {
    editingTrackId = null;
    setRenameBusy(false);
    setModalError(els.renameError, '');
  });

  els.deleteDialog.addEventListener('close', () => {
    deletingTrackId = null;
    setDeleteBusy(false);
    setModalError(els.deleteError, '');
  });
}

function getPageSequence(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach((page) => pages.add(page));
  if (current >= total - 3) {
    [total - 4, total - 3, total - 2, total - 1].forEach((page) => pages.add(page));
  }

  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const sequence = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) sequence.push('…');
    sequence.push(page);
  });
  return sequence;
}

function renderPagination(totalPages) {
  els.pagination.replaceChildren();

  if (state.tracks.length === 0 || totalPages <= 1) {
    els.pagination.hidden = true;
    return;
  }

  els.pagination.hidden = false;

  const previous = button('page-btn', '', 'i-chevron');
  previous.classList.add('page-btn--prev');
  previous.setAttribute('aria-label', '上一页');
  previous.disabled = state.page === 1;
  previous.addEventListener('click', () => goToPage(state.page - 1));
  els.pagination.append(previous);

  getPageSequence(state.page, totalPages).forEach((entry) => {
    if (entry === '…') {
      const dots = element('span', 'page-ellipsis', '…');
      dots.setAttribute('aria-hidden', 'true');
      els.pagination.append(dots);
      return;
    }

    const pageButton = button('page-btn', String(entry));
    pageButton.setAttribute('aria-label', `第 ${entry} 页`);
    if (entry === state.page) {
      pageButton.classList.add('is-active');
      pageButton.setAttribute('aria-current', 'page');
    }
    pageButton.addEventListener('click', () => goToPage(entry));
    els.pagination.append(pageButton);
  });

  const next = button('page-btn', '', 'i-chevron');
  next.classList.add('page-btn--next');
  next.setAttribute('aria-label', '下一页');
  next.disabled = state.page === totalPages;
  next.addEventListener('click', () => goToPage(state.page + 1));
  els.pagination.append(next);
}

function goToPage(page) {
  const filtered = getFilteredTracks();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const nextPage = clamp(page, 1, totalPages);
  if (nextPage === state.page) return;

  state.page = nextPage;
  renderTracks();
  els.collection.scrollIntoView({
    behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth',
    block: 'start',
  });
}

/* -------------------------------- library --------------------------------- */

function renderTracks() {
  closeCardMenus();
  const filtered = getFilteredTracks();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  state.page = clamp(state.page, 1, totalPages);

  const pageStart = (state.page - 1) * PER_PAGE;
  const pageTracks = filtered.slice(pageStart, pageStart + PER_PAGE);

  els.trackCount.textContent = String(state.tracks.length);

  if (state.query.trim()) {
    els.resultSummary.textContent = `找到 ${filtered.length} 首 · 共 ${state.tracks.length} 首`;
  } else {
    els.resultSummary.textContent = `全部 ${state.tracks.length} 首`;
  }

  els.cardGrid.replaceChildren(
    ...pageTracks.map((track, index) =>
      createCard(track, pageStart + index, index, filtered)
    )
  );
  els.cardGrid.hidden = filtered.length === 0;
  els.cardGrid.removeAttribute('aria-busy');
  els.emptyState.hidden = filtered.length !== 0;

  if (filtered.length === 0) {
    if (state.loadFailed) {
      els.emptyTitle.textContent = '岛上的书架暂时打不开。';
      els.emptyText.textContent = '确认本地服务还在运行，然后刷新页面。';
    } else if (state.tracks.length === 0) {
      els.emptyTitle.textContent = '这座岛还在等第一个声音。';
      els.emptyText.textContent = '选一首 mp3 / wav / m4a，把喜欢的翻唱留在这里。';
    } else {
      els.emptyTitle.textContent = `没有找到「${state.query.trim()}」`;
      els.emptyText.textContent = '换一个词，或者把新的声音放上岛。';
    }
  }

  renderPagination(totalPages);
  syncPlayingCards();
}

async function loadTracks() {
  els.cardGrid.setAttribute('aria-busy', 'true');

  try {
    state.tracks = await fetchTracks();
    state.loadFailed = false;
  } catch (error) {
    state.loadFailed = true;
    state.tracks = [];
    console.error(error);
    showNotice(error.message || '没能读到岛上的收藏，请刷新页面再试。', 'error');
  }

  els.cardGrid.removeAttribute('aria-busy');
  renderTracks();
  if (!state.loadFailed) probeMissingDurations();
}

/* ------------------------------ duration probe ---------------------------- */

/** 用一个临时 Audio 探测时长，拿不到就返回 null */
function probeTrackDuration(url) {
  return new Promise((resolve) => {
    const probe = new Audio();
    probe.preload = 'metadata';

    const finish = (value) => {
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute('src');
      resolve(value);
    };

    probe.onloadedmetadata = () => {
      const duration = Number(probe.duration);
      finish(Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null);
    };
    probe.onerror = () => finish(null);

    probe.src = url;
  });
}

/**
 * 对没有 duration 的曲目并发（最多 4 个）探测时长，
 * 探测成功后经 PATCH 持久化；失败静默跳过，下次进页面再试。
 */
async function probeMissingDurations() {
  if (state.probingDurations) return;

  const pending = state.tracks.filter((track) => !(Number(track.duration) > 0));
  if (!pending.length) return;

  state.probingDurations = true;
  const queue = [...pending];

  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const track = queue.shift();
      const duration = await probeTrackDuration(track.url);
      if (!duration) continue;

      try {
        const updated = await updateTrackDuration(track.id, duration);
        const stored = state.tracks.find((item) => item.id === updated.id);
        if (stored) stored.duration = updated.duration;
        if (player) player.updateTrack(updated);

        // 只更新当前页面上那张卡片，避免整页重绘打断入场动画
        const node = els.cardGrid.querySelector(
          `.track-card[data-id="${CSS.escape(updated.id)}"] .card-duration`
        );
        if (node) {
          node.textContent = formatTime(updated.duration);
          node.hidden = false;
        }
      } catch {
        /* 持久化失败不影响本次显示之外的任何逻辑 */
      }
    }
  });

  await Promise.all(workers);
  state.probingDurations = false;
}

/* --------------------------------- search --------------------------------- */

function clearSearch({ focus = false } = {}) {
  clearTimeout(searchTimer);
  els.searchInput.value = '';
  els.searchClear.hidden = true;
  state.query = '';
  state.page = 1;
  renderTracks();
  if (focus) els.searchInput.focus();
}

function bindSearch() {
  els.searchInput.addEventListener('input', () => {
    const value = els.searchInput.value;
    els.searchClear.hidden = value.length === 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value;
      state.page = 1;
      renderTracks();
    }, 130);
  });

  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.searchInput.value) {
      event.preventDefault();
      clearSearch({ focus: true });
    }
  });

  els.searchClear.addEventListener('click', () => clearSearch({ focus: true }));

  document.addEventListener('keydown', (event) => {
    // 弹窗打开时不要触发空格播放、/ 搜索等页面快捷键；
    // 全屏播放页（data-allow-shortcuts）例外，页面快捷键在其中继续可用
    if (document.querySelector('dialog[open]:not([data-allow-shortcuts])')) return;

    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      Boolean(
        target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], [role="button"]'
        )
      );
    if (typing) return;

    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      els.searchInput.focus();
    }

    if (event.code === 'Space') {
      event.preventDefault();
      if (event.repeat) return;
      if (player) player.toggle();
    }
  });
}

/* --------------------------------- upload --------------------------------- */

function setUploadStatus(text) {
  clearTimeout(uploadStatusTimer);
  els.uploadStatus.textContent = text;
  els.uploadStatus.classList.toggle('is-active', Boolean(text));
}

function showUploadProgress() {
  els.uploadProgress.classList.add('is-active');
  els.uploadProgressFill.style.width = '0%';
  els.uploadProgress.setAttribute('aria-valuenow', '0');
}

/** 传入 0–1 的比例；进度条跟上传卡片同一套淡入淡出节奏 */
function setUploadProgress(ratio) {
  const percent = Math.round(clamp(ratio, 0, 1) * 100);
  els.uploadProgressFill.style.width = `${percent}%`;
  els.uploadProgress.setAttribute('aria-valuenow', String(percent));
}

function hideUploadProgress() {
  els.uploadProgress.classList.remove('is-active');
  // 等淡出过渡（0.25s）结束后再归零，避免看到回缩
  setTimeout(() => {
    if (!els.uploadProgress.classList.contains('is-active')) {
      els.uploadProgressFill.style.width = '0%';
      els.uploadProgress.setAttribute('aria-valuenow', '0');
    }
  }, 300);
}

function clearUploadStatusSoon(delay = 1600) {
  clearTimeout(uploadStatusTimer);
  uploadStatusTimer = setTimeout(() => setUploadStatus(''), delay);
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

async function handleFiles(fileList) {
  if (state.uploading) return;

  const files = Array.from(fileList || []);
  if (!files.length) return;

  const accepted = [];
  const problems = [];

  files.forEach((file) => {
    if (!SUPPORTED_EXTENSION.test(file.name)) {
      problems.push(`《${truncate(file.name, 34)}》不是 mp3 / wav / m4a 格式。`);
    } else if (file.size === 0) {
      problems.push(`《${truncate(file.name, 34)}》是空文件。`);
    } else {
      accepted.push(file);
    }
  });

  if (!accepted.length) {
    showNotice(summarizeProblems(problems), 'error');
    return;
  }

  state.uploading = true;
  els.dropzone.classList.add('is-busy');
  els.dropzone.setAttribute('aria-busy', 'true');
  els.fileInput.disabled = true;
  showUploadProgress();

  const uploaded = [];
  const failures = [...problems];

  try {
    for (let index = 0; index < accepted.length; index += 1) {
      const file = accepted[index];
      const counter = `${index + 1} / ${accepted.length}`;
      setUploadStatus(`正在把《${truncate(file.name, 24)}》放上岛… ${counter}`);
      setUploadProgress(0);

      try {
        // 批量上传时逐个显示「第 x / n 个 + 单文件百分比」
        const tracks = await uploadTrack(file, (loaded, total) => {
          const percent = Math.round((loaded / total) * 100);
          setUploadProgress(loaded / total);
          setUploadStatus(
            `正在把《${truncate(file.name, 24)}》放上岛… ${counter} · ${percent}%`
          );
        });
        setUploadProgress(1);
        uploaded.push(...tracks);
      } catch (error) {
        failures.push(error.message || `《${truncate(file.name, 34)}》上传失败。`);
      }
    }

    if (uploaded.length) {
      setUploadStatus('收藏好了，正在整理书架…');
      try {
        state.tracks = await fetchTracks();
        state.loadFailed = false;
        state.page = 1;
        // 刚上传的声音应该立刻被看见，先放下搜索条件
        state.query = '';
        els.searchInput.value = '';
        els.searchClear.hidden = true;
        renderTracks();
        probeMissingDurations();
      } catch (error) {
        failures.push(error.message || '列表刷新失败，请手动刷新页面。');
      }
    }

    if (uploaded.length && failures.length) {
      showNotice(
        `${uploaded.length} 段声音已收藏；${summarizeProblems(failures)}`,
        'error'
      );
    } else if (uploaded.length) {
      const message =
        uploaded.length === 1
          ? `《${truncate(uploaded[0].title, 34)}》已收藏到岛上。`
          : `${uploaded.length} 段声音已收藏到岛上。`;
      showNotice(message, 'success');
    } else {
      showNotice(summarizeProblems(failures), 'error');
    }

    if (uploaded.length) clearUploadStatusSoon();
    else setUploadStatus('');
    hideUploadProgress();
  } finally {
    state.uploading = false;
    els.dropzone.classList.remove('is-busy');
    els.dropzone.removeAttribute('aria-busy');
    els.fileInput.disabled = false;
    els.fileInput.value = '';
    dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
  }
}

function bindUpload() {
  els.dropzone.addEventListener('click', (event) => {
    if (state.uploading) return;
    if (event.target === els.fileInput) return;
    els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== els.dropzone) return;
    event.preventDefault();
    if (!state.uploading) els.fileInput.click();
  });

  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files && els.fileInput.files.length) {
      handleFiles(els.fileInput.files);
    }
  });

  els.dropzone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (!state.uploading) els.dropzone.classList.add('is-dragging');
  });

  els.dropzone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.uploading ? 'none' : 'copy';
  });

  els.dropzone.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    if (event.relatedTarget && els.dropzone.contains(event.relatedTarget)) return;
    dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
  });

  els.dropzone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
    if (!state.uploading) handleFiles(event.dataTransfer.files);
  });

  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });

  window.addEventListener('drop', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
}

/* ------------------------------ misc bindings ----------------------------- */

function bindNotice() {
  els.noticeClose.addEventListener('click', hideNotice);
}

function boot() {
  player = new Player({
    onNotice: showNotice,
    onChange: syncPlayingCards,
    getFallbackQueue: getFilteredTracks,
  });

  initTheme();
  bindNotice();
  bindSearch();
  bindUpload();
  bindTrackActions();
  loadTracks();
}

boot();

'use strict';

import { formatSize, formatTime, formatUploadDate, initialOf, toneFor } from './utils.js';

const MODE_ORDER = ['sequence', 'one', 'list', 'shuffle'];
const MODE_LABELS = {
  sequence: '顺序播放',
  one: '单曲循环',
  list: '列表循环',
  shuffle: '随机播放',
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SPEED_LABELS = {
  0.5: '0.5×',
  0.75: '0.75×',
  1: '1.0×',
  1.25: '1.25×',
  1.5: '1.5×',
  1.75: '1.75×',
  2: '2.0×',
};

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Fisher-Yates 洗牌，随机播放用它重建候选池 */
function shuffleList(list) {
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 页面底部常驻播放器。持有唯一的 <audio>，因此天然互斥。
 */
export class Player {
  constructor({ onNotice, onChange, getFallbackQueue } = {}) {
    this.onNotice = typeof onNotice === 'function' ? onNotice : () => {};
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.getFallbackQueue = typeof getFallbackQueue === 'function' ? getFallbackQueue : () => [];

    this.audio = document.getElementById('audio-element');
    this.el = {
      player: document.getElementById('player'),
      discLabel: document.querySelector('.player-disc-label'),
      initial: document.getElementById('player-initial'),
      title: document.getElementById('player-title'),
      sub: document.getElementById('player-sub'),
      playMain: document.getElementById('play-main'),
      playIcon: document.getElementById('play-icon-use'),
      prev: document.getElementById('player-prev'),
      next: document.getElementById('player-next'),
      loop: document.getElementById('loop-toggle'),
      queueToggle: document.getElementById('queue-toggle'),
      queueCount: document.getElementById('queue-count'),
      seek: document.getElementById('seek'),
      timeCurrent: document.getElementById('time-current'),
      timeTotal: document.getElementById('time-total'),
      speedWrap: document.querySelector('.speed-wrap'),
      speedToggle: document.getElementById('speed-toggle'),
      speedLabel: document.getElementById('speed-label'),
      speedMenu: document.getElementById('speed-menu'),
      volume: document.getElementById('volume'),
      mute: document.getElementById('mute-toggle'),
      volumeIcon: document.getElementById('volume-icon-use'),
      queuePanel: document.getElementById('queue-panel'),
      queueList: document.getElementById('queue-list'),
      queueEmpty: document.getElementById('queue-empty'),
      queueTotal: document.getElementById('queue-total'),
      queueClose: document.getElementById('queue-close'),
      waveCanvas: document.getElementById('wave-canvas'),
    };

    this.queue = [];
    this.index = -1;
    this.mode = MODE_ORDER.includes(readStored('isle-loop', 'list')) ? readStored('isle-loop', 'list') : 'list';
    // 随机播放的候选池：本轮未播放过的曲目下标，取空后重新洗牌
    this._shufflePool = [];

    const storedSpeed = Number(readStored('isle-speed', '1'));
    this.speed = SPEEDS.includes(storedSpeed) ? storedSpeed : 1;

    const storedVolume = Number(readStored('isle-volume', '0.8'));
    this.volume = Number.isFinite(storedVolume) ? clamp(storedVolume, 0, 1) : 0.8;
    this.lastVolume = this.volume > 0 ? this.volume : 0.8;
    this.muted = false;

    this.speedMenuOpen = false;
    this.queueOpen = false;
    this.isSeeking = false;
    this._errorTrackId = null;
    this._ready = false;

    // 波形可视化（Web Audio），音频图要等第一次用户手势播放时才建立
    this._audioCtx = null;
    this._analyser = null;
    this._freqData = null;
    this._wave2d = null;
    this._waveRaf = 0;
    this._waveColors = null;
    this._waveGradient = null;
    this._waveInitFailed = false;
    this._waveReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // 「正在播放」全屏详情页；元素缺失时相关功能整体静默降级
    this.np = {
      dialog: document.getElementById('now-playing-dialog'),
      trigger: document.getElementById('player-disc-btn'),
      close: document.getElementById('np-close'),
      title: document.getElementById('np-title'),
      sub: document.getElementById('np-sub'),
      discPlay: document.getElementById('np-disc-btn'),
      label: document.getElementById('np-disc-label'),
      meta: document.getElementById('np-meta'),
      seek: document.getElementById('np-seek'),
      timeCurrent: document.getElementById('np-time-current'),
      timeTotal: document.getElementById('np-time-total'),
      prev: document.getElementById('np-prev'),
      play: document.getElementById('np-play'),
      playIcon: document.getElementById('np-play-icon'),
      next: document.getElementById('np-next'),
    };
    this.npAvailable = Boolean(this.np.dialog && this.np.trigger);
    // 拖动来源：主播放器进度条或全屏页进度条
    this._seekSource = 'main';

    this.bindEvents();
    this.applyPreferences();
    this.renderAll();
    this.setupWave();
    this._ready = true;
  }

  get current() {
    return this.index >= 0 ? this.queue[this.index] || null : null;
  }

  get isPlaying() {
    return Boolean(this.current) && !this.audio.paused && !this.audio.ended;
  }

  /* ------------------------------ audio core ----------------------------- */

  setQueue(tracks, startIndex = 0, autoplay = true) {
    const list = Array.isArray(tracks) ? tracks.filter((track) => track && track.url) : [];
    this.queue = list;
    this.index = list.length ? clamp(Number(startIndex) || 0, 0, list.length - 1) : -1;
    this._shufflePool = [];
    this.renderQueue();

    if (!list.length) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.renderTrack();
      this.renderProgress();
      this.renderPlayingState();
      this.drawWave();
      return;
    }

    this.load(this.queue[this.index], Boolean(autoplay));
  }

  enqueue(track) {
    if (!track || !track.id) return false;
    if (this.queue.some((item) => item.id === track.id)) return false;

    this.queue.push(track);
    this._shufflePool = [];

    if (!this.current) {
      this.index = 0;
      this.load(track, false);
    } else {
      this.renderQueue();
    }
    return true;
  }

  updateTrack(track) {
    if (!track || !track.id) return;
    const queued = this.queue.find((item) => item.id === track.id);
    if (!queued) return;

    const wasCurrent = Boolean(this.current) && this.current.id === track.id;
    Object.assign(queued, track);
    if (wasCurrent) this.renderTrack();
    this.renderQueue();
  }

  removeTrack(id, { autoplay = false } = {}) {
    const removeIndex = this.queue.findIndex((item) => item.id === id);
    if (removeIndex === -1) return false;

    const wasCurrent = removeIndex === this.index;
    this.queue.splice(removeIndex, 1);
    this._shufflePool = [];

    if (this.queue.length === 0) {
      this.index = -1;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.renderTrack();
      this.renderProgress();
      this.renderPlayingState();
      this.renderQueue();
      this.drawWave();
      return true;
    }

    if (wasCurrent) {
      this.index = Math.min(removeIndex, this.queue.length - 1);
      this.load(this.queue[this.index], Boolean(autoplay));
      this.renderQueue();
    } else {
      if (removeIndex < this.index) this.index -= 1;
      this.renderQueue();
    }

    return true;
  }

  playAt(index) {
    if (!this.queue.length || index < 0 || index >= this.queue.length) return;
    if (index === this.index) {
      this.toggle();
      return;
    }
    this.index = index;
    this.load(this.queue[index], true);
    this.renderQueue();
  }

  load(track, autoplay) {
    if (!track) return;
    this._errorTrackId = null;

    this.audio.pause();
    this.audio.src = track.url;
    this.audio.load();
    this.audio.playbackRate = this.speed;
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;

    this.renderTrack();
    this.renderProgress();
    this.renderPlayingState();

    if (autoplay) this.play();
  }

  play() {
    const track = this.current;
    if (!track) {
      this.playFallback();
      return;
    }

    // 音频图只能在用户手势驱动的播放里创建，否则会被浏览器自动播放策略拦截
    this.ensureAudioGraph();
    if (this.audio.ended) this.audio.currentTime = 0;

    const result = this.audio.play();
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        if (!error) return;
        if (error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') {
          this.onNotice('浏览器拦住了这次播放，再点一次播放键试试。', 'info');
          return;
        }
        this.onNotice(`《${track.title}》没能播放，确认文件还在 audio 文件夹里。`, 'error');
        this.renderPlayingState();
      });
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (!this.current) {
      this.playFallback();
      return;
    }
    if (this.audio.paused) this.play();
    else this.pause();
  }

  playFallback() {
    const list = this.getFallbackQueue();
    if (!Array.isArray(list) || list.length === 0) {
      this.onNotice('还没有可以播放的声音，上传一首或清空搜索再试。', 'info');
      return;
    }
    this.setQueue(list, 0, true);
  }

  next() {
    if (!this.queue.length) return;

    if (this.index >= this.queue.length - 1) {
      if (this.mode === 'list') {
        this.index = 0;
        this.load(this.queue[0], true);
        this.renderQueue();
      } else {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.renderProgress();
        this.renderPlayingState();
      }
      return;
    }

    this.index += 1;
    this.load(this.queue[this.index], true);
    this.renderQueue();
  }

  previous() {
    if (!this.queue.length) return;

    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      this.renderProgress();
      return;
    }

    if (this.index <= 0) {
      if (this.mode === 'list') {
        this.index = this.queue.length - 1;
        this.load(this.queue[this.index], true);
        this.renderQueue();
      } else {
        this.audio.currentTime = 0;
        this.renderProgress();
      }
      return;
    }

    this.index -= 1;
    this.load(this.queue[this.index], true);
    this.renderQueue();
  }

  handleEnded() {
    if (!this.queue.length) return;

    if (this.mode === 'one') {
      this.audio.currentTime = 0;
      this.play();
      return;
    }

    if (this.mode === 'shuffle') {
      this.playShuffleNext();
      return;
    }

    if (this.index < this.queue.length - 1) {
      this.index += 1;
      this.load(this.queue[this.index], true);
      this.renderQueue();
      return;
    }

    if (this.mode === 'list') {
      this.index = 0;
      this.load(this.queue[0], true);
      this.renderQueue();
      return;
    }

    // 顺序播放：停在最后一首的结尾
    this.audio.currentTime = 0;
    this.renderProgress();
    this.renderPlayingState();
  }

  /** 随机播放：从本轮未播过的曲目里取一首，取完重新洗牌 */
  playShuffleNext() {
    if (!this._shufflePool.length) {
      const rest = this.queue.map((_, index) => index).filter((index) => index !== this.index);
      this._shufflePool = shuffleList(rest);
    }

    if (!this._shufflePool.length) {
      // 队列里只有当前这一首，直接重播
      this.load(this.queue[this.index], true);
      return;
    }

    const nextIndex = this._shufflePool.pop();
    this.index = nextIndex;
    this.load(this.queue[nextIndex], true);
    this.renderQueue();
  }

  /* ------------------------------- seeking ------------------------------- */

  beginSeek(source = 'main') {
    this.isSeeking = true;
    this._seekSource = source;
  }

  /** 拖动结束后才真正 seek，避免与 timeupdate 的进度回写互相打架 */
  endSeek() {
    if (!this.isSeeking) return;
    this.isSeeking = false;
    const source = this._seekSource === 'np' && this.np.seek ? this.np : this.el;
    this.seekToRatio(Number(source.seek.value) / 1000);
  }

  seekToRatio(ratio) {
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const next = clamp(Number(ratio) || 0, 0, 1);
    this.audio.currentTime = next * duration;
    this.updateProgressUI(next, duration);
  }

  /* -------------------------------- modes -------------------------------- */

  cycleMode() {
    const position = MODE_ORDER.indexOf(this.mode);
    this.mode = MODE_ORDER[(position + 1) % MODE_ORDER.length];
    store('isle-loop', this.mode);
    this.renderMode();
  }

  setSpeed(value) {
    const speed = Number(value);
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    this.audio.playbackRate = speed;
    store('isle-speed', speed);
    this.renderSpeed();
    this.setSpeedMenu(false);
  }

  setVolume(value) {
    const volume = clamp(Number(value) || 0, 0, 1);
    this.volume = volume;
    if (volume > 0) this.lastVolume = volume;
    this.muted = false;
    this.audio.volume = volume;
    this.audio.muted = false;
    store('isle-volume', volume);
    this.renderVolume();
  }

  toggleMute() {
    if (this.muted || this.audio.volume === 0) {
      this.muted = false;
      this.audio.muted = false;
      if (this.volume === 0) this.volume = this.lastVolume || 0.8;
      this.audio.volume = this.volume;
      store('isle-volume', this.volume);
    } else {
      this.lastVolume = this.volume;
      this.muted = true;
      this.audio.muted = true;
    }
    this.renderVolume();
  }

  /* -------------------------------- panels ------------------------------- */

  setSpeedMenu(open) {
    const next = Boolean(open);
    this.speedMenuOpen = next;
    this.el.speedMenu.hidden = !next;
    this.el.speedToggle.setAttribute('aria-expanded', String(next));
    if (next) this.toggleQueue(false);
  }

  toggleQueue(force) {
    const next = typeof force === 'boolean' ? force : !this.queueOpen;
    this.queueOpen = next;
    this.el.queuePanel.hidden = !next;
    this.el.queueToggle.setAttribute('aria-expanded', String(next));
    if (next) {
      this.setSpeedMenu(false);
      this.renderQueue();
    }
  }

  /* ----------------------------- now playing ----------------------------- */

  openNowPlaying() {
    const np = this.np;
    if (!this.npAvailable || typeof np.dialog.showModal !== 'function') return;
    np.trigger.setAttribute('aria-expanded', 'true');
    this.renderNowPlaying();
    np.dialog.showModal();
    // 把焦点交给大唱片：空格键落在它身上即播放/暂停，关闭后原生焦点仍归还唱片按钮
    if (np.discPlay) np.discPlay.focus();
  }

  closeNowPlaying() {
    const np = this.np;
    if (!this.npAvailable || !np.dialog.open) return;
    np.trigger.setAttribute('aria-expanded', 'false');
    np.dialog.close();
    // 焦点由 dialog 原生归还给唱片按钮
  }

  /* -------------------------------- events ------------------------------- */

  bindEvents() {
    this.el.playMain.addEventListener('click', () => this.toggle());
    this.el.prev.addEventListener('click', () => this.previous());
    this.el.next.addEventListener('click', () => this.next());
    this.el.loop.addEventListener('click', () => this.cycleMode());
    this.el.queueToggle.addEventListener('click', () => this.toggleQueue());
    this.el.queueClose.addEventListener('click', () => {
      this.toggleQueue(false);
      this.el.queueToggle.focus();
    });

    // 拖动中只更新进度 UI，松手（pointerup / change / blur）时才真正 seek
    this.el.seek.addEventListener('pointerdown', () => this.beginSeek());
    this.el.seek.addEventListener('keydown', () => this.beginSeek());
    this.el.seek.addEventListener('pointerup', () => this.endSeek());
    this.el.seek.addEventListener('change', () => this.endSeek());
    this.el.seek.addEventListener('blur', () => this.endSeek());

    this.el.seek.addEventListener('input', (event) => {
      const ratio = Number(event.target.value) / 1000;
      if (this.isSeeking) {
        this.updateProgressUI(ratio, this.audio.duration);
        return;
      }
      this.seekToRatio(ratio);
    });

    this.el.volume.addEventListener('input', (event) => {
      this.setVolume(Number(event.target.value) / 100);
    });
    this.el.mute.addEventListener('click', () => this.toggleMute());

    this.el.speedToggle.addEventListener('click', () => this.setSpeedMenu(!this.speedMenuOpen));
    this.el.speedMenu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-speed]');
      if (option) this.setSpeed(Number(option.dataset.speed));
    });

    this.audio.addEventListener('loadedmetadata', () => this.renderProgress());
    this.audio.addEventListener('durationchange', () => this.renderProgress());
    this.audio.addEventListener('timeupdate', () => this.renderProgress());
    this.audio.addEventListener('play', () => {
      this.renderPlayingState();
      this.startWaveLoop();
    });
    this.audio.addEventListener('pause', () => {
      this.renderPlayingState();
      this.fadeWave();
    });
    this.audio.addEventListener('ended', () => {
      this.handleEnded();
      // 顺序播到队尾等没有续上的播放时，让波形停在末帧
      if (!this.isPlaying) this.fadeWave();
    });
    this.audio.addEventListener('error', () => {
      if (!this.current || this._errorTrackId === this.current.id) return;
      this._errorTrackId = this.current.id;
      this.onNotice(`《${this.current.title}》播放失败，文件可能已经被移动或删除。`, 'error');
      this.renderPlayingState();
    });

    document.addEventListener('pointerdown', (event) => {
      if (this.speedMenuOpen && !this.el.speedWrap.contains(event.target)) {
        this.setSpeedMenu(false);
      }
      if (
        this.queueOpen &&
        !this.el.queuePanel.contains(event.target) &&
        !this.el.queueToggle.contains(event.target)
      ) {
        this.toggleQueue(false);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.queueOpen) {
        this.toggleQueue(false);
        this.el.queueToggle.focus();
      } else if (this.speedMenuOpen) {
        this.setSpeedMenu(false);
        this.el.speedToggle.focus();
      }
    });

    if (this.npAvailable) this.bindNowPlayingEvents();
  }

  /** 「正在播放」全屏页的事件绑定：只在元素齐全时调用 */
  bindNowPlayingEvents() {
    const np = this.np;

    np.trigger.addEventListener('click', () => this.openNowPlaying());
    np.close.addEventListener('click', () => this.closeNowPlaying());

    np.dialog.addEventListener('click', (event) => {
      // 点遮罩关闭：只有落在 dialog 自身（而非内容）上的点击才算
      if (event.target === np.dialog) this.closeNowPlaying();
    });
    np.dialog.addEventListener('close', () => {
      // Esc 等原生关闭途径的兜底：同步触发按钮的展开态
      np.trigger.setAttribute('aria-expanded', 'false');
    });

    np.discPlay.addEventListener('click', () => this.toggle());
    np.play.addEventListener('click', () => this.toggle());
    np.prev.addEventListener('click', () => this.previous());
    np.next.addEventListener('click', () => this.next());

    // 与主播放器同一套 isSeeking 标志：拖动中只更新 UI，松手才 seek
    np.seek.addEventListener('pointerdown', () => this.beginSeek('np'));
    np.seek.addEventListener('keydown', () => this.beginSeek('np'));
    np.seek.addEventListener('pointerup', () => this.endSeek());
    np.seek.addEventListener('change', () => this.endSeek());
    np.seek.addEventListener('blur', () => this.endSeek());

    np.seek.addEventListener('input', (event) => {
      const ratio = Number(event.target.value) / 1000;
      if (this.isSeeking) {
        this.updateProgressUI(ratio, this.audio.duration);
        return;
      }
      this.seekToRatio(ratio);
    });
  }

  applyPreferences() {
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
    this.audio.playbackRate = this.speed;
  }

  /* ------------------------------- rendering ----------------------------- */

  renderAll() {
    this.renderTrack();
    this.renderProgress();
    this.renderPlayingState();
    this.renderMode();
    this.renderSpeed();
    this.renderVolume();
    this.renderQueue();
  }

  renderTrack() {
    const track = this.current;
    this.el.player.dataset.empty = track ? 'false' : 'true';

    if (track) {
      this.el.title.textContent = track.title;
      this.el.title.title = track.filename || track.title;
      this.el.sub.textContent = `上传于 ${formatUploadDate(track.uploadedAt)}`;
      this.el.initial.textContent = initialOf(track.title);
      this.el.discLabel.className = `player-disc-label ${toneFor(track.title)}`;
    } else {
      this.el.title.textContent = '还没有播放任何声音';
      this.el.title.title = '';
      this.el.sub.textContent = '从卡片里挑一首，或先放一段声音上岛';
      this.el.initial.textContent = '◦';
      this.el.discLabel.className = 'player-disc-label tone-a';
    }

    this.syncNowPlayingGlow();
    this.renderNowPlaying();
    this.updateDocumentTitle();
  }

  /** 读取当前唱片标签的计算色，供全屏页背景光晕使用 */
  syncNowPlayingGlow() {
    const np = this.np;
    if (!this.npAvailable || !this.el.discLabel) return;
    const color = getComputedStyle(this.el.discLabel).backgroundColor;
    np.dialog.style.setProperty('--np-glow', color || 'transparent');
  }

  /** 全屏详情页的文本与唱片标签；进度部分由 updateProgressUI 负责 */
  renderNowPlaying() {
    const np = this.np;
    if (!this.npAvailable) return;
    const track = this.current;

    if (track) {
      np.title.textContent = track.title;
      np.title.title = track.filename || track.title;
      np.sub.textContent = track.filename || '';
      const extension = (track.extension || '').toUpperCase();
      np.meta.textContent = [
        `上传于 ${formatUploadDate(track.uploadedAt)}`,
        extension,
        formatSize(track.size),
      ]
        .filter(Boolean)
        .join(' · ');
      np.label.textContent = initialOf(track.title);
      np.label.className = `np-disc-label ${toneFor(track.title)}`;
    } else {
      np.title.textContent = '还没有播放任何声音';
      np.title.title = '';
      np.sub.textContent = '';
      np.meta.textContent = '回到卡片列表挑一首，或先上传一段声音。';
      np.label.textContent = '◦';
      np.label.className = 'np-disc-label tone-a';
    }
  }

  renderPlayingState() {
    const playing = this.isPlaying;
    this.el.player.classList.toggle('is-playing', playing);
    this.el.playMain.setAttribute('aria-label', playing ? '暂停' : '播放');
    this.el.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');

    if (this.npAvailable) {
      // 大唱片旋转由 .now-playing.is-playing 控制，暂停停在原角度
      this.np.dialog.classList.toggle('is-playing', playing);
      this.np.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
      this.np.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    }

    this.renderNowPlaying();
    this.updateDocumentTitle();

    if (this._ready) this.onChange();
  }

  renderProgress() {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    const current = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    const ratio = duration > 0 ? clamp(current / duration, 0, 1) : 0;
    this.updateProgressUI(ratio, duration);
    this.renderNowPlaying();
  }

  updateProgressUI(ratio, duration) {
    const cleanRatio = clamp(Number(ratio) || 0, 0, 1);
    this.applySeekUI(this.el.seek, this.el.timeCurrent, this.el.timeTotal, cleanRatio, duration);
    if (this.npAvailable) {
      this.applySeekUI(this.np.seek, this.np.timeCurrent, this.np.timeTotal, cleanRatio, duration);
    }
  }

  /** 单条进度 UI：拖动过程中不回写 seek.value，否则会和用户的手指互相拉扯 */
  applySeekUI(seekEl, currentEl, totalEl, ratio, duration) {
    if (!seekEl) return;
    if (!this.isSeeking) {
      seekEl.value = String(Math.round(ratio * 1000));
    }
    seekEl.style.setProperty('--seek', `${(ratio * 100).toFixed(2)}%`);
    if (currentEl) currentEl.textContent = formatTime(ratio * (Number(duration) || 0));
    if (totalEl) totalEl.textContent = formatTime(duration);
    seekEl.disabled = !this.current || !(Number(duration) > 0);
  }

  renderMode() {
    const label = MODE_LABELS[this.mode];
    this.el.loop.dataset.mode = this.mode;
    this.el.loop.title = `循环模式：${label}（点击切换）`;
    this.el.loop.setAttribute('aria-label', `循环模式：${label}，点击切换`);
  }

  renderSpeed() {
    this.el.speedLabel.textContent = SPEED_LABELS[this.speed] || `${this.speed}×`;
    this.el.speedMenu.querySelectorAll('[data-speed]').forEach((button) => {
      button.setAttribute('aria-checked', String(Number(button.dataset.speed) === this.speed));
    });
  }

  renderVolume() {
    const percent = Math.round(this.volume * 100);
    this.el.volume.value = String(percent);
    this.el.volume.style.setProperty('--volume', `${percent}%`);

    let icon = '#i-volume';
    if (this.muted || percent === 0) icon = '#i-mute';
    else if (percent < 45) icon = '#i-volume-low';

    this.el.volumeIcon.setAttribute('href', icon);
    this.el.mute.setAttribute('aria-label', this.muted ? '取消静音' : '静音');
    this.el.mute.title = this.muted ? '取消静音' : '静音';
  }

  renderQueue() {
    const total = this.queue.length;
    this.el.queueCount.textContent = String(total);
    this.el.queueTotal.textContent = String(total);
    this.el.queueEmpty.hidden = total > 0;
    this.el.queueList.hidden = total === 0;

    const fragment = document.createDocumentFragment();

    this.queue.forEach((track, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'queue-item';
      if (index === this.index) {
        button.classList.add('is-current');
        button.setAttribute('aria-current', 'true');
      }
      button.setAttribute('aria-label', `播放《${track.title}》`);

      const number = document.createElement('span');
      number.className = 'queue-num';
      number.textContent = String(index + 1).padStart(2, '0');

      const text = document.createElement('span');
      text.className = 'queue-item-text';

      const title = document.createElement('span');
      title.className = 'queue-item-title';
      title.textContent = track.title;
      title.title = track.filename || track.title;

      const meta = document.createElement('span');
      meta.className = 'queue-item-meta';
      const extension = (track.extension || '').toUpperCase();
      meta.textContent = [extension, formatSize(track.size)].filter(Boolean).join(' · ');

      text.append(title, meta);
      button.append(number, text);
      button.addEventListener('click', () => this.playAt(index));

      item.append(button);
      fragment.append(item);
    });

    this.el.queueList.replaceChildren(fragment);
  }

  updateDocumentTitle() {
    const track = this.current;
    document.title = track
      ? `${this.isPlaying ? '▶ ' : ''}${track.title} · Isle of Echoes`
      : 'Isle of Echoes · 回声之岛';
  }

  /* --------------------------- wave visualization -------------------------- */

  /**
   * 画布自身的初始化不依赖音频图：拿到 2D 上下文、读主题色、跟随尺寸变化。
   * AudioContext 建立失败时画布保持隐藏，不影响任何播放功能。
   */
  setupWave() {
    const canvas = this.el.waveCanvas;
    if (!canvas) return;

    this._wave2d = canvas.getContext('2d');
    if (!this._wave2d) {
      canvas.hidden = true;
      return;
    }

    this._waveColors = this.readWaveColors();

    // 播放器宽度变化（含移动端布局断点）时重设画布像素尺寸
    if (typeof ResizeObserver === 'function') {
      this._waveResize = new ResizeObserver(() => this.resizeWave());
      this._waveResize.observe(canvas);
    } else {
      window.addEventListener('resize', () => this.resizeWave());
    }

    // 深浅色切换后重读主题变量并重绘
    if (typeof MutationObserver === 'function') {
      this._waveThemeObserver = new MutationObserver(() => {
        this._waveColors = this.readWaveColors();
        this._waveGradient = null;
        this.drawWave();
      });
      this._waveThemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    }

    this.resizeWave();
  }

  readWaveColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      accent: styles.getPropertyValue('--accent').trim(),
      accentStrong: styles.getPropertyValue('--accent-strong').trim(),
      lineStrong: styles.getPropertyValue('--line-strong').trim(),
    };
  }

  /** canvas 像素尺寸 = CSS 尺寸 × devicePixelRatio，再统一缩放到 CSS 坐标系 */
  resizeWave() {
    const canvas = this.el.waveCanvas;
    if (!canvas || canvas.hidden || !this._wave2d) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    this._wave2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._waveGradient = null;
    this.drawWave();
  }

  /**
   * 惰性建立音频图 source -> analyser -> destination。
   * createMediaElementSource 每页只允许调用一次；audio.src 切换不影响已建立的连接。
   * 不给 audio 设置 crossOrigin：同源无需，服务端也没配 CORS。
   */
  ensureAudioGraph() {
    if (this._audioCtx || this._waveInitFailed) return;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
      this.failWaveCanvas();
      return;
    }

    try {
      const ctx = new AudioCtor();
      const source = ctx.createMediaElementSource(this.audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyser.connect(ctx.destination);

      this._audioCtx = ctx;
      this._analyser = analyser;
      this._freqData = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      this.failWaveCanvas();
      return;
    }

    // 用户手势里顺手解锁可能被挂起的上下文
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
  }

  /** 音频图不可用：静默降级，隐藏画布 */
  failWaveCanvas() {
    this._waveInitFailed = true;
    if (this.el.waveCanvas) this.el.waveCanvas.hidden = true;
  }

  startWaveLoop() {
    if (!this._analyser || !this._wave2d) return;

    // 尊重系统「减少动态效果」：只画一帧静态图形
    if (this._waveReducedMotion.matches) {
      this._analyser.getByteFrequencyData(this._freqData);
      this.drawWave();
      return;
    }

    cancelAnimationFrame(this._waveRaf);
    const step = () => {
      this._analyser.getByteFrequencyData(this._freqData);
      this.drawWave(0.85);
      this._waveRaf = requestAnimationFrame(step);
    };
    step();
  }

  /** 暂停时保留最后一帧并渐隐 */
  fadeWave() {
    if (!this._analyser || !this._wave2d) return;

    cancelAnimationFrame(this._waveRaf);
    this._waveRaf = 0;

    if (this._waveReducedMotion.matches) {
      this.drawWave();
      return;
    }

    let alpha = 0.85;
    const fade = () => {
      alpha = Math.max(0.2, alpha - 0.06);
      this.drawWave(alpha);
      this._waveRaf = alpha > 0.2 ? requestAnimationFrame(fade) : 0;
    };
    fade();
  }

  /** 单帧绘制：没有曲目（或还没建立音频图）时画一条静态细线 */
  drawWave(alpha = 0.85) {
    const canvas = this.el.waveCanvas;
    if (!canvas || canvas.hidden || !this._wave2d) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const ctx = this._wave2d;
    ctx.clearRect(0, 0, width, height);

    if (!this.current || !this._analyser) {
      ctx.fillStyle = this._waveColors.lineStrong;
      ctx.fillRect(0, Math.round(height / 2), width, 1);
      return;
    }

    this.drawWaveBars(ctx, width, height, alpha);
  }

  /** 居中的镜像圆角竖条，两端高度衰减 */
  drawWaveBars(ctx, width, height, alpha) {
    if (!this._waveGradient) {
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, this._waveColors.accent);
      gradient.addColorStop(1, this._waveColors.accentStrong);
      this._waveGradient = gradient;
    }

    const bars = clamp(Math.floor(width / 10), 48, 64);
    const slot = width / bars;
    const barWidth = Math.max(1.5, slot * 0.6);
    const mid = height / 2;
    const binCount = this._analyser.frequencyBinCount;
    const data = this._freqData;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = this._waveGradient;

    for (let i = 0; i < bars; i += 1) {
      // 平方分布取样，让低频段占更多竖条，观感更接近音乐本身
      const start = Math.floor(((i / bars) ** 2) * binCount);
      const end = Math.max(start + 1, Math.floor((((i + 1) / bars) ** 2) * binCount));
      let sum = 0;
      let count = 0;
      for (let bin = start; bin < end && bin < binCount; bin += 1) {
        sum += data[bin];
        count += 1;
      }
      const value = count ? sum / count / 255 : 0;

      // 两端衰减
      const taper = 0.3 + 0.7 * Math.sin((Math.PI * (i + 0.5)) / bars) ** 0.6;
      const barHeight = Math.max(2, value * taper * (height - 4));
      const x = i * slot + (slot - barWidth) / 2;
      const y = mid - barHeight / 2;
      const radius = Math.min(barWidth / 2, barHeight / 2);

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, barWidth, barHeight, radius);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
}

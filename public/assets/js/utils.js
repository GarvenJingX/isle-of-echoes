'use strict';

/** 上传时间：2026.11.11 · 22:15（浏览器本地时区） */
export function formatUploadDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} · ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** 播放器时间：0:00 / 1:02:03 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size <= 0) return '—';
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 唱片中心的那个字 */
export function initialOf(title) {
  const clean = String(title || '').trim();
  if (!clean) return '♪';
  const first = Array.from(clean)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

const TONES = ['tone-a', 'tone-b', 'tone-c', 'tone-d'];

/** 根据歌名稳定地挑一种低饱和唱片标签色 */
export function toneFor(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  }
  return TONES[hash % TONES.length];
}

export function truncate(text, max = 26) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

'use strict';

const path = require('node:path');

/** 允许收藏的声音格式 */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a']);

const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 浏览器在 multipart 中按 UTF-8 发送文件名。旧版解析器若按 latin1 解码，
 * 中文会变成「æµ·」这样的乱码；这里做一次可逆修复，正常文件名原样返回。
 */
function repairMojibake(name) {
  if (typeof name !== 'string' || !name) return '';
  // 已经含有 CJK 字符，说明解码正确，不需要修复
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(name)) return name;

  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return name;
    const gainedCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(decoded);
    const looksMojibake = /[\u00c0-\u00ff]/.test(name);
    if (gainedCjk && looksMojibake) return decoded;
  } catch {
    /* 保持原样 */
  }
  return name;
}

/** 去掉路径、控制字符与 Windows 非法字符，保留中文与空格 */
function sanitizeFilename(rawName) {
  let name = repairMojibake(String(rawName || ''));
  name = name.replace(/\\/g, '/');
  name = path.posix.basename(name);
  name = name.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[<>:"/\\|?*]/g, '-');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');

  const extension = path.extname(name).toLowerCase();
  let base = extension ? name.slice(0, -extension.length) : name;
  base = base.replace(/^[.\s]+|[.\s]+$/g, '');

  if (!base) base = 'untitled';
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (base.length > 140) base = base.slice(0, 140).trim();

  return `${base}${extension}`;
}

function extensionOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function isSupportedAudio(filename) {
  return AUDIO_EXTENSIONS.has(extensionOf(filename));
}

function mimeFor(filename) {
  return MIME_BY_EXTENSION[extensionOf(filename)] || 'application/octet-stream';
}

module.exports = {
  AUDIO_EXTENSIONS,
  extensionOf,
  isSupportedAudio,
  mimeFor,
  repairMojibake,
  sanitizeFilename,
};

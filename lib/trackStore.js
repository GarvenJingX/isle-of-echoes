'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 以 JSON 文件为唯一数据源，内存中保留一份排序后的副本。
 * 所有写入串行执行，并先写临时文件再原子替换，避免断电/并发导致 JSON 损坏。
 */
class TrackStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tracks = [];
    this.writeChain = Promise.resolve();
    this.ready = false;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.tracks;
      this.tracks = (Array.isArray(list) ? list : [])
        .filter(
          (track) =>
            track &&
            typeof track.id === 'string' &&
            typeof track.filename === 'string' &&
            typeof track.uploadedAt === 'string'
        )
        .map((track) => ({
          id: track.id,
          filename: track.filename,
          title: typeof track.title === 'string' ? track.title : track.filename.replace(/\.[^.]+$/, ''),
          uploadedAt: track.uploadedAt,
          size: Number(track.size) || 0,
          // 旧数据没有 duration 字段，读入时补成 null 保持结构一致
          duration: Number(track.duration) > 0 ? Math.round(Number(track.duration) * 10) / 10 : null,
        }));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.tracks = [];
        await this.persist();
      } else if (error instanceof SyntaxError) {
        throw new Error(
          `data/tracks.json 的 JSON 格式不正确（第 ${error.message.match(/position (\d+)/)?.[1] || '?'} 个字符附近），请先修复或备份后删除它。原始错误：${error.message}`
        );
      } else {
        throw error;
      }
    }

    this.ready = true;
    return this;
  }

  /** 最新上传排在最前 */
  list() {
    return [...this.tracks].sort((a, b) => {
      const diff = Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt);
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });
  }

  getById(id) {
    return this.tracks.find((track) => track.id === id) || null;
  }

  findByFilename(filename) {
    const key = String(filename || '').toLocaleLowerCase();
    return this.tracks.find((track) => track.filename.toLocaleLowerCase() === key) || null;
  }

  async add({ filename, size }) {
    const title = path.basename(filename, path.extname(filename));
    const track = {
      id: crypto.randomUUID(),
      filename,
      title: title || filename,
      uploadedAt: new Date().toISOString(),
      size: Number(size) || 0,
      // 时长由前端探测后经 PATCH 回填
      duration: null,
    };

    this.tracks.push(track);
    try {
      await this.save();
    } catch (error) {
      this.tracks = this.tracks.filter((item) => item.id !== track.id);
      throw error;
    }
    return track;
  }

  /** 通用字段更新（如时长回填），写入失败时整批回滚 */
  async update(id, changes) {
    const track = this.getById(id);
    if (!track) return null;

    const previous = {};
    for (const [key, value] of Object.entries(changes)) {
      previous[key] = track[key];
      track[key] = value;
    }

    try {
      await this.save();
    } catch (error) {
      Object.assign(track, previous);
      throw error;
    }
    return track;
  }

  async remove(id) {
    const index = this.tracks.findIndex((track) => track.id === id);
    if (index === -1) return false;

    const [removed] = this.tracks.splice(index, 1);
    try {
      await this.save();
    } catch (error) {
      // 写入失败时把记录放回原位，避免内存与 JSON 不一致
      this.tracks.splice(index, 0, removed);
      throw error;
    }
    return true;
  }

  save() {
    // 无论上一次成功或失败，后续写入都要继续排队
    this.writeChain = this.writeChain.then(
      () => this.persist(),
      () => this.persist()
    );
    return this.writeChain;
  }

  async persist() {
    const payload = JSON.stringify({ version: 1, tracks: this.tracks }, null, 2) + '\n';
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

module.exports = { TrackStore };

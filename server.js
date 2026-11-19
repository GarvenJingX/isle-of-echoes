'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const express = require('express');
const multer = require('multer');

const {
  extensionOf,
  isSupportedAudio,
  mimeFor,
  repairMojibake,
  sanitizeFilename,
} = require('./lib/filename');
const { TrackStore } = require('./lib/trackStore');
const { streamAudioFile } = require('./lib/mediaStream');

const ROOT_DIR = __dirname;
const AUDIO_DIR = path.join(ROOT_DIR, 'audio');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const METADATA_FILE = path.join(DATA_DIR, 'tracks.json');

// 本机启动默认只监听 127.0.0.1；部署到云端时由平台注入 HOST=0.0.0.0 对外服务
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILES_PER_REQUEST = 20;

// 同一瞬间重复点击/拖入同名文件时，先占住文件名，避免两次写入互相覆盖
const pendingFilenames = new Set();

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function releaseReservations(req) {
  if (!req || !Array.isArray(req._reservedFilenames)) return;
  for (const name of req._reservedFilenames) {
    pendingFilenames.delete(name.toLocaleLowerCase());
  }
  req._reservedFilenames = [];
}

function publicTrack(track) {
  return {
    id: track.id,
    filename: track.filename,
    title: track.title,
    uploadedAt: track.uploadedAt,
    size: track.size,
    duration: Number.isFinite(track.duration) && track.duration > 0 ? track.duration : null,
    extension: extensionOf(track.filename).replace('.', ''),
    url: `/media/${track.id}`,
  };
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const title = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 120) return null;
  return title;
}

function audioFilePath(filename) {
  const filePath = path.resolve(AUDIO_DIR, String(filename || ''));
  if (!filePath.startsWith(path.resolve(AUDIO_DIR) + path.sep)) {
    throw new HttpError(400, '无效的音频路径。', 'INVALID_PATH');
  }
  return filePath;
}

async function deleteAudioFile(filePath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.unlink(filePath);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      const retryable = error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES';
      if (retryable && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        continue;
      }
      if (retryable) {
        throw new HttpError(
          409,
          '音频文件正在被使用，请先暂停播放，稍后再试。',
          'FILE_IN_USE'
        );
      }
      throw error;
    }
  }
}

async function removeFiles(files) {
  const list = Array.isArray(files) ? files : [];
  await Promise.all(
    list.map(async (file) => {
      const filePath = file && (file.path || (file.filename ? path.join(AUDIO_DIR, file.filename) : null));
      if (!filePath) return;
      try {
        await fsp.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[cleanup] 无法移除文件:', filePath, error.message);
      }
    })
  );
}

async function main() {
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const store = await new TrackStore(METADATA_FILE).init();

  const storage = multer.diskStorage({
    destination(req, file, done) {
      done(null, AUDIO_DIR);
    },
    filename(req, file, done) {
      let safeName;
      try {
        safeName = sanitizeFilename(file.originalname);
      } catch (error) {
        done(new HttpError(400, '文件名无法识别，请改个名字再试试。'));
        return;
      }

      if (!isSupportedAudio(safeName)) {
        done(new HttpError(415, '只接受 mp3 / wav / m4a 三种格式的声音。', 'UNSUPPORTED_FORMAT'));
        return;
      }

      const key = safeName.toLocaleLowerCase();
      const alreadyOnIsland =
        pendingFilenames.has(key) ||
        Boolean(store.findByFilename(safeName)) ||
        fs.existsSync(path.join(AUDIO_DIR, safeName));

      if (alreadyOnIsland) {
        done(
          new HttpError(
            409,
            `《${safeName}》已经在岛上了，没有重复收录。`,
            'DUPLICATE_FILENAME'
          )
        );
        return;
      }

      pendingFilenames.add(key);
      req._reservedFilenames = req._reservedFilenames || [];
      req._reservedFilenames.push(key);

      done(null, safeName);
    },
  });

  const upload = multer({
    storage,
    // 浏览器以 UTF-8 发送文件名，显式声明可避免中文歌名乱码
    defParamCharset: 'utf8',
    limits: { files: MAX_FILES_PER_REQUEST },
    fileFilter(req, file, done) {
      const originalName = repairMojibake(file.originalname);
      if (!isSupportedAudio(originalName)) {
        done(new HttpError(415, '只接受 mp3 / wav / m4a 三种格式的声音。', 'UNSUPPORTED_FORMAT'));
        return;
      }
      done(null, true);
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  // 来源校验：音频删除不可恢复，防止本机其他网页（比如另一个标签页）
  // 借浏览器向本地服务发起上传 / 删除这类跨站请求。
  // 只放行不带 Origin/Referer 的请求（地址栏导航、curl 等本机直连）
  // 以及来自本机岛页面的请求；正常页面访问（静态资源）不受影响。
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/media/')) {
      next();
      return;
    }

    const origin = req.headers.origin || req.headers.referer;
    if (!origin) {
      next();
      return;
    }

    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }

    const localHosts = new Set([
      `127.0.0.1:${PORT}`,
      `localhost:${PORT}`,
      '127.0.0.1',
      'localhost',
      // 也接受页面实际使用的主机名（例如通过 hosts 别名访问）
      String(req.headers.host || ''),
    ]);

    if (localHosts.has(originHost)) {
      next();
      return;
    }

    next(new HttpError(403, '这个请求不是从岛上发出的，先挡下了。', 'FORBIDDEN_ORIGIN'));
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, tracks: store.tracks.length });
  });

  app.get('/api/tracks', (req, res) => {
    const tracks = store.list().map(publicTrack);
    res.json({ tracks, total: tracks.length });
  });

  app.patch('/api/tracks/:id', async (req, res, next) => {
    try {
      const track = store.getById(req.params.id);
      if (!track) {
        throw new HttpError(404, '这首声音已经不在岛上了。', 'TRACK_NOT_FOUND');
      }

      const body = req.body || {};
      const changes = {};

      if ('title' in body) {
        const title = normalizeTitle(body.title);
        if (!title) {
          throw new HttpError(
            400,
            '歌名需要是 1–120 个字符，不能只有空白。',
            'INVALID_TITLE'
          );
        }
        changes.title = title;
      }

      // 时长回填：前端探测到 metadata 后写入，单位秒、保留 1 位小数
      if ('duration' in body) {
        const duration = Number(body.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration >= 86400) {
          throw new HttpError(
            400,
            '时长需要是 0–86400 秒之间的数字。',
            'INVALID_DURATION'
          );
        }
        changes.duration = Math.round(duration * 10) / 10;
      }

      if (Object.keys(changes).length === 0) {
        throw new HttpError(400, '没有要更新的内容。', 'NO_FIELDS');
      }

      const updated = await store.update(track.id, changes);
      if (changes.title) {
        console.log(`[rename] ${track.filename} -> ${updated.title}`);
      }
      res.json({ track: publicTrack(updated) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/tracks/:id', async (req, res, next) => {
    try {
      const track = store.getById(req.params.id);
      if (!track) {
        throw new HttpError(404, '这首声音已经不在岛上了。', 'TRACK_NOT_FOUND');
      }

      const filePath = audioFilePath(track.filename);
      await deleteAudioFile(filePath);
      const removed = await store.remove(track.id);
      if (!removed) {
        throw new HttpError(404, '这首声音已经不在岛上了。', 'TRACK_NOT_FOUND');
      }

      console.log(`[delete] ${track.filename}`);
      res.json({ ok: true, id: track.id });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/upload', (req, res, next) => {
    upload.array('audio', MAX_FILES_PER_REQUEST)(req, res, (uploadError) => {
      if (uploadError) {
        next(uploadError);
        return;
      }

      (async () => {
        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length === 0) {
          throw new HttpError(400, '没有收到任何声音文件，请重新选择。', 'NO_FILE');
        }

        const emptyFile = files.find((file) => !file.size);
        if (emptyFile) {
          throw new HttpError(
            400,
            `《${emptyFile.filename}》是空文件，里面没有声音。`,
            'EMPTY_FILE'
          );
        }

        const added = [];
        try {
          for (const file of files) {
            const track = await store.add({ filename: file.filename, size: file.size });
            added.push(track);
          }
          req._uploadCommitted = true;
        } catch (error) {
          // 元数据写入失败时回滚这一批，避免留下「有文件没记录」的孤儿
          for (const track of added) {
            try {
              await store.remove(track.id);
            } catch (rollbackError) {
              console.error('[rollback] 回滚元数据失败:', rollbackError.message);
            }
          }
          await removeFiles(files);
          throw error;
        } finally {
          releaseReservations(req);
        }

        const tracks = added.map(publicTrack);

        console.log(
          `[upload] ${tracks.map((track) => track.filename).join('、')}`
        );
        res.status(201).json({ tracks });
      })().catch(next);
    });
  });

  app.get('/media/:id', (req, res) => {
    const track = store.getById(req.params.id);
    if (!track) {
      res.status(404).json({ error: '这首声音已经不在岛上了。' });
      return;
    }

    let filePath;
    try {
      filePath = audioFilePath(track.filename);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    streamAudioFile(req, res, filePath, mimeFor(track.filename));
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      etag: true,
      setHeaders(res, filePath) {
        if (path.extname(filePath) === '.html') {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
      },
    })
  );

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' });
      return;
    }
    res.status(404).type('text/plain; charset=utf-8').send('这页纸上没有声音。');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    releaseReservations(req);

    // 已经写入元数据的文件不能在这里删掉，否则会留下「有记录没文件」的卡片
    if (!req._uploadCommitted && (req.files || req.file)) {
      removeFiles(req.files || [req.file]).catch(() => {});
    }

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '岛上起了一阵小风，请稍后再试。';

    if (error instanceof HttpError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof multer.MulterError) {
      status = 400;
      code = error.code;
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        message = `一次最多上传 ${MAX_FILES_PER_REQUEST} 个文件，请分批放上来。`;
      } else {
        message = `上传没有完成：${error.message}`;
      }
    } else if (error && error.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message = '请求内容太大了。';
    } else {
      console.error('[error]', error);
    }

    res.status(status).json({ error: message, code });
  });

  const server = app.listen(PORT, HOST, () => {
    // 本机大文件上传可能持续很久，关闭 Node 默认的 5 分钟请求超时
    server.requestTimeout = 0;
    console.log('');
    console.log('  Isle of Echoes  ·  回声之岛');
    console.log(`  本地地址：http://${HOST}:${PORT}`);
    console.log(`  音频目录：${AUDIO_DIR}`);
    if (HOST === '127.0.0.1') {
      console.log('  仅监听本机，关闭此窗口即可停止服务。');
    } else {
      console.log(`  监听 ${HOST}（云端模式），请确认来源校验与访问范围符合预期。`);
    }
    console.log('');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，请关闭占用它的程序，或用 PORT=另一个端口 npm start 启动。`);
    } else {
      console.error('服务启动失败：', error);
    }
    process.exitCode = 1;
  });

  const shutdown = () => {
    console.log('\n正在收起这座小岛…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exitCode = 1;
});

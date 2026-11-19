'use strict';

const fs = require('node:fs');

/** 解析单段 Range，返回 {start, end}；无法满足时返回 null */
function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || '').trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;

  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;

  return { start, end: Math.min(end, size - 1) };
}

/**
 * 以流的方式发送音频，支持 Range 请求（拖动进度条、Safari 元数据探测都依赖它）。
 */
function streamAudioFile(req, res, filePath, mimeType) {
  fs.stat(filePath, (statError, stat) => {
    if (statError) {
      res.status(404).json({ error: '音频文件不在岛上了，请检查 audio 文件夹。' });
      return;
    }

    const size = stat.size;
    const rangeHeader = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    // 本地私人音频，允许浏览器缓存，重复播放同一首时不必再拉一遍数据；
    // must-revalidate 保证文件被删除后（接口 404）不会继续从缓存里命中
    res.setHeader('Cache-Control', 'private, max-age=86400, must-revalidate');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!rangeHeader) {
      res.setHeader('Content-Length', size);
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      pipeFile(req, res, filePath, {});
      return;
    }

    const range = parseRange(rangeHeader, size);
    if (!range) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    const { start, end } = range;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    pipeFile(req, res, filePath, { start, end });
  });
}

function pipeFile(req, res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
  };

  stream.on('error', () => {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: '读取音频时出了点小问题。' });
    } else {
      res.destroy();
    }
  });

  req.on('aborted', cleanup);
  res.on('close', () => {
    // 正常播放完毕时 writableEnded 为 true，只有提前断开才需要销毁流
    if (!res.writableEnded) cleanup();
  });

  stream.pipe(res);
}

module.exports = { parseRange, streamAudioFile };

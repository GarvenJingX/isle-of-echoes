'use strict';

const JSON_HEADERS = { Accept: 'application/json' };

export async function fetchTracks() {
  let response;
  try {
    response = await fetch('/api/tracks', { headers: JSON_HEADERS, cache: 'no-store' });
  } catch (error) {
    throw new Error('连不上本地的 Isle of Echoes，确认启动窗口还开着。');
  }

  if (!response.ok) {
    throw new Error('暂时没有读到岛上的收藏，请刷新页面再试。');
  }

  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.tracks)) {
    throw new Error('收藏数据格式不太对，检查一下 data/tracks.json。');
  }
  return data.tracks;
}

export async function renameTrack(id, title) {
  let response;
  try {
    response = await fetch(`/api/tracks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  } catch (error) {
    throw new Error('改名请求没有送达，确认本地服务还开着。');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.track) {
    const message =
      data && typeof data.error === 'string' ? data.error : '改名没有完成，请再试一次。';
    throw new Error(message);
  }
  return data.track;
}

/** 前端探测到音频时长后回填到元数据（秒，保留 1 位小数） */
export async function updateTrackDuration(id, duration) {
  let response;
  try {
    response = await fetch(`/api/tracks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
  } catch (error) {
    throw new Error('时长回填请求没有送达。');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.track) {
    const message = data && typeof data.error === 'string' ? data.error : '时长回填失败。';
    throw new Error(message);
  }
  return data.track;
}

export async function deleteTrack(id) {
  let response;
  try {
    response = await fetch(`/api/tracks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: JSON_HEADERS,
    });
  } catch (error) {
    throw new Error('删除请求没有送达，确认本地服务还开着。');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data.error === 'string' ? data.error : '删除没有完成，请再试一次。';
    throw new Error(message);
  }
  return data;
}

/**
 * 用 XMLHttpRequest 上传，fetch 拿不到发送进度，这里通过 upload.onprogress
 * 把（已传字节数, 总字节数）回调给调用方，驱动真实进度条。
 */
export function uploadTrack(file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('audio', file, file.name);

    const request = new XMLHttpRequest();
    request.open('POST', '/api/upload');

    request.upload.addEventListener('progress', (event) => {
      if (typeof onProgress === 'function' && event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    });

    request.addEventListener('load', () => {
      const data = (() => {
        try {
          return JSON.parse(request.responseText);
        } catch {
          return null;
        }
      })();

      if (request.status >= 200 && request.status < 300) {
        resolve(Array.isArray(data?.tracks) ? data.tracks : []);
        return;
      }

      const message = data && typeof data.error === 'string' ? data.error : '上传没有完成，请再试一次。';
      reject(new Error(message));
    });

    request.addEventListener('error', () => {
      reject(new Error('上传途中连接断开了，确认本地服务还开着。'));
    });
    request.addEventListener('abort', () => {
      reject(new Error('上传途中连接断开了，确认本地服务还开着。'));
    });

    request.send(form);
  });
}

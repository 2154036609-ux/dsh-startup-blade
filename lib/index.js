/**
 * dsh-startup-blade —— 宿主半边。
 *
 * 只做三件只读的事：
 *   1. GET /startup-blade/config  → 播放参数（页面据此决定播哪一档）；
 *   2. GET /startup-blade/frame   → 定格图字节（可选）；
 *   3. GET /startup-blade/art/*   → 分层素材（dark.jpg / lit.jpg / meta.json，可选）；
 *   4. GET /startup-blade/clip    → 真实视频片段（可选，支持 Range）。
 *
 * 为什么必须有宿主半边：浏览器插件模块只能取到自己的 client.js，**取不到包内静态图片/视频**。
 * 要把一张几 MB 的图或一段视频交给页面，只能由宿主开路由直出字节。
 *
 * 配置来源（后者覆盖前者）：
 *   · cordis.patch.yml 里本行的 config（随包发布的默认值）；
 *   · $DSH_HOME/startup-blade/config.json（用户本地覆盖，刷新即生效，不必重启）。
 *
 * 素材目录：`$DSH_HOME/startup-blade/`
 *   · frame.png|jpg|jpeg|webp   定格图
 *   · art/dark.jpg + art/lit.jpg + art/meta.json   分层「缓慢拔刀」
 *   · splash.mp4|webm|m4v       真实片段
 *
 * 不变量：只读；只认固定文件名（绝不接受请求里的路径片段）；卸载时撤销全部路由。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

export const name = 'dsh-startup-blade';

/** 硬依赖 webServer：等服务挂载后再注册路由，避免行并发装载时静默跳过注册。 */
export const inject = ['webServer'];

/** 路由前缀（与 client.js 里的 BASE 必须逐字一致）。 */
const BASE = '/startup-blade';

/** 用户数据目录：`$DSH_HOME/startup-blade`。 */
function userRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'startup-blade');
}

/** 定格图候选（按优先级）。 */
const FRAME_CANDIDATES = ['frame.png', 'frame.jpg', 'frame.jpeg', 'frame.webp'];

/** 真实画面片段候选。 */
const CLIP_CANDIDATES = ['splash.mp4', 'splash.webm', 'splash.m4v'];

/**
 * 分层素材：暗版 / 亮版 / 刀轴。三件齐了才启用「缓慢拔刀」档。
 * 为什么是两张整图而不是抠出刀身：刀与袖子、护手同色域，抠图必然带碎片；
 * 用「暗版 → 亮版沿刀轴扫过」的做法零抠图、零碎片。
 */
const ART_FILES = {
  'dark.jpg': 'image/jpeg',
  'lit.jpg': 'image/jpeg',
  'meta.json': 'application/json; charset=utf-8',
};

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const CLIP_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};

function artRoot() { return join(userRoot(), 'art'); }

/** 第一个存在的定格图，绝对路径或 null。 */
function resolveFrame() {
  for (const file of FRAME_CANDIDATES) {
    const abs = join(userRoot(), file);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return abs;
    } catch { /* 当作没有 */ }
  }
  return null;
}

/** 第一个存在的片段，{ abs, type } 或 null。 */
function resolveClip() {
  for (const file of CLIP_CANDIDATES) {
    const abs = join(userRoot(), file);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        return { abs, type: CLIP_MIME[extname(abs).toLowerCase()] || 'video/mp4' };
      }
    } catch { /* 当作没有 */ }
  }
  return null;
}

/** 三件套齐了才算「有分层素材」。 */
function hasArt() {
  try {
    return Object.keys(ART_FILES).every((file) => existsSync(join(artRoot(), file)));
  } catch {
    return false;
  }
}

/** 读用户覆盖配置（坏文件当作没有覆盖）。 */
async function readUserConfig() {
  const abs = join(userRoot(), 'config.json');
  try {
    if (!existsSync(abs)) return {};
    const parsed = JSON.parse(await readFile(abs, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 数值收敛。 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 组合出页面要的播放参数。 */
function buildConfig(patchConfig, userConfig) {
  const merged = { ...(patchConfig || {}), ...(userConfig || {}) };
  const hasFrame = resolveFrame() !== null;
  const hasClip = resolveClip() !== null;
  const art = hasArt();
  const modeRaw = String(merged.mode || 'auto');
  const auto = () => (hasClip ? 'clip' : art ? 'art' : hasFrame ? 'freeze' : 'reveal');
  let mode;
  if (modeRaw === 'clip') mode = hasClip ? 'clip' : auto();
  else if (modeRaw === 'art') mode = art ? 'art' : auto();
  else if (modeRaw === 'freeze') mode = hasFrame ? 'freeze' : auto();
  else if (modeRaw === 'reveal') mode = 'reveal';
  else mode = auto();

  return {
    enabled: merged.enabled !== false,
    speed: num(merged.speed, 1, 0.5, 2),
    hold: num(merged.hold, 620, 0, 4000),
    accent: typeof merged.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(merged.accent)
      ? merged.accent
      : '#9fe8ff',
    mode,
    hasFrame,
    hasClip,
    hasArt: art,
    frame: mode === 'freeze' ? `${BASE}/frame` : null,
    clip: mode === 'clip' ? `${BASE}/clip` : null,
    art: mode === 'art'
      ? {
        dark: `${BASE}/art/dark.jpg`,
        lit: `${BASE}/art/lit.jpg`,
        meta: `${BASE}/art/meta.json`,
      }
      : null,
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function apply(ctx, patchConfig) {
  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const disposers = [];
  const methodOf = (req) => (req.method || 'GET').toUpperCase();

  // ── 1. 播放参数 ────────────────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/config`,
    handler: async (req, res) => {
      const method = methodOf(req);
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      try {
        sendJson(res, 200, buildConfig(patchConfig, await readUserConfig()));
      } catch (error) {
        sendJson(res, 500, { error: String((error && error.message) || error) });
      }
    },
  }));

  // ── 2. 定格图 ──────────────────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/frame`,
    handler: async (req, res) => {
      const method = methodOf(req);
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      const abs = resolveFrame();
      if (!abs) { res.statusCode = 404; res.setHeader('cache-control', 'no-store'); res.end('no frame'); return; }
      try {
        const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
        const stat = statSync(abs);
        res.statusCode = 200;
        res.setHeader('content-type', type);
        res.setHeader('content-length', String(stat.size));
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('last-modified', stat.mtime.toUTCString());
        if (method === 'HEAD') { res.end(); return; }
        res.end(await readFile(abs));
      } catch (error) {
        sendJson(res, 500, { error: String((error && error.message) || error) });
      }
    },
  }));

  // ── 3. 分层素材（暗版 / 亮版 / 刀轴）────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/art`,
    handler: async (req, res) => {
      const method = methodOf(req);
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      let rest = '';
      try {
        rest = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname.slice(`${BASE}/art/`.length));
      } catch { rest = ''; }
      const type = ART_FILES[rest];
      if (!type) { res.statusCode = 404; res.end('not found'); return; }
      const abs = join(artRoot(), rest);
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) { res.statusCode = 404; res.end('not found'); return; }
        res.statusCode = 200;
        res.setHeader('content-type', type);
        res.setHeader('content-length', String(stat.size));
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('last-modified', stat.mtime.toUTCString());
        if (method === 'HEAD') { res.end(); return; }
        res.end(await readFile(abs));
      } catch {
        res.statusCode = 404;
        res.end('not found');
      }
    },
  }));

  // ── 4. 真实片段（支持 Range：<video> 必需）───────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/clip`,
    handler: (req, res) => {
      const method = methodOf(req);
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      const clip = resolveClip();
      if (!clip) { res.statusCode = 404; res.end('no clip'); return; }
      let stat;
      try { stat = statSync(clip.abs); } catch { res.statusCode = 404; res.end('no clip'); return; }
      const size = stat.size;

      res.setHeader('content-type', clip.type);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('last-modified', stat.mtime.toUTCString());

      const rangeHeader = req.headers && req.headers.range;
      const match = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      if (match) {
        let start = match[1] === '' ? NaN : Number(match[1]);
        let end = match[2] === '' ? NaN : Number(match[2]);
        if (Number.isNaN(start)) {
          start = Math.max(0, size - (Number.isNaN(end) ? 0 : end));
          end = size - 1;
        }
        if (Number.isNaN(end) || end >= size) end = size - 1;
        if (start > end || start >= size) {
          res.statusCode = 416;
          res.setHeader('content-range', `bytes */${size}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
        res.setHeader('content-length', String(end - start + 1));
        if (method === 'HEAD') { res.end(); return; }
        createReadStream(clip.abs, { start, end }).pipe(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-length', String(size));
      if (method === 'HEAD') { res.end(); return; }
      createReadStream(clip.abs).pipe(res);
    },
  }));

  return () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try { if (typeof dispose === 'function') dispose(); } catch { /* 已撤销 */ }
    }
  };
}

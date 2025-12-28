/**
* Copyright (c) 2025 OldYuTou https://github.com/OldYuTou
* Project: LAN-SHELL
* Released under the MIT License.
* 欢迎使用并提供反馈!
* Hope to get your advice!
*/

// NO-AUTH version: anyone can access the UI, APIs, and terminal WebSocket.
// WARNING: This is unsafe on any untrusted network.

// Global error handling
process.on('uncaughtException', (error) => {
  console.error('💥 未捕获的异常:', error);
  console.error('Stack trace:', error?.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 未处理的Promise拒绝:', reason);
  console.error('Promise:', promise);
});

import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = Number.parseInt(process.env.PORT || '', 10) || 6273;
const ROOT = process.env.ALLOW_ROOT || path.resolve(process.env.HOME || '/');
const ALLOWED_CMDS = (process.env.ALLOWED_CMDS || 'npm,node,yarn,pnpm,ls,bash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// 用于“刷新后恢复终端输出”的回放缓冲区上限（字符数）
const HISTORY_MAX_CHARS = Number.parseInt(process.env.HISTORY_MAX_CHARS || '', 10) || 500000;

const app = express();
// 文本编辑会走 JSON；实际可写入大小由各 API 的限制控制
// 注意：大文件上传走 /api/upload-raw（二进制流式写入），避免 base64 带来的体积膨胀与内存占用。
app.use(express.json({ limit: '8mb' }));

// 指令集（预设命令）持久化：存到服务端文件，便于多设备共享（NO AUTH）
const DATA_DIR = path.join(__dirname, 'data');
const COMMAND_SETS_FILE = path.join(DATA_DIR, 'command-sets.json');

function defaultCommandSets() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    root: { id: 'root', type: 'folder', name: 'root', children: [] },
  };
}

function validateCommandNode(node, depth = 0, counter = { n: 0 }) {
  if (!node || typeof node !== 'object') return { ok: false, error: 'node invalid' };
  if (depth > 20) return { ok: false, error: 'depth too deep' };

  const { id, type, name } = node;
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'id invalid' };
  if (type !== 'folder' && type !== 'command') return { ok: false, error: 'type invalid' };
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name invalid' };

  counter.n += 1;
  if (counter.n > 5000) return { ok: false, error: 'too many nodes' };

  if (type === 'folder') {
    const children = node.children;
    if (!Array.isArray(children)) return { ok: false, error: 'children invalid' };
    for (const child of children) {
      const r = validateCommandNode(child, depth + 1, counter);
      if (!r.ok) return r;
    }
  } else {
    const content = node.content;
    if (typeof content !== 'string') return { ok: false, error: 'content invalid' };
    if (content.length > 20000) return { ok: false, error: 'content too long' };
    if (node.autoSend !== undefined && typeof node.autoSend !== 'boolean') {
      return { ok: false, error: 'autoSend invalid' };
    }
  }

  return { ok: true };
}

function readCommandSets() {
  try {
    if (!fs.existsSync(COMMAND_SETS_FILE)) return defaultCommandSets();
    const raw = fs.readFileSync(COMMAND_SETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultCommandSets();
    if (!parsed.root) return defaultCommandSets();
    const r = validateCommandNode(parsed.root);
    if (!r.ok) return defaultCommandSets();
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      root: parsed.root,
    };
  } catch (e) {
    console.error('读取指令集失败，将返回默认空指令集:', e?.message || e);
    return defaultCommandSets();
  }
}

function writeCommandSets(payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    root: payload.root,
  };

  const tmp = `${COMMAND_SETS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, COMMAND_SETS_FILE);
  return data;
}

// Disable browser caching globally to avoid stale UI/logic across refreshes.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Avoid caching the app shell and SW; it can cause "normal refresh" to keep old UI logic.
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Serve PWA assets without auth
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

// Root serves SPA
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const withinRoot = (targetPath) => {
  const real = path.resolve(targetPath);
  return real.startsWith(path.resolve(ROOT));
};

// Terminal session management
const terminalSessions = new Map(); // id -> session

function filterHistoryForReplay(data) {
  // 过滤“清空回滚区”的控制序列：很多 clear 实现会输出 ESC[3J，导致回放时只能看到当前屏幕且无法上滑。
  // 这里只影响“恢复回放”，不影响真实 PTY 会话本身。
  try {
    return String(data || '').replace(/\x1b\[3J/g, '');
  } catch {
    return '';
  }
}

function trimHistoryForReplay(history) {
  const s = String(history || '');
  if (s.length <= HISTORY_MAX_CHARS) return s;
  let start = s.length - HISTORY_MAX_CHARS;
  // 尽量从换行边界开始，避免截断在半行/半个控制序列附近导致回放只剩“屏幕绘制片段”
  const nl = s.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < s.length) start = nl + 1;
  return s.slice(start);
}

function sendWsTextInChunks(ws, text, chunkSize = 16 * 1024) {
  const s = String(text || '');
  if (!s) return;
  for (let i = 0; i < s.length; i += chunkSize) {
    try {
      ws.send(s.slice(i, i + chunkSize));
    } catch {
      break;
    }
  }
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function detectArchiveType(filePath) {
  const p = String(filePath || '').toLowerCase();
  if (p.endsWith('.zip')) return 'zip';
  if (p.endsWith('.tar')) return 'tar';
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) return 'targz';
  if (p.endsWith('.tar.bz2') || p.endsWith('.tbz2')) return 'tarbz2';
  if (p.endsWith('.tar.xz') || p.endsWith('.txz')) return 'tarxz';
  return null;
}

function normalizeEntryPath(entry) {
  const raw = String(entry || '').replace(/\0/g, '');
  // 统一分隔符，去掉前导 ./，避免平台差异
  let p = raw.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function isSafeArchiveEntry(entry) {
  const p = normalizeEntryPath(entry);
  if (!p) return false;
  // 绝对路径 / Windows 盘符
  if (p.startsWith('/')) return false;
  if (/^[a-zA-Z]:\//.test(p)) return false;
  // 目录遍历：任意 path segment 为 ..
  const segs = p.split('/').filter(Boolean);
  if (segs.some((s) => s === '..')) return false;
  return true;
}

async function listArchiveEntries(filePath, type) {
  if (type === 'zip') {
    const { stdout } = await execFileAsync('unzip', ['-Z1', filePath]);
    return String(stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // tar 系列：tar -tf 会自动识别压缩？GNU tar 对 .tar.gz 需 -z；这里显式指定更稳
  if (type === 'tar') {
    const { stdout } = await execFileAsync('tar', ['-tf', filePath]);
    return String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'targz') {
    const { stdout } = await execFileAsync('tar', ['-tzf', filePath]);
    return String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'tarbz2') {
    const { stdout } = await execFileAsync('tar', ['-tjf', filePath]);
    return String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'tarxz') {
    const { stdout } = await execFileAsync('tar', ['-tJf', filePath]);
    return String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// List directory contents (NO AUTH)
app.get('/api/fs', (req, res) => {
  const rel = req.query.path || '.';
  const target = path.resolve(ROOT, rel);
  if (!withinRoot(target)) return res.status(403).json({ error: 'out of root' });

  try {
    const items = fs
      .readdirSync(target)
      .map((name) => {
        try {
          const st = fs.statSync(path.join(target, name));
          const isExe = st.isFile() && (st.mode & 0o111);
          return { name, isDir: st.isDirectory(), size: st.size, isExe: Boolean(isExe) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return res.json({ cwd: target, root: ROOT, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 文本文件读取/保存（NO AUTH）
// 说明：
// - 仅用于“文本类文件”编辑，因此对最大文件大小与二进制内容做了限制
// - 为了避免覆盖外部修改，PUT 支持带 mtimeMs 的乐观锁（不传则直接写入）
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const BINARY_SNIFF_BYTES = 8 * 1024; // 8KB
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES || '', 10) || (200 * 1024 * 1024); // 默认 200MB

function resolvePathFromQuery(raw) {
  const p = (raw ?? '.').toString();
  const target = path.resolve(ROOT, p);
  if (!withinRoot(target)) return { ok: false, error: 'out of root', target: null, raw: p };
  return { ok: true, target, raw: p };
}

function validateFileName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'name required', name: null };
  if (n === '.' || n === '..') return { ok: false, error: 'invalid name', name: null };
  if (n.includes('/') || n.includes('\\')) return { ok: false, error: 'name must not contain path separators', name: null };
  if (n.includes('\0')) return { ok: false, error: 'invalid name', name: null };
  return { ok: true, name: n };
}

function unlinkQuiet(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function streamToFileWithLimit(req, tmpPath, limitBytes) {
  return new Promise((resolve, reject) => {
    let written = 0;
    const out = fs.createWriteStream(tmpPath);
    let finished = false;

    function done(err) {
      if (finished) return;
      finished = true;
      try { out.destroy(); } catch {}
      if (err) {
        unlinkQuiet(tmpPath);
        reject(err);
      } else {
        resolve({ bytes: written });
      }
    }

    req.on('aborted', () => done(new Error('client aborted')));
    req.on('error', (e) => done(e));
    out.on('error', (e) => done(e));

    req.on('data', (chunk) => {
      written += chunk?.length || 0;
      if (written > limitBytes) {
        // 超限：立刻中止读取与写入
        try { req.pause(); } catch {}
        try { req.destroy(new Error('payload too large')); } catch {}
        try { out.destroy(new Error('payload too large')); } catch {}
        return;
      }
      const ok = out.write(chunk);
      if (!ok) req.pause();
    });

    out.on('drain', () => {
      try { req.resume(); } catch {}
    });

    req.on('end', () => {
      out.end(() => done());
    });
  });
}

function looksBinary(buf) {
  try {
    if (!buf || !buf.length) return false;
    const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < len; i += 1) {
      if (buf[i] === 0) return true;
    }
  } catch {}
  return false;
}

app.get('/api/file', (req, res) => {
  const r = resolvePathFromQuery(req.query.path);
  if (!r.ok) return res.status(403).json({ error: r.error });

  try {
    const st = fs.statSync(r.target);
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    if (st.size > MAX_TEXT_FILE_BYTES) {
      return res.status(413).json({ error: `file too large (>${MAX_TEXT_FILE_BYTES} bytes)` });
    }
    const buf = fs.readFileSync(r.target);
    if (looksBinary(buf)) return res.status(415).json({ error: 'binary file not supported' });
    const content = buf.toString('utf8');
    return res.json({
      ok: true,
      path: r.target,
      size: st.size,
      mtimeMs: st.mtimeMs,
      encoding: 'utf8',
      content,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'read failed' });
  }
});

app.put('/api/file', (req, res) => {
  const body = req.body || {};
  const r = resolvePathFromQuery(body.path);
  if (!r.ok) return res.status(403).json({ error: r.error });

  const content = body.content;
  const providedMtimeMs = body.mtimeMs;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be string' });

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TEXT_FILE_BYTES) return res.status(413).json({ error: `content too large (>${MAX_TEXT_FILE_BYTES} bytes)` });

  try {
    const exists = fs.existsSync(r.target);
    if (exists) {
      const st = fs.statSync(r.target);
      if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
      if (st.size > MAX_TEXT_FILE_BYTES) {
        return res.status(413).json({ error: `file too large (>${MAX_TEXT_FILE_BYTES} bytes)` });
      }
      if (providedMtimeMs !== undefined && providedMtimeMs !== null) {
        const expected = Number.parseFloat(providedMtimeMs);
        if (Number.isFinite(expected)) {
          // mtimeMs 可能有小数；给 2ms 容差避免平台差异导致误判
          if (Math.abs(st.mtimeMs - expected) > 2) {
            return res.status(409).json({
              error: 'file changed on disk',
              currentMtimeMs: st.mtimeMs,
            });
          }
        }
      }
    } else {
      // 新建文件：确保父目录存在且在 ROOT 内
      const parent = path.dirname(r.target);
      if (!withinRoot(parent)) return res.status(403).json({ error: 'out of root' });
      fs.mkdirSync(parent, { recursive: true });
    }

    const tmp = `${r.target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, r.target);
    const st2 = fs.statSync(r.target);
    return res.json({ ok: true, path: r.target, size: st2.size, mtimeMs: st2.mtimeMs });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'write failed' });
  }
});

// 上传文件（NO AUTH）
// 前端会把文件读成 base64 传入，这里按二进制写入（支持非文本文件）。
app.post('/api/upload', (req, res) => {
  const body = req.body || {};
  const dirRaw = body.dir;
  const nameRaw = body.name;
  const dataBase64 = body.dataBase64;
  const overwrite = Boolean(body.overwrite);

  const dir = resolvePathFromQuery(dirRaw);
  if (!dir.ok) return res.status(403).json({ error: dir.error });

  const nm = validateFileName(nameRaw);
  if (!nm.ok) return res.status(400).json({ error: nm.error });

  if (typeof dataBase64 !== 'string' || !dataBase64) return res.status(400).json({ error: 'dataBase64 required' });

  // 兼容 data URL：data:xxx;base64,....
  const base64 = dataBase64.includes(',') ? dataBase64.split(',').pop() : dataBase64;
  let buf = null;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid base64' });
  }
  if (!buf || !buf.length) return res.status(400).json({ error: 'invalid data' });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `file too large (>${MAX_UPLOAD_BYTES} bytes)` });

  try {
    const st = fs.statSync(dir.target);
    if (!st.isDirectory()) return res.status(400).json({ error: 'dir is not a directory' });
  } catch (e) {
    return res.status(400).json({ error: e?.message || 'dir invalid' });
  }

  const target = path.join(dir.target, nm.name);
  if (!withinRoot(target)) return res.status(403).json({ error: 'out of root' });

  try {
    if (fs.existsSync(target) && !overwrite) return res.status(409).json({ error: 'file exists' });

    const tmp = `${target}.${process.pid}.upload.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    const st = fs.statSync(target);
    return res.json({ ok: true, path: target, size: st.size, mtimeMs: st.mtimeMs });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'upload failed' });
  }
});

// 新建空白目录（NO AUTH）
app.post('/api/fs/mkdir', (req, res) => {
  const body = req.body || {};
  const dirRaw = body.dir;
  const nameRaw = body.name;
  const dir = resolvePathFromQuery(dirRaw);
  if (!dir.ok) return res.status(403).json({ error: dir.error });
  const nm = validateFileName(nameRaw);
  if (!nm.ok) return res.status(400).json({ error: nm.error });
  const target = path.join(dir.target, nm.name);
  if (!withinRoot(target)) return res.status(403).json({ error: 'out of root' });
  try {
    // 确保父目录存在
    fs.mkdirSync(dir.target, { recursive: true });
    if (fs.existsSync(target)) return res.status(409).json({ error: 'exists' });
    fs.mkdirSync(target, { recursive: false });
    const st = fs.statSync(target);
    return res.json({ ok: true, path: target, mtimeMs: st.mtimeMs });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'mkdir failed' });
  }
});

// 上传文件（二进制流式）（NO AUTH）
// - 适用于大文件（如 60MB 以上），避免 base64 膨胀与 btoa/JSON 限制
// - 使用临时文件写入后 rename，保证写入原子性
app.post('/api/upload-raw', async (req, res) => {
  const dirRaw = req.query.dir;
  const nameRaw = req.query.name;
  const overwrite = String(req.query.overwrite || '').trim() === '1' || String(req.query.overwrite || '').trim().toLowerCase() === 'true';

  const dir = resolvePathFromQuery(dirRaw);
  if (!dir.ok) return res.status(403).json({ error: dir.error });

  const nm = validateFileName(nameRaw);
  if (!nm.ok) return res.status(400).json({ error: nm.error });

  try {
    const st = fs.statSync(dir.target);
    if (!st.isDirectory()) return res.status(400).json({ error: 'dir is not a directory' });
  } catch (e) {
    return res.status(400).json({ error: e?.message || 'dir invalid' });
  }

  const target = path.join(dir.target, nm.name);
  if (!withinRoot(target)) return res.status(403).json({ error: 'out of root' });

  try {
    if (fs.existsSync(target) && !overwrite) return res.status(409).json({ error: 'file exists' });
  } catch {}

  const tmp = `${target}.${process.pid}.upload.tmp`;
  try {
    // 清理可能残留的 tmp（极端情况下上次异常退出）
    unlinkQuiet(tmp);

    const { bytes } = await streamToFileWithLimit(req, tmp, MAX_UPLOAD_BYTES);

    // 写入完成后原子替换
    fs.renameSync(tmp, target);
    const st2 = fs.statSync(target);
    return res.json({ ok: true, path: target, size: st2.size, mtimeMs: st2.mtimeMs, bytes });
  } catch (e) {
    if (String(e?.message || '').includes('payload too large')) {
      unlinkQuiet(tmp);
      return res.status(413).json({ error: `file too large (>${MAX_UPLOAD_BYTES} bytes)` });
    }
    unlinkQuiet(tmp);
    return res.status(500).json({ error: e?.message || 'upload failed' });
  }
});

// 解压归档（NO AUTH）
// - 支持 zip / tar / tar.gz(tgz) / tar.bz2(tbz2) / tar.xz(txz)
// - 先列目录做 ZipSlip/路径穿越检查，再执行解压
app.post('/api/archive/extract', async (req, res) => {
  const body = req.body || {};
  const archiveRaw = body.path;
  const destRaw = body.dest;
  const overwrite = Boolean(body.overwrite);

  const ar = resolvePathFromQuery(archiveRaw);
  if (!ar.ok) return res.status(403).json({ error: ar.error });

  const dest = resolvePathFromQuery(destRaw);
  if (!dest.ok) return res.status(403).json({ error: dest.error });

  const type = detectArchiveType(ar.target);
  if (!type) return res.status(415).json({ error: 'unsupported archive type' });

  try {
    const st = fs.statSync(ar.target);
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
  } catch (e) {
    return res.status(400).json({ error: e?.message || 'archive invalid' });
  }

  try {
    if (fs.existsSync(dest.target)) {
      const st = fs.statSync(dest.target);
      if (!st.isDirectory()) return res.status(400).json({ error: 'dest is not a directory' });
    } else {
      fs.mkdirSync(dest.target, { recursive: true });
    }
  } catch (e) {
    return res.status(400).json({ error: e?.message || 'dest invalid' });
  }

  // 安全检查：列出条目，拒绝危险路径
  let entries = [];
  try {
    entries = await listArchiveEntries(ar.target, type);
  } catch (e) {
    return res.status(400).json({ error: `cannot inspect archive safely: ${e?.message || e}` });
  }
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'empty archive' });
  if (entries.length > 20000) return res.status(413).json({ error: 'too many entries' });

  const bad = entries.find((x) => !isSafeArchiveEntry(x));
  if (bad) return res.status(400).json({ error: `unsafe entry path: ${bad}` });

  try {
    if (type === 'zip') {
      const args = overwrite ? ['-o', ar.target, '-d', dest.target] : ['-n', ar.target, '-d', dest.target];
      await execFileAsync('unzip', args, { encoding: 'utf8' });
    } else {
      // tar：安全参数，避免写入权限/owner
      const common = ['--no-same-owner', '--no-same-permissions', '-C', dest.target];
      const ow = overwrite ? ['--overwrite'] : ['--keep-old-files'];
      const base = ['-x', ...ow];
      if (type === 'tar') await execFileAsync('tar', [...base, '-f', ar.target, ...common]);
      else if (type === 'targz') await execFileAsync('tar', [...base, '-z', '-f', ar.target, ...common]);
      else if (type === 'tarbz2') await execFileAsync('tar', [...base, '-j', '-f', ar.target, ...common]);
      else if (type === 'tarxz') await execFileAsync('tar', [...base, '-J', '-f', ar.target, ...common]);
    }
  } catch (e) {
    // 常见：系统缺少 unzip 或 tar
    const msg = e?.message || 'extract failed';
    return res.status(500).json({ error: msg });
  }

  return res.json({ ok: true, type, archive: ar.target, dest: dest.target, entries: entries.length });
});

// 文件操作（NO AUTH）
// - 删除：二次确认由前端负责；服务端仅做路径与根目录保护
// - 重命名：仅改名，不允许跨目录（避免变相 move）
// - 复制/移动：支持文件与目录，目录可合并，冲突策略：overwrite/skip/error

function isRootPath(p) {
  try {
    const a = path.resolve(p);
    const b = path.resolve(ROOT);
    return a === b;
  } catch {
    return false;
  }
}

function ensureDirExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) throw new Error('dest is not a directory');
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function isSubPath(child, parent) {
  try {
    const rel = path.relative(parent, child);
    if (!rel) return true; // same path
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function copyFileWithPolicy(src, dest, policy, stats) {
  if (fs.existsSync(dest)) {
    if (policy === 'skip') {
      stats.skipped += 1;
      return;
    }
    if (policy === 'error') {
      const e = new Error('dest exists');
      e.code = 'EEXIST';
      throw e;
    }
    // overwrite
    fs.rmSync(dest, { force: true, recursive: true });
    stats.overwritten += 1;
  }
  fs.copyFileSync(src, dest);
  stats.copied += 1;
}

function copyDirMerge(srcDir, destDir, policy, stats) {
  ensureDirExists(destDir);

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);

    if (ent.isSymbolicLink()) {
      // 为安全与可预测性：不跟随/不复制软链接
      const e = new Error(`symlink not supported: ${ent.name}`);
      e.code = 'ESYMLINK';
      throw e;
    }

    if (ent.isDirectory()) {
      if (fs.existsSync(destPath) && !fs.statSync(destPath).isDirectory()) {
        if (policy === 'skip') {
          stats.skipped += 1;
          continue;
        }
        if (policy === 'error') {
          const e = new Error('dest exists and is not directory');
          e.code = 'EEXIST';
          throw e;
        }
        fs.rmSync(destPath, { force: true, recursive: true });
        stats.overwritten += 1;
      }
      copyDirMerge(srcPath, destPath, policy, stats);
    } else if (ent.isFile()) {
      copyFileWithPolicy(srcPath, destPath, policy, stats);
    } else {
      // 其它类型（socket、fifo 等）不处理
      const e = new Error(`unsupported entry type: ${ent.name}`);
      e.code = 'EUNSUPPORTED';
      throw e;
    }
  }
}

function moveFileWithPolicy(src, dest, policy, stats) {
  if (fs.existsSync(dest)) {
    if (policy === 'skip') {
      stats.skipped += 1;
      return;
    }
    if (policy === 'error') {
      const e = new Error('dest exists');
      e.code = 'EEXIST';
      throw e;
    }
    fs.rmSync(dest, { force: true, recursive: true });
    stats.overwritten += 1;
  }
  try {
    fs.renameSync(src, dest);
    stats.moved += 1;
  } catch {
    // 跨设备等情况：回退为 copy + delete
    fs.copyFileSync(src, dest);
    stats.moved += 1;
    fs.rmSync(src, { force: true });
  }
}

function moveDirMerge(srcDir, destDir, policy, stats) {
  // 如果目标不存在，优先尝试直接 rename（最快）
  if (!fs.existsSync(destDir)) {
    try {
      fs.renameSync(srcDir, destDir);
      stats.moved += 1;
      return;
    } catch {
      // fallthrough：merge move
    }
  }

  ensureDirExists(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);

    if (ent.isSymbolicLink()) {
      const e = new Error(`symlink not supported: ${ent.name}`);
      e.code = 'ESYMLINK';
      throw e;
    }

    if (ent.isDirectory()) {
      if (fs.existsSync(destPath) && !fs.statSync(destPath).isDirectory()) {
        if (policy === 'skip') {
          stats.skipped += 1;
          continue;
        }
        if (policy === 'error') {
          const e = new Error('dest exists and is not directory');
          e.code = 'EEXIST';
          throw e;
        }
        fs.rmSync(destPath, { force: true, recursive: true });
        stats.overwritten += 1;
      }
      moveDirMerge(srcPath, destPath, policy, stats);
    } else if (ent.isFile()) {
      moveFileWithPolicy(srcPath, destPath, policy, stats);
    } else {
      const e = new Error(`unsupported entry type: ${ent.name}`);
      e.code = 'EUNSUPPORTED';
      throw e;
    }
  }

  // 若目录已空则清理；如果有 skip 导致仍有内容，则保留
  try {
    const left = fs.readdirSync(srcDir);
    if (!left.length) fs.rmdirSync(srcDir);
  } catch {}
}

app.post('/api/fs/delete', (req, res) => {
  const body = req.body || {};
  const r = resolvePathFromQuery(body.path);
  if (!r.ok) return res.status(403).json({ error: r.error });
  if (isRootPath(r.target)) return res.status(403).json({ error: 'forbidden at root' });
  try {
    const st = fs.statSync(r.target);
    if (st.isDirectory()) fs.rmSync(r.target, { recursive: true, force: true });
    else fs.rmSync(r.target, { force: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'delete failed' });
  }
});

app.post('/api/fs/rename', (req, res) => {
  const body = req.body || {};
  const r = resolvePathFromQuery(body.path);
  if (!r.ok) return res.status(403).json({ error: r.error });
  if (isRootPath(r.target)) return res.status(403).json({ error: 'forbidden at root' });
  const nm = validateFileName(body.newName);
  if (!nm.ok) return res.status(400).json({ error: nm.error });
  const dest = path.join(path.dirname(r.target), nm.name);
  if (!withinRoot(dest)) return res.status(403).json({ error: 'out of root' });
  try {
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'dest exists' });
    fs.renameSync(r.target, dest);
    return res.json({ ok: true, path: dest });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'rename failed' });
  }
});

app.post('/api/fs/copy', (req, res) => {
  const body = req.body || {};
  const src = resolvePathFromQuery(body.src);
  if (!src.ok) return res.status(403).json({ error: src.error });
  const destDir = resolvePathFromQuery(body.destDir);
  if (!destDir.ok) return res.status(403).json({ error: destDir.error });
  const policy = (body.conflict || 'error').toString();
  if (!['overwrite', 'skip', 'error'].includes(policy)) return res.status(400).json({ error: 'invalid conflict policy' });

  const name = body.destName ? validateFileName(body.destName) : { ok: true, name: path.basename(src.target) };
  if (!name.ok) return res.status(400).json({ error: name.error });

  try {
    const dst = path.join(destDir.target, name.name);
    if (!withinRoot(dst)) return res.status(403).json({ error: 'out of root' });
    ensureDirExists(destDir.target);

    const st = fs.statSync(src.target);
    if (st.isDirectory() && isSubPath(dst, src.target)) return res.status(400).json({ error: 'cannot copy directory into itself' });
    if (st.isFile() && path.resolve(dst) === path.resolve(src.target)) return res.status(400).json({ error: 'dest equals src' });

    const stats = { copied: 0, skipped: 0, overwritten: 0 };
    if (st.isFile()) {
      copyFileWithPolicy(src.target, dst, policy, stats);
    } else if (st.isDirectory()) {
      copyDirMerge(src.target, dst, policy, stats);
    } else {
      return res.status(400).json({ error: 'unsupported type' });
    }
    return res.json({ ok: true, dest: dst, ...stats });
  } catch (e) {
    if (e?.code === 'EEXIST') return res.status(409).json({ error: 'dest exists' });
    return res.status(500).json({ error: e?.message || 'copy failed' });
  }
});

app.post('/api/fs/move', (req, res) => {
  const body = req.body || {};
  const src = resolvePathFromQuery(body.src);
  if (!src.ok) return res.status(403).json({ error: src.error });
  if (isRootPath(src.target)) return res.status(403).json({ error: 'forbidden at root' });
  const destDir = resolvePathFromQuery(body.destDir);
  if (!destDir.ok) return res.status(403).json({ error: destDir.error });
  const policy = (body.conflict || 'error').toString();
  if (!['overwrite', 'skip', 'error'].includes(policy)) return res.status(400).json({ error: 'invalid conflict policy' });

  const name = body.destName ? validateFileName(body.destName) : { ok: true, name: path.basename(src.target) };
  if (!name.ok) return res.status(400).json({ error: name.error });

  try {
    const dst = path.join(destDir.target, name.name);
    if (!withinRoot(dst)) return res.status(403).json({ error: 'out of root' });
    ensureDirExists(destDir.target);

    const st = fs.statSync(src.target);
    if (st.isDirectory() && isSubPath(dst, src.target)) return res.status(400).json({ error: 'cannot move directory into itself' });
    if (st.isFile() && path.resolve(dst) === path.resolve(src.target)) return res.status(400).json({ error: 'dest equals src' });

    const stats = { moved: 0, skipped: 0, overwritten: 0 };
    if (st.isFile()) {
      moveFileWithPolicy(src.target, dst, policy, stats);
    } else if (st.isDirectory()) {
      moveDirMerge(src.target, dst, policy, stats);
    } else {
      return res.status(400).json({ error: 'unsupported type' });
    }
    return res.json({ ok: true, dest: dst, ...stats });
  } catch (e) {
    if (e?.code === 'EEXIST') return res.status(409).json({ error: 'dest exists' });
    return res.status(500).json({ error: e?.message || 'move failed' });
  }
});

// 指令集：读取/保存（NO AUTH）
app.get('/api/command-sets', (req, res) => {
  res.json(readCommandSets());
});

app.put('/api/command-sets', (req, res) => {
  const body = req.body || {};
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid body' });
  if (!body.root) return res.status(400).json({ error: 'missing root' });
  const r = validateCommandNode(body.root);
  if (!r.ok) return res.status(400).json({ error: r.error || 'invalid' });

  try {
    const saved = writeCommandSets(body);
    res.json({ ok: true, saved });
  } catch (e) {
    console.error('写入指令集失败:', e?.message || e);
    res.status(500).json({ error: 'write failed' });
  }
});

function resolveCwdFromReq(req, { queryKey = 'cwd', bodyKey = 'cwd', defaultValue = '.' } = {}) {
  const raw = (req.query?.[queryKey] ?? req.body?.[bodyKey] ?? defaultValue).toString();
  if (raw.trim() === '.') return { ok: false, error: 'forbidden at root', cwd: null, raw };
  const target = path.resolve(ROOT, raw);
  if (!withinRoot(target)) return { ok: false, error: 'out of root', cwd: null, raw };
  try {
    const rel = path.relative(ROOT, target);
    const parts = rel.split(path.sep).filter(Boolean);
    const hasHidden = parts.some((p) => p.startsWith('.') && p !== '.' && p !== '..');
    if (hasHidden) return { ok: false, error: 'forbidden in hidden dir', cwd: null, raw };
  } catch {}
  return { ok: true, cwd: target, raw };
}

async function detectGitInfo(cwd) {
  try {
    await execFileAsync('git', ['--version']);
  } catch {
    return { gitAvailable: false, isRepo: false, repoRoot: null, branch: null };
  }

  try {
    const r = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
    const inside = String(r.stdout || '').trim() === 'true';
    if (!inside) return { gitAvailable: true, isRepo: false, repoRoot: null, branch: null };
  } catch {
    return { gitAvailable: true, isRepo: false, repoRoot: null, branch: null };
  }

  let repoRoot = null;
  let branch = null;
  try {
    const r = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    repoRoot = String(r.stdout || '').trim() || null;
  } catch {}
  try {
    const r = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    branch = String(r.stdout || '').trim() || null;
  } catch {}

  return { gitAvailable: true, isRepo: true, repoRoot, branch };
}

async function detectUpstream(cwd) {
  try {
    const r = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const upstream = String(r.stdout || '').trim();
    return upstream || null;
  } catch {
    return null;
  }
}

// Git info/commits/init (NO AUTH)
app.get('/api/git/info', async (req, res) => {
  const r = resolveCwdFromReq(req, { queryKey: 'cwd' });
  if (!r.ok) return res.status(403).json({ error: r.error });
  try {
    const info = await detectGitInfo(r.cwd);
    res.json({ ok: true, cwd: r.cwd, ...info });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'git info failed' });
  }
});

app.get('/api/git/commits', async (req, res) => {
  const r = resolveCwdFromReq(req, { queryKey: 'cwd' });
  if (!r.ok) return res.status(403).json({ error: r.error });
  const limit = Math.min(200, Math.max(1, Number.parseInt((req.query.limit || '').toString(), 10) || 50));
  try {
    const info = await detectGitInfo(r.cwd);
    if (!info.gitAvailable) return res.json({ ok: true, cwd: r.cwd, gitAvailable: false, isRepo: false, commits: [] });
    if (!info.isRepo) return res.json({ ok: true, cwd: r.cwd, gitAvailable: true, isRepo: false, commits: [] });

    const upstream = await detectUpstream(r.cwd); // may be null (no remote/upstream)
    let upstreamHead = null;
    if (upstream) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-parse', upstream]);
        upstreamHead = String(stdout || '').trim() || null;
      } catch {}
    }

    const format = '%H%x1f%h%x1f%an%x1f%ad%x1f%s';
    const { stdout } = await execFileAsync('git', [
      '-C',
      r.cwd,
      'log',
      `-n`,
      String(limit),
      '--date=iso-strict',
      `--pretty=format:${format}`,
    ]);

    const lines = String(stdout || '')
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean);

    let commits = lines
      .map((line) => line.split('\x1f'))
      .filter((parts) => parts.length >= 5)
      .map(([hash, shortHash, author, date, subject]) => ({
        hash,
        shortHash,
        author,
        date,
        subject,
      }));

    if (upstream) {
      // unpushed: commits reachable from HEAD but not from upstream
      // cap size to avoid accidental huge payloads in large-divergence repos
      const { stdout: upStdout } = await execFileAsync('git', [
        '-C',
        r.cwd,
        'rev-list',
        '--max-count=5000',
        `${upstream}..HEAD`,
      ]);
      const unpushed = new Set(
        String(upStdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      commits = commits.map((c) => ({
        ...c,
        pushed: !unpushed.has(c.hash),
        isUpstreamHead: upstreamHead ? c.hash === upstreamHead : false,
      }));
    } else {
      commits = commits.map((c) => ({
        ...c,
        pushed: null, // unknown: no upstream configured
        isUpstreamHead: null,
      }));
    }

    res.json({ ok: true, cwd: r.cwd, ...info, upstream, upstreamHead, commits });
  } catch (e) {
    // 可能是“还没有任何提交”
    const msg = String(e?.stderr || e?.message || '');
    if (/does not have any commits|your current branch/i.test(msg)) {
      const info = await detectGitInfo(r.cwd);
      const upstream = info?.isRepo ? await detectUpstream(r.cwd).catch(() => null) : null;
      let upstreamHead = null;
      if (upstream) {
        try {
          const { stdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-parse', upstream]);
          upstreamHead = String(stdout || '').trim() || null;
        } catch {}
      }
      return res.json({ ok: true, cwd: r.cwd, ...info, upstream, upstreamHead, commits: [] });
    }
    res.status(500).json({ error: e?.message || 'git log failed' });
  }
});

app.post('/api/git/init', async (req, res) => {
  const r = resolveCwdFromReq(req, { bodyKey: 'cwd' });
  if (!r.ok) return res.status(403).json({ error: r.error });

  try {
    const st = fs.statSync(r.cwd);
    if (!st.isDirectory()) return res.status(400).json({ error: 'cwd is not a directory' });
  } catch {
    return res.status(400).json({ error: 'cwd not found' });
  }

  try {
    const info = await detectGitInfo(r.cwd);
    if (!info.gitAvailable) return res.status(400).json({ error: 'git not available' });
    if (info.isRepo) return res.json({ ok: true, cwd: r.cwd, already: true, ...info });

    await execFileAsync('git', ['-C', r.cwd, 'init']);
    const info2 = await detectGitInfo(r.cwd);
    res.json({ ok: true, cwd: r.cwd, already: false, ...info2 });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'git init failed' });
  }
});

app.post('/api/git/reset', async (req, res) => {
  const r = resolveCwdFromReq(req, { bodyKey: 'cwd' });
  if (!r.ok) return res.status(403).json({ error: r.error });
  const mode = String(req.body?.mode || '').toLowerCase();
  if (mode !== 'soft' && mode !== 'hard') return res.status(400).json({ error: 'mode must be soft|hard' });
  const commit = String(req.body?.commit || '').trim();
  if (!commit) return res.status(400).json({ error: 'missing commit' });
  const confirmHard = Boolean(req.body?.confirmHard);

  try {
    const info = await detectGitInfo(r.cwd);
    if (!info.gitAvailable) return res.status(400).json({ error: 'git not available' });
    if (!info.isRepo) return res.status(400).json({ error: 'not a git repo' });

    if (mode === 'hard' && !confirmHard) return res.status(400).json({ error: 'hard reset requires confirmHard=true' });

    // Ensure commit exists and is a commit object.
    try {
      await execFileAsync('git', ['-C', r.cwd, 'cat-file', '-e', `${commit}^{commit}`]);
    } catch {
      return res.status(400).json({ error: 'invalid commit' });
    }

    // Require upstream so we can reliably determine pushed/unpushed.
    const upstream = await detectUpstream(r.cwd);
    if (!upstream) return res.status(400).json({ error: 'upstream not configured' });

    // Determine whether target commit is on upstream.
    let isOnUpstream = false;
    try {
      await execFileAsync('git', ['-C', r.cwd, 'merge-base', '--is-ancestor', commit, upstream]);
      isOnUpstream = true;
    } catch {
      isOnUpstream = false;
    }

    // Only allow resetting to a commit reachable from current HEAD (avoid arbitrary/dangling objects).
    try {
      await execFileAsync('git', ['-C', r.cwd, 'merge-base', '--is-ancestor', commit, 'HEAD']);
    } catch {
      return res.status(400).json({ error: 'commit not reachable from HEAD' });
    }

    // If the target commit is pushed, only allow resetting to the *latest* upstream commit
    // (sync local back to cloud). Older pushed commits remain forbidden.
    let upstreamHead = null;
    try {
      const { stdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-parse', upstream]);
      upstreamHead = String(stdout || '').trim() || null;
    } catch {}

    if (isOnUpstream) {
      if (!upstreamHead) return res.status(400).json({ error: 'cannot resolve upstream head' });
      if (commit !== upstreamHead) return res.status(400).json({ error: 'only upstream head can be reset to when pushed' });
    }

    await execFileAsync('git', ['-C', r.cwd, 'reset', mode === 'soft' ? '--soft' : '--hard', commit]);
    const { stdout: newHeadStdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-parse', 'HEAD']);
    res.json({
      ok: true,
      cwd: r.cwd,
      mode,
      upstream,
      upstreamHead,
      target: commit,
      head: String(newHeadStdout || '').trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'git reset failed' });
  }
});

app.post('/api/git/revert', async (req, res) => {
  const r = resolveCwdFromReq(req, { bodyKey: 'cwd' });
  if (!r.ok) return res.status(403).json({ error: r.error });
  const commit = String(req.body?.commit || '').trim();
  if (!commit) return res.status(400).json({ error: 'missing commit' });

  try {
    const info = await detectGitInfo(r.cwd);
    if (!info.gitAvailable) return res.status(400).json({ error: 'git not available' });
    if (!info.isRepo) return res.status(400).json({ error: 'not a git repo' });

    // Ensure commit exists and is a commit object.
    try {
      await execFileAsync('git', ['-C', r.cwd, 'cat-file', '-e', `${commit}^{commit}`]);
    } catch {
      return res.status(400).json({ error: 'invalid commit' });
    }

    // Only allow reverting commits that are reachable from current HEAD.
    try {
      await execFileAsync('git', ['-C', r.cwd, 'merge-base', '--is-ancestor', commit, 'HEAD']);
    } catch {
      return res.status(400).json({ error: 'commit not reachable from HEAD' });
    }

    // Avoid complex states: require clean working tree (but allow untracked files).
    // Many users keep artifacts (e.g. *.zip/*.bundle) untracked; reverting is still safe in that case.
    const { stdout: statusOut } = await execFileAsync('git', ['-C', r.cwd, 'status', '--porcelain']);
    const statusLines = String(statusOut || '')
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean);
    const hasTrackedChanges = statusLines.some((line) => !line.startsWith('?? '));
    if (hasTrackedChanges) {
      return res.status(400).json({
        error: 'working tree not clean',
        hint: '请先提交/暂存/还原当前改动（允许存在未跟踪文件）。',
      });
    }

    // Merge commits require -m; keep the API safe and predictable.
    try {
      const { stdout: parentsStdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-list', '--parents', '-n', '1', commit]);
      const parts = String(parentsStdout || '').trim().split(/\s+/).filter(Boolean);
      const parentCount = Math.max(0, parts.length - 1);
      if (parentCount > 1) {
        return res.status(400).json({ error: 'merge commit revert not supported', hint: '该提交是 merge commit，请在终端手动执行：git revert -m 1 <commit>（或选择正确的主线）。' });
      }
    } catch {}

    // Create a new commit that reverses changes introduced by `commit`.
    try {
      await execFileAsync('git', ['-C', r.cwd, 'revert', '--no-edit', commit]);
    } catch (e) {
      const stderr = String(e?.stderr || '');
      // Conflicts will leave repo in REVERTING state; user can resolve in terminal then `git revert --continue` or abort.
      if (/conflict|CONFLICT|could not apply|after resolving/i.test(stderr)) {
        return res.status(409).json({ error: 'revert conflict', hint: '请在终端解决冲突后执行 git revert --continue，或执行 git revert --abort 取消。' });
      }
      return res.status(500).json({ error: e?.message || 'git revert failed' });
    }

    const { stdout: newHeadStdout } = await execFileAsync('git', ['-C', r.cwd, 'rev-parse', 'HEAD']);
    const upstream = await detectUpstream(r.cwd);
    res.json({ ok: true, cwd: r.cwd, upstream, reverted: commit, head: String(newHeadStdout || '').trim() });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'git revert failed' });
  }
});

// One-shot command with SSE output (NO AUTH, still restricted by ALLOWED_CMDS)
app.post('/api/run', (req, res) => {
  const { cmd, args = [], cwd = '.' } = req.body || {};
  const realCwd = path.resolve(ROOT, cwd);
  if (!withinRoot(realCwd)) return res.status(403).end();
  if (!ALLOWED_CMDS.includes(cmd)) return res.status(403).json({ error: 'command not allowed' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const child = pty.spawn(cmd, args, { cwd: realCwd, name: 'xterm-color' });
  child.onData((d) => res.write(`data:${d}\n\n`));
  child.onExit(({ exitCode }) => {
    res.write(`event:end\ndata:${exitCode}\n\n`);
    res.end();
  });
});

// Session list/history (NO AUTH)
app.get('/api/sessions', (req, res) => {
  const clientId = (req.query.clientId || '').toString();
  const sessions = Array.from(terminalSessions.entries()).map(([id, session]) => ({
    id,
    cwd: session.cwd,
    created: session.created,
    lastActivity: session.lastActivity,
    cols: session.cols,
    rows: session.rows,
    clientId: session.clientId || '',
  }));
  res.json({ sessions: clientId ? sessions.filter((s) => s.clientId === clientId) : sessions });
});

// Terminate all sessions (kills all ptys and clears the restore list)
app.delete('/api/sessions', (req, res) => {
  const clientId = (req.query.clientId || '').toString();
  const ids = Array.from(terminalSessions.entries())
    .filter(([, s]) => !clientId || (s.clientId || '') === clientId)
    .map(([id]) => id);
  for (const id of ids) {
    const session = terminalSessions.get(id);
    if (!session) continue;

    try {
      for (const sock of session.sockets || []) {
        try {
          sock.close();
        } catch {}
      }
    } catch {}

    try {
      session.shell?.kill();
    } catch {}

    terminalSessions.delete(id);
  }
  res.json({ ok: true, deleted: ids.length });
});

app.get('/api/sessions/:id/history', (req, res) => {
  const sessionId = req.params.id;
  const session = terminalSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });

  res.json({
    history: session.history || '',
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
  });
});

// Terminate a session (kills pty and removes it so it won't be restored)
app.delete('/api/sessions/:id', (req, res) => {
  const sessionId = req.params.id;
  const clientId = (req.query.clientId || '').toString();
  const session = terminalSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (clientId && (session.clientId || '') !== clientId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    for (const sock of session.sockets || []) {
      try {
        sock.close();
      } catch {}
    }
  } catch {}

  try {
    session.shell?.kill();
  } catch {}

  terminalSessions.delete(sessionId);
  res.json({ ok: true });
});

// HTTP server
const server = app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`ROOT=${ROOT}`);
  console.log(`ALLOWED_CMDS=${ALLOWED_CMDS.join(',')}`);
});

// Interactive terminal via WebSocket (NO AUTH)
const wss = new WebSocketServer({ server, path: '/ws/pty' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const cwdParam = url.searchParams.get('cwd') || '.';
  const sessionId = url.searchParams.get('sessionId');
  const clientId = url.searchParams.get('clientId') || '';

  const cwd = path.resolve(ROOT, cwdParam);
  if (!withinRoot(cwd)) return ws.close();

  const cols = Number.parseInt(url.searchParams.get('cols') || '', 10) || 80;
  const rows = Number.parseInt(url.searchParams.get('rows') || '', 10) || 24;

  let session;

  if (sessionId && terminalSessions.has(sessionId)) {
    session = terminalSessions.get(sessionId);
    // Migrate older sessions: adopt clientId on first reconnect.
    if (clientId && !session.clientId) {
      session.clientId = clientId;
    }
    if (clientId && (session.clientId || '') && (session.clientId || '') !== clientId) {
      console.log(`⚠️ clientId不匹配，拒绝重连: ${sessionId}`);
      try {
        ws.send(`SESSION_FORBIDDEN:${sessionId}`);
      } catch {}
      try {
        ws.close(1008, 'SESSION_FORBIDDEN');
      } catch {}
      return;
    }
    console.log(`🔄 重连到现有会话: ${sessionId}`);
    session.sockets.add(ws);
    if (session.history) sendWsTextInChunks(ws, session.history);
    // Tell client the session id immediately (so it can persist/terminate reliably).
    ws.send(`SESSION_ID:${session.id}`);
  } else if (sessionId) {
    // Client is trying to reconnect to a session that no longer exists.
    // Do NOT create a new session in this case; otherwise stale localStorage (or multiple tabs)
    // will create many new sessions on refresh/restart.
    console.log(`⚠️ 会话不存在，拒绝重连: ${sessionId}`);
    try {
      ws.send(`SESSION_NOT_FOUND:${sessionId}`);
    } catch {}
    try {
      ws.close(1008, 'SESSION_NOT_FOUND');
    } catch {}
  } else {
    // IMPORTANT: never trust a client-provided sessionId for creating sessions.
    // Otherwise stale localStorage (or multiple tabs) can "resurrect" old ids and
    // explode session counts on refresh/restart.
    const newSessionId = generateSessionId();
    console.log(`🆕 创建新终端会话: ${newSessionId}`);

    const shell = pty.spawn('/bin/bash', [], {
      cwd,
      name: 'xterm-color',
      cols,
      rows,
    });

    session = {
      id: newSessionId,
      shell,
      cwd,
      cols,
      rows,
      clientId,
      created: new Date(),
      lastActivity: new Date(),
      history: '',
      sockets: new Set(),
    };

    session.sockets.add(ws);
    terminalSessions.set(newSessionId, session);

    // Send title + client-readable session id
    ws.send(`\x1b]0;Session: ${newSessionId}\x07`);
    ws.send(`SESSION_ID:${session.id}`);

    shell.onData((data) => {
      // 仅用于刷新后的回放：保留足够长的输出，并避免 clear 等操作把回滚区“清零”
      session.history = trimHistoryForReplay((session.history || '') + filterHistoryForReplay(data));
      session.lastActivity = new Date();

      for (const sock of session.sockets) {
        if (sock.readyState === 1) sock.send(data);
      }
    });
  }

  ws.on('message', (m) => {
    const message = m.toString();

    if (message.startsWith('RESIZE:')) {
      const [, newCols, newRows] = message.split(':');
      const c = Number.parseInt(newCols || '', 10) || 80;
      const r = Number.parseInt(newRows || '', 10) || 24;

      session.cols = c;
      session.rows = r;
      session.lastActivity = new Date();
      session.shell?.resize(c, r);
      return;
    }

    if (message === 'GET_SESSION_ID') {
      ws.send(`SESSION_ID:${session.id}`);
      return;
    }

    session.shell?.write(message);
    session.lastActivity = new Date();
  });

  ws.on('close', () => {
    try {
      session?.sockets?.delete(ws);
    } catch {}
    console.log(`🔌 WebSocket连接关闭，会话 ${session?.id || '(none)'} 保持运行`);
  });
});

// Cleanup long-inactive sessions (24h)
setInterval(() => {
  const now = new Date();
  for (const [id, session] of terminalSessions.entries()) {
    const inactiveTime = now - session.lastActivity;
    if (inactiveTime > 24 * 60 * 60 * 1000) {
      console.log(`🗑️ 清理过期会话: ${id}`);
      try {
        session.shell?.kill();
      } catch {}
      terminalSessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Graceful shutdown on SIGINT/SIGTERM
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`\nReceived ${sig}, shutting down...`);
    server.close(() => process.exit(0));
  });
});

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = Number.parseInt(process.env.PORT || '', 10) || 6273;
const ROOT = process.env.ALLOW_ROOT || path.resolve(process.env.HOME || '/');
const ALLOWED_CMDS = (process.env.ALLOWED_CMDS || 'npm,node,yarn,pnpm,ls,bash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: '1mb' }));

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

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
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
    if (session.history) ws.send(session.history);
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
      session.history += data;
      if (session.history.length > 50000) session.history = session.history.slice(-40000);
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

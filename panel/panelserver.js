// Kike Hosting - panel local de servidores Minecraft (Fase 1)
// Un solo archivo, sin dependencias npm. Node >= 20.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const INSTANCES_DIR = path.join(ROOT, 'instances');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const CONFIG_PATH = path.join(ROOT, 'mc-host.config.json');
const PANEL_PORT = Number(process.env.PANEL_PORT || 8787);
if (!Number.isInteger(PANEL_PORT) || PANEL_PORT < 1024 || PANEL_PORT > 65535) throw new Error('PANEL_PORT debe estar entre 1024 y 65535');
const MOCK = !!process.env.PANEL_MOCK;

const DEFAULT_CONFIG = {
  javaBin: MOCK ? process.execPath : (process.env.JAVA_BIN || 'java'),
  ramMB: 4096,
  extraJavaArgs: '',
  backupIntervalMin: 30,
  rollingKeep: 7,
  weeklyKeep: 4,
  motd: 'Kike Hosting',
  maxPlayers: 10,
};
let config = { ...DEFAULT_CONFIG };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch (_) {}
if (!config.ramMB && Array.isArray(config.javaArgs)) {
  const mx = config.javaArgs.find(a => a.startsWith('-Xmx'));
  if (mx) { const m = mx.match(/-Xmx(\d+)([MG])/i); if (m) config.ramMB = m[2].toUpperCase() === 'G' ? +m[1] * 1024 : +m[1]; }
}
function saveConfig() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (_) {} }
function buildJavaArgs() {
  if (MOCK) return [];
  const extra = String(config.extraJavaArgs || '').split(/\s+/).filter(Boolean);
  return ['-Xms1024M', `-Xmx${config.ramMB || 3072}M`, ...extra];
}

// ---------- estado en memoria ----------
// instances: name -> { name, version, status, proc, pid, startedAt, players:Set, logBuf:[], maxPlayers }
const instances = new Map();
let runningName = null; // solo un servidor activo a la vez
const sseClients = new Set();
const LOG_BUF_MAX = 800;

function now() { return Date.now(); }
function fmtTs(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch (_) {} }
}
function safeName(n) { return /^[A-Za-z0-9_-]{1,32}$/.test(n || ''); }
function instDir(name) { return path.join(INSTANCES_DIR, name); }

// ---------- sesiones y PIN ----------
const sessions = new Map(); // token -> { exp }
const loginFails = new Map(); // ip -> { n, until }
function hashPin(pin, salt) { return crypto.createHash('sha256').update(salt + ':' + String(pin)).digest('hex'); }
function getSession(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)kh=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < now()) { sessions.delete(m[1]); return null; }
  s.exp = now() + 12 * 3600 * 1000;
  return m[1];
}
function newSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { exp: now() + 12 * 3600 * 1000 });
  res.setHeader('Set-Cookie', 'kh=' + t + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + 7 * 24 * 3600);
  return t;
}
function setPin(pin) {
  config.pinSalt = crypto.randomBytes(8).toString('hex');
  config.pinHash = hashPin(pin, config.pinSalt);
  saveConfig();
}

// UUID offline (mismo algoritmo que Java: nameUUIDFromBytes("OfflinePlayer:"+nombre), MD5 v3)
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}
function whitelistPath(inst) { return path.join(instDir(inst.name), 'whitelist.json'); }
function readWhitelist(inst) { try { return JSON.parse(fs.readFileSync(whitelistPath(inst), 'utf8')); } catch (_) { return []; } }
function isOnlineMode(inst) { return readProps(inst).props['online-mode'] !== 'false'; }

function pushLog(inst, line, stream = 'server') {
  const entry = { t: now(), line, stream };
  inst.logBuf.push(entry);
  if (inst.logBuf.length > LOG_BUF_MAX) inst.logBuf.splice(0, inst.logBuf.length - LOG_BUF_MAX);
  broadcast({ type: 'log', inst: inst.name, entry });
  parseLogLine(inst, line);
}

function parseLogLine(inst, line) {
  let m = line.match(/: (\S+) joined the game$/);
  if (m) { inst.players.add(m[1]); broadcastState(inst); return; }
  m = line.match(/: (\S+) left the game$/);
  if (m) { inst.players.delete(m[1]); broadcastState(inst); return; }
  m = line.match(/Done \([\d.]+s\)! For help, type "help"/);
  if (m && inst.status === 'starting') { inst.status = 'online'; broadcastState(inst); return; }
  m = line.match(/There are (\d+) of a max of (\d+) players online:?(.*)/);
  if (m) {
    const names = (m[3] || '').split(',').map(s => s.trim()).filter(Boolean);
    inst.players = new Set(names);
    inst.maxPlayers = parseInt(m[2], 10) || inst.maxPlayers;
    broadcastState(inst);
  }
}

function publicState(inst) {
  return {
    name: inst.name, version: inst.version, status: inst.status, pid: inst.pid || null,
    uptimeSec: inst.startedAt ? Math.floor((now() - inst.startedAt) / 1000) : 0,
    players: [...inst.players], maxPlayers: inst.maxPlayers || config.maxPlayers,
    ramMB: inst.ramMB || null,
  };
}
function broadcastState(inst) { broadcast({ type: 'state', inst: publicState(inst), runningName }); }

async function loadInstances() {
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
  for (const d of await fsp.readdir(INSTANCES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const metaPath = path.join(INSTANCES_DIR, d.name, 'kike-instance.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      instances.set(d.name, {
        name: d.name, version: meta.version || '?', status: 'offline', proc: null, pid: null,
        startedAt: null, players: new Set(), logBuf: [], maxPlayers: config.maxPlayers, ramMB: null,
      });
    } catch (_) {}
  }
}

// ---------- Mojang ----------
let manifestCache = { at: 0, data: null };
async function mojangManifest() {
  if (manifestCache.data && now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
  const r = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  if (!r.ok) throw new Error('manifest HTTP ' + r.status);
  manifestCache = { at: now(), data: await r.json() };
  return manifestCache.data;
}
async function serverJarUrl(version) {
  const man = await mojangManifest();
  const v = man.versions.find(v => v.id === version && v.type === 'release');
  if (!v) throw new Error('Versión no encontrada: ' + version);
  const r = await fetch(v.url);
  if (!r.ok) throw new Error('version json HTTP ' + r.status);
  const meta = await r.json();
  return meta.downloads.server.url;
}

// ---------- acciones ----------
async function createInstance(name, version, log) {
  if (!safeName(name)) throw new Error('Nombre no válido (usa letras, números, - y _)');
  if (instances.has(name)) throw new Error('Ya existe una instancia con ese nombre');
  const dir = instDir(name);
  await fsp.mkdir(dir, { recursive: true });
  const jarPath = path.join(dir, 'server.jar');
  if (!fs.existsSync(jarPath)) {
    const url = MOCK ? null : await serverJarUrl(version);
    if (MOCK) { await fsp.writeFile(jarPath, 'mock'); }
    else {
      log && log('Descargando servidor ' + version + ' de Mojang...');
      const r = await fetch(url);
      if (!r.ok) throw new Error('jar HTTP ' + r.status);
      await fsp.writeFile(jarPath, Buffer.from(await r.arrayBuffer()));
    }
  }
  await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=false\n');
  await fsp.writeFile(path.join(dir, 'server.properties'), [
    'server-port=25565', 'online-mode=true', 'max-players=' + config.maxPlayers,
    'motd=' + config.motd, 'view-distance=10', 'simulation-distance=8',
    'spawn-protection=16', 'enable-command-block=false', 'white-list=false', '',
  ].join('\n'));
  await fsp.writeFile(path.join(dir, 'kike-instance.json'), JSON.stringify({ name, version, createdAt: new Date().toISOString() }, null, 2));
  instances.set(name, {
    name, version, status: 'offline', proc: null, pid: null, startedAt: null,
    players: new Set(), logBuf: [], maxPlayers: config.maxPlayers, ramMB: null,
  });
  return instances.get(name);
}

function startInstance(inst) {
  if (runningName) throw new Error('Ya hay un servidor encendido (' + runningName + '). Apágalo primero.');
  if (inst.status !== 'offline') throw new Error('El servidor no está apagado');
  const dir = instDir(inst.name);
  if (!MOCK && !/^eula=true\s*$/m.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'))) throw new Error('Lee https://www.minecraft.net/eula y, si aceptas, cambia eula=false por eula=true en el eula.txt de esta instancia.');
  inst.status = 'starting';
  inst.startedAt = now();
  inst.players = new Set();
  const args = MOCK
    ? [path.join(__dirname, 'fake-server.js')]
    : [...buildJavaArgs(), '-jar', 'server.jar', 'nogui'];
  const proc = spawn(config.javaBin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  inst.proc = proc;
  inst.pid = proc.pid;
  runningName = inst.name;
  pushLog(inst, '[panel] Encendiendo ' + inst.name + ' (' + inst.version + ')', 'panel');
  let carry = '';
  proc.stdout.on('data', d => {
    carry += d.toString('utf8');
    let i;
    while ((i = carry.indexOf('\n')) >= 0) { pushLog(inst, carry.slice(0, i).replace(/\r$/, '')); carry = carry.slice(i + 1); }
  });
  proc.stderr.on('data', d => d.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(l => pushLog(inst, l, 'error')));
  proc.on('exit', (code) => {
    pushLog(inst, '[panel] Servidor apagado (código ' + code + ')', 'panel');
    inst.status = 'offline'; inst.proc = null; inst.pid = null; inst.startedAt = null;
    inst.players = new Set(); inst.ramMB = null;
    if (runningName === inst.name) runningName = null;
    broadcastState(inst);
  });
  broadcastState(inst);
}

async function stopInstance(inst) {
  if (!inst.proc) { inst.status = 'offline'; broadcastState(inst); return; }
  inst.status = 'stopping';
  broadcastState(inst);
  pushLog(inst, '[panel] Apagando con "stop" (guarda el mundo antes)', 'panel');
  try { inst.proc.stdin.write('stop\n'); } catch (_) {}
  await new Promise(res => {
    const t = setTimeout(() => { try { inst.proc && inst.proc.kill('SIGKILL'); } catch (_) {} res(); }, 30000);
    inst.proc.once('exit', () => { clearTimeout(t); res(); });
  });
  try { await backupInstance(inst, 'auto-apagado'); } catch (e) { pushLog(inst, '[panel] Copia al apagar falló: ' + e.message, 'error'); }
}

function sendCommand(inst, cmd) {
  if (!inst.proc || inst.status === 'offline') throw new Error('El servidor está apagado');
  cmd = String(cmd || '').replace(/[\r\n]/g, ' ').trim();
  if (!cmd) return;
  pushLog(inst, '> ' + cmd, 'panel');
  inst.proc.stdin.write(cmd + '\n');
}

// ---------- copias de seguridad ----------
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return t.getUTCFullYear() + '-W' + String(1 + Math.round((t - first) / 6048e5)).padStart(2, '0');
}
async function listBackups(name) {
  const dir = path.join(BACKUPS_DIR, name);
  try {
    const out = [];
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.zip')) continue;
      const st = await fsp.stat(path.join(dir, f));
      out.push({ file: f, sizeMB: +(st.size / 1048576).toFixed(1), date: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  } catch (_) { return []; }
}
function tarExe() { return 'C:\\Windows\\System32\\tar.exe'; }
async function backupInstance(inst, tag = 'manual') {
  const dir = instDir(inst.name);
  if (!fs.existsSync(path.join(dir, 'world'))) { if (tag === 'auto-apagado') return null; throw new Error('Aún no hay mundo que copiar'); }
  const bdir = path.join(BACKUPS_DIR, inst.name);
  await fsp.mkdir(bdir, { recursive: true });
  const file = `mundo-${fmtTs()}-${tag}.zip`;
  const dest = path.join(bdir, file);
  const running = inst.proc && inst.status !== 'offline';
  if (running) { sendCommand(inst, 'save-all flush'); await new Promise(r => setTimeout(r, 2500)); sendCommand(inst, 'save-off'); }
  try {
    if (MOCK) { await fsp.writeFile(dest, 'mock-zip'); }
    else {
      const q = s => s.replace(/'/g, "''");
      const ps = [
        `$src='${q(dir)}\\world'`, `$stage='${q(ROOT)}\\backups\\.stage-${Date.now()}'`,
        `robocopy $src "$stage\\world" /MIR /XF session.lock /NFL /NDL /NJH /NJS /NC /NS | Out-Null`,
        `if ($LASTEXITCODE -ge 8) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; throw "robocopy fallo ($LASTEXITCODE)" }`,
        `Compress-Archive -LiteralPath "$stage\\world" -DestinationPath '${q(dest)}' -CompressionLevel Optimal -Force -ErrorAction Stop`,
        `Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue`,
      ].join('; ');
      await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 300000 }, (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res()));
    }
  } finally { if (running) sendCommand(inst, 'save-on'); }
  pushLog(inst, '[panel] Copia guardada: ' + file, 'panel');
  await rotateBackups(inst.name);
  broadcast({ type: 'backups', inst: inst.name, backups: await listBackups(inst.name) });
  return file;
}
async function rotateBackups(name) {
  const all = await listBackups(name);
  const keep = new Set(all.slice(0, config.rollingKeep).map(b => b.file));
  const byWeek = new Map();
  for (const b of all) {
    const w = isoWeek(new Date(b.date));
    if (!byWeek.has(w)) byWeek.set(w, b.file);
  }
  [...byWeek.values()].slice(0, config.weeklyKeep).forEach(f => keep.add(f));
  for (const b of all) if (!keep.has(b.file)) { try { await fsp.unlink(path.join(BACKUPS_DIR, name, b.file)); } catch (_) {} }
}
setInterval(async () => {
  if (!runningName) return;
  const inst = instances.get(runningName);
  if (!inst || inst.status !== 'online') return;
  inst.lastAutoBackup = inst.lastAutoBackup || now();
  if (now() - inst.lastAutoBackup >= config.backupIntervalMin * 60000) {
    inst.lastAutoBackup = now();
    try { await backupInstance(inst, 'auto'); } catch (e) { pushLog(inst, '[panel] Copia automática falló: ' + e.message, 'error'); }
  }
}, 30000);
setInterval(() => {
  if (!runningName || os.platform() !== 'win32') return;
  const inst = instances.get(runningName);
  if (!inst || !inst.pid) return;
  execFile('tasklist', ['/FI', 'PID eq ' + inst.pid, '/FO', 'CSV', '/NH'], (e, out) => {
    if (e) return;
    const m = out.match(/"java(?:w)?\.exe","(\d+)","[^"]*","[^"]*","([\d.]+)\s*KB"/i) || out.match(/","(\d+)","[^"]*","[^"]*","([\d.]+)\s*KB"/);
    if (m) { inst.ramMB = Math.round(parseInt(m[2].replace(/\./g, ''), 10) / 1024); broadcastState(inst); }
  });
}, 5000);
setInterval(() => {
  if (!runningName) return;
  const inst = instances.get(runningName);
  if (inst && inst.status === 'online' && inst.proc) { try { inst.proc.stdin.write('list\n'); } catch (_) {} }
}, 15000);

// ---------- server.properties / ops / datapacks ----------
function propsPath(inst) { return path.join(instDir(inst.name), 'server.properties'); }
function readProps(inst) {
  const raw = fs.existsSync(propsPath(inst)) ? fs.readFileSync(propsPath(inst), 'utf8') : '';
  const props = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) props[m[1].trim()] = m[2];
  }
  return { props, raw };
}
function mergeProps(inst, updates) {
  const { props } = readProps(inst);
  Object.assign(props, updates);
  return props;
}
function writeProps(inst, props) {
  const raw = fs.existsSync(propsPath(inst)) ? fs.readFileSync(propsPath(inst), 'utf8') : '';
  const seen = new Set();
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([^#=\s][^=]*)=/);
    if (m) {
      const k = m[1].trim();
      if (k in props) { out.push(k + '=' + props[k]); seen.add(k); continue; }
    }
    out.push(line);
  }
  for (const k of Object.keys(props)) if (!seen.has(k)) out.push(k + '=' + props[k]);
  fs.writeFileSync(propsPath(inst), out.join('\n'));
}
function opsPath(inst) { return path.join(instDir(inst.name), 'ops.json'); }
function readOps(inst) {
  try { return JSON.parse(fs.readFileSync(opsPath(inst), 'utf8')); } catch (_) { return []; }
}
async function resolveUuid(name) {
  const r = await fetch('https://playerdb.co/api/player/minecraft/' + encodeURIComponent(name), { headers: { 'user-agent': 'KikeHosting local panel' } });
  if (!r.ok) throw new Error('No encuentro al jugador ' + name);
  const j = await r.json();
  if (!j.success || !j.data || !j.data.player) throw new Error('No encuentro al jugador ' + name);
  return { uuid: j.data.player.id, name: j.data.player.username };
}
function datapacksDir(inst) { return path.join(instDir(inst.name), 'world', 'datapacks'); }

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 7e7) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

const requestHandler = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    const needsSetup = !config.pinHash;
    const authed = !!getSession(req);
    if (p === '/api/panel/auth-state' && req.method === 'GET') {
      return json(res, 200, { needsSetup, authenticated: authed });
    }
    if (p === '/api/setup-pin' && req.method === 'POST') {
      if (!needsSetup) return json(res, 409, { error: 'El PIN ya está configurado' });
      const b = await readBody(req);
      if (!/^\d{4,8}$/.test(String(b.pin || ''))) throw new Error('El PIN debe ser de 4 a 8 dígitos');
      setPin(b.pin);
      newSession(res);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (needsSetup) return json(res, 403, { needsSetup: true, error: 'Configura el PIN primero' });
      const ip = req.socket.remoteAddress || '?';
      const f = loginFails.get(ip);
      if (f && f.until > now()) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
      const b = await readBody(req);
      const ok = hashPin(String(b.pin || ''), config.pinSalt) === config.pinHash;
      if (!ok) {
        const nf = { n: (f ? f.n : 0) + 1, until: 0 };
        if (nf.n >= 5) { nf.until = now() + 5 * 60000; nf.n = 0; }
        loginFails.set(ip, nf);
        return json(res, 401, { error: 'PIN incorrecto' });
      }
      loginFails.delete(ip);
      newSession(res);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = getSession(req);
      if (t) sessions.delete(t);
      res.setHeader('Set-Cookie', 'kh=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) {
      if (needsSetup) return json(res, 403, { needsSetup: true, error: 'Configura el PIN del panel' });
      if (!authed) return json(res, 401, { error: 'Necesitas iniciar sesión con tu PIN' });
    }
    if (p === '/' || p === '/index.html') {
      const k = u.searchParams.get('k');
      if (k) {
        const s = sessions.get(k);
        if (s && s.exp > now()) {
          res.writeHead(302, { 'Set-Cookie': 'kh=' + k + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + 7 * 24 * 3600, Location: '/' });
          return res.end();
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/state' && req.method === 'GET') {
      const out = [];
      for (const inst of instances.values()) out.push({ ...publicState(inst), backups: await listBackups(inst.name) });
      return json(res, 200, { runningName, instances: out, config: { backupIntervalMin: config.backupIntervalMin, rollingKeep: config.rollingKeep, weeklyKeep: config.weeklyKeep } });
    }
    if (p === '/api/log' && req.method === 'GET') {
      const inst = instances.get(u.searchParams.get('inst') || '');
      return json(res, inst ? 200 : 404, inst ? { log: inst.logBuf } : { error: 'no existe' });
    }
    if (p === '/api/versions' && req.method === 'GET') {
      const man = await mojangManifest();
      return json(res, 200, { latest: man.latest.release, versions: man.versions.filter(v => v.type === 'release').slice(0, 12).map(v => v.id) });
    }
    if (p === '/api/instances' && req.method === 'POST') {
      const b = await readBody(req);
      const logs = [];
      const inst = await createInstance(b.name, b.version, m => logs.push(m));
      return json(res, 200, { ok: true, inst: publicState(inst), logs });
    }
    let m = p.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/(start|stop|restart|command|backup)$/);
    if (m && req.method === 'POST') {
      const inst = instances.get(m[1]);
      if (!inst) return json(res, 404, { error: 'no existe' });
      const action = m[2];
      if (action === 'start') { startInstance(inst); return json(res, 200, { ok: true }); }
      if (action === 'stop') { stopInstance(inst); return json(res, 200, { ok: true }); }
      if (action === 'restart') { stopInstance(inst).then(() => startInstance(inst)).catch(e => pushLog(inst, '[panel] Error: ' + e.message, 'error')); return json(res, 200, { ok: true }); }
      if (action === 'command') { const b = await readBody(req); sendCommand(inst, b.cmd); return json(res, 200, { ok: true }); }
      if (action === 'backup') { const f = await backupInstance(inst, 'manual'); return json(res, 200, { ok: true, file: f }); }
    }
    m = p.match(/^\/api\/backups\/([A-Za-z0-9_-]+)\/([^/]+\.zip)$/);
    if (m && req.method === 'DELETE') {
      const f = path.join(BACKUPS_DIR, m[1], path.basename(m[2]));
      await fsp.unlink(f).catch(() => {});
      return json(res, 200, { ok: true, backups: await listBackups(m[1]) });
    }
    m = p.match(/^\/api\/backups\/([A-Za-z0-9_-]+)\/([^/]+\.zip)\/restore$/);
    if (m && req.method === 'POST') {
      const srcName = m[1];
      const zipFile = path.basename(m[2]);
      const src = instances.get(srcName);
      if (!src) return json(res, 404, { error: 'instancia de origen no existe' });
      const b = await readBody(req);
      const newName = String(b.newName || '').trim();
      if (!safeName(newName)) throw new Error('Nombre no válido (usa letras, números, - y _)');
      if (instances.has(newName) || fs.existsSync(instDir(newName))) throw new Error('Ya existe una instancia con ese nombre');
      const zipPath = path.join(BACKUPS_DIR, srcName, zipFile);
      if (!fs.existsSync(zipPath)) return json(res, 404, { error: 'copia no encontrada' });
      const dest = instDir(newName);
      if (MOCK) {
        await fsp.mkdir(path.join(dest, 'world'), { recursive: true });
      } else {
        const tmp = path.join(ROOT, 'backups', '.restore-' + Date.now());
        const q = s => s.replace(/'/g, "''");
        const ps = [
          `$tmp='${q(tmp)}'`, `$dest='${q(dest)}'`, `$srcDir='${q(instDir(srcName))}'`,
          `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath $tmp -Force -ErrorAction Stop`,
          `if (-not (Test-Path "$tmp\\world")) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; throw 'la copia no contiene la carpeta world' }`,
          `New-Item -ItemType Directory -Path $dest -Force | Out-Null`,
          `Move-Item "$tmp\\world" "$dest\\world" -ErrorAction Stop`,
          `Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue`,
          `foreach ($f in 'server.jar','eula.txt','server.properties','ops.json','whitelist.json','bukkit.yml','spigot.yml') { if (Test-Path "$srcDir\\$f") { Copy-Item "$srcDir\\$f" "$dest\\$f" -Force } }`,
          `if (Test-Path "$dest\\world\\session.lock") { Remove-Item "$dest\\world\\session.lock" -Force -ErrorAction SilentlyContinue }`,
        ].join('; ');
        await new Promise((res2, rej) => execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 300000 }, (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res2()));
      }
      await fsp.writeFile(path.join(dest, 'kike-instance.json'), JSON.stringify({ name: newName, version: src.version, createdAt: new Date().toISOString(), restoredFrom: srcName + '/' + zipFile }, null, 2));
      instances.set(newName, {
        name: newName, version: src.version, status: 'offline', proc: null, pid: null,
        startedAt: null, players: new Set(), logBuf: [], maxPlayers: config.maxPlayers, ramMB: null,
      });
      pushLog(src, '[panel] Copia ' + zipFile + ' restaurada como instancia nueva "' + newName + '"', 'panel');
      return json(res, 200, { ok: true, inst: publicState(instances.get(newName)) });
    }
    if (p === '/api/panel/config' && req.method === 'GET') {
      return json(res, 200, { ramMB: config.ramMB || 3072, extraJavaArgs: config.extraJavaArgs || '', backupIntervalMin: config.backupIntervalMin, rollingKeep: config.rollingKeep, weeklyKeep: config.weeklyKeep });
    }
    if (p === '/api/panel/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.ramMB !== undefined) { const v = parseInt(b.ramMB, 10); if (!(v >= 1024 && v <= 24576)) throw new Error('RAM fuera de rango (1-24 GB)'); config.ramMB = v; }
      if (b.extraJavaArgs !== undefined) config.extraJavaArgs = String(b.extraJavaArgs).slice(0, 300);
      if (b.backupIntervalMin !== undefined) { const v = parseInt(b.backupIntervalMin, 10); if (v >= 5 && v <= 1440) config.backupIntervalMin = v; }
      saveConfig();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/panel/pin' && req.method === 'POST') {
      const b = await readBody(req);
      if (hashPin(String(b.current || ''), config.pinSalt) !== config.pinHash) throw new Error('El PIN actual no es ese');
      if (!/^\d{4,8}$/.test(String(b.next || ''))) throw new Error('El PIN nuevo debe ser de 4 a 8 dígitos');
      setPin(b.next);
      return json(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/config(\/raw)?$/);
    if (m) {
      const inst = instances.get(m[1]);
      if (!inst) return json(res, 404, { error: 'no existe' });
      if (req.method === 'GET') { const { props, raw } = readProps(inst); return json(res, 200, { props, raw }); }
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (m[2]) { if (typeof b.raw !== 'string' || b.raw.length > 100000) throw new Error('raw no valido'); fs.writeFileSync(propsPath(inst), b.raw); return json(res, 200, { ok: true }); }
        const updates = {};
        for (const [k, v] of Object.entries(b.props || {})) {
          if (!/^[a-z0-9.-]{1,40}$/i.test(k)) continue;
          updates[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 200);
        }
        writeProps(inst, mergeProps(inst, updates));
        return json(res, 200, { ok: true });
      }
    }
    m = p.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/ops$/);
    if (m) {
      const inst = instances.get(m[1]);
      if (!inst) return json(res, 404, { error: 'no existe' });
      if (req.method === 'GET') return json(res, 200, { ops: readOps(inst) });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const ops = readOps(inst);
        if (b.add) {
          const name = String(b.add).trim();
          if (!/^\w{3,16}$/.test(name)) throw new Error('Nombre de jugador no valido');
          if (inst.proc && inst.status !== 'offline') { sendCommand(inst, 'op ' + name); return json(res, 200, { ok: true, via: 'consola' }); }
          const r = isOnlineMode(inst) ? await resolveUuid(name) : { uuid: offlineUuid(name), name };
          if (!ops.find(o => o.uuid === r.uuid)) { ops.push({ uuid: r.uuid, name: r.name, level: 4, bypassesPlayerLimit: false }); fs.writeFileSync(opsPath(inst), JSON.stringify(ops, null, 2)); }
          return json(res, 200, { ok: true, via: 'archivo' });
        }
        if (b.remove) {
          const name = String(b.remove).trim().toLowerCase();
          if (inst.proc && inst.status !== 'offline') sendCommand(inst, 'deop ' + name);
          fs.writeFileSync(opsPath(inst), JSON.stringify(ops.filter(o => (o.name || '').toLowerCase() !== name), null, 2));
          return json(res, 200, { ok: true });
        }
      }
    }
    m = p.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/whitelist$/);
    if (m) {
      const inst = instances.get(m[1]);
      if (!inst) return json(res, 404, { error: 'no existe' });
      if (req.method === 'GET') {
        return json(res, 200, { enabled: readProps(inst).props['white-list'] === 'true', entries: readWhitelist(inst) });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const live = inst.proc && inst.status !== 'offline';
        if (b.enabled !== undefined) {
          const on = !!b.enabled;
          if (live) sendCommand(inst, 'whitelist ' + (on ? 'on' : 'off'));
          writeProps(inst, mergeProps(inst, { 'white-list': on ? 'true' : 'false' }));
          return json(res, 200, { ok: true, enabled: on });
        }
        if (b.add) {
          const name = String(b.add).trim();
          if (!/^\w{3,16}$/.test(name)) throw new Error('Nombre de jugador no valido');
          if (live) { sendCommand(inst, 'whitelist add ' + name); return json(res, 200, { ok: true, via: 'consola' }); }
          const wl = readWhitelist(inst);
          const r = isOnlineMode(inst) ? await resolveUuid(name) : { uuid: offlineUuid(name), name };
          if (!wl.find(w => (w.name || '').toLowerCase() === name.toLowerCase())) {
            wl.push({ uuid: r.uuid, name: r.name });
            fs.writeFileSync(whitelistPath(inst), JSON.stringify(wl, null, 2));
          }
          return json(res, 200, { ok: true, via: 'archivo' });
        }
        if (b.remove) {
          const name = String(b.remove).trim().toLowerCase();
          if (live) sendCommand(inst, 'whitelist remove ' + name);
          const wl = readWhitelist(inst).filter(w => (w.name || '').toLowerCase() !== name);
          fs.writeFileSync(whitelistPath(inst), JSON.stringify(wl, null, 2));
          return json(res, 200, { ok: true });
        }
      }
    }
    m = p.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/datapacks(\/([^/]+))?$/);
    if (m) {
      const inst = instances.get(m[1]);
      if (!inst) return json(res, 404, { error: 'no existe' });
      const dir = datapacksDir(inst);
      if (req.method === 'GET') {
        const out = [];
        try {
          for (const f of await fsp.readdir(dir, { withFileTypes: true })) {
            if (f.name === 'bukkit') continue;
            const st = await fsp.stat(path.join(dir, f.name));
            out.push({ file: f.name, dir: f.isDirectory(), sizeMB: +(st.size / 1048576).toFixed(2) });
          }
        } catch (_) {}
        return json(res, 200, { datapacks: out });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const fn = path.basename(String(b.filename || ''));
        if (!/^[\w. -]{1,80}\.zip$/i.test(fn)) throw new Error('Solo archivos .zip');
        const buf = Buffer.from(String(b.dataBase64 || ''), 'base64');
        if (!buf.length || buf.length > 50 * 1048576) throw new Error('Datapack vacio o demasiado grande (max 50 MB)');
        if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('No es un zip');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, fn), buf);
        return json(res, 200, { ok: true, file: fn });
      }
      if (req.method === 'DELETE' && m[3]) {
        await fsp.unlink(path.join(dir, path.basename(m[3]))).catch(() => {});
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/panel/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      for (const inst of instances.values()) if (inst.proc) await stopInstance(inst);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    json(res, 404, { error: 'ruta no encontrada' });
  } catch (e) { json(res, 500, { error: e.message }); }
};
const server = http.createServer(requestHandler);

function tailscaleIp() {
  return new Promise(res => {
    if (os.platform() !== 'win32') return res(null);
    execFile('C:\\Program Files\\Tailscale\\tailscale.exe', ['ip', '-4'], (e, out) => {
      const ip = (out || '').split(/\r?\n/)[0].trim();
      res(!e && /^100\./.test(ip) ? ip : null);
    });
  });
}

loadInstances().then(async () => {
  const binds = ['127.0.0.1'];
  const ts = await tailscaleIp().catch(() => null);
  if (ts) binds.push(ts); // panel también desde su móvil/otros equipos de SU tailnet
  let started = 0;
  for (const host of binds) {
    try {
      const srv = host === '127.0.0.1' ? server : http.createServer(requestHandler);
      await new Promise((res2, rej) => { srv.once('error', rej); srv.listen(PANEL_PORT, host, res2); });
      started++; console.log('Escuchando en http://' + host + ':' + PANEL_PORT);
    } catch (e) { console.error('No pude abrir ' + host + ': ' + e.message); }
  }
  if (!started) { console.error('No pude abrir el puerto ' + PANEL_PORT); process.exit(1); }
});

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function modelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

function metadataFile() {
  return path.join(modelsDir(), 'meta.json');
}

function loadMetadata() {
  try {
    if (!fs.existsSync(metadataFile())) return {};
    return JSON.parse(fs.readFileSync(metadataFile(), 'utf8'));
  } catch { return {}; }
}

function saveMetadata(meta) {
  fs.mkdirSync(modelsDir(), { recursive: true });
  fs.writeFileSync(metadataFile(), JSON.stringify(meta, null, 2));
}

function metaKey(ticker, name) {
  return `${ticker.toUpperCase()}/${name}`;
}

function tickerDir(ticker) {
  const safe = String(ticker || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '_');
  return path.join(modelsDir(), safe);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeFilename(name) {
  return String(name || 'unnamed').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
}

function listForTicker(ticker) {
  const dir = tickerDir(ticker);
  if (!fs.existsSync(dir)) return [];
  const meta = loadMetadata();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === 'meta.json') continue;
    const full = path.join(dir, e.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    const m = meta[metaKey(ticker, e.name)] || {};
    files.push({
      ticker: ticker.toUpperCase(),
      name: e.name,
      path: full,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ext: path.extname(e.name).toLowerCase(),
      source: m.source || 'Mine',
      note: m.note || '',
      uploadedAt: m.uploadedAt || stat.mtimeMs,
    });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function listAll() {
  const root = modelsDir();
  if (!fs.existsSync(root)) return [];
  let tickerDirs;
  try { tickerDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const all = [];
  for (const td of tickerDirs) {
    if (!td.isDirectory()) continue;
    const ticker = td.name;
    all.push(...listForTicker(ticker));
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

function updateMeta(ticker, name, patch) {
  const meta = loadMetadata();
  const key = metaKey(ticker, name);
  meta[key] = { ...(meta[key] || {}), ...patch };
  saveMetadata(meta);
  return meta[key];
}

function addFile(ticker, sourcePath, opts = {}) {
  if (!fs.existsSync(sourcePath)) throw new Error('Source file not found');
  const dir = tickerDir(ticker);
  ensureDir(dir);
  const base = safeFilename(path.basename(sourcePath));
  let target = path.join(dir, base);
  if (fs.existsSync(target)) {
    const parsed = path.parse(base);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    target = path.join(dir, `${parsed.name} (${stamp})${parsed.ext}`);
  }
  fs.copyFileSync(sourcePath, target);
  const stat = fs.statSync(target);
  const source = opts.source || 'Mine';
  const note = opts.note || '';
  updateMeta(ticker, path.basename(target), { source, note, uploadedAt: stat.mtimeMs });
  return {
    ticker: ticker.toUpperCase(),
    name: path.basename(target),
    path: target,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ext: path.extname(target).toLowerCase(),
    source,
    note,
  };
}

function removeFile(filePath) {
  // Only allow deletion inside our models directory
  const root = modelsDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Refusing to delete file outside models directory');
  }
  fs.unlinkSync(resolved);
  return true;
}

module.exports = { listForTicker, listAll, addFile, removeFile, updateMeta, modelsDir, tickerDir };

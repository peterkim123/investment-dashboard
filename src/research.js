const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function dataFile() { return path.join(app.getPath('userData'), 'research.json'); }
function filesRoot() { return path.join(app.getPath('userData'), 'research-files'); }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function newId(prefix = 's') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeFilename(name) {
  return String(name || 'unnamed').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
}

function load() {
  try {
    if (!fs.existsSync(dataFile())) return { sections: [], files: [] };
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return {
      sections: Array.isArray(raw.sections) ? raw.sections : [],
      files: Array.isArray(raw.files) ? raw.files : [],
    };
  } catch { return { sections: [], files: [] }; }
}

function save(state) {
  ensureDir(path.dirname(dataFile()));
  fs.writeFileSync(dataFile(), JSON.stringify(state, null, 2));
}

function sectionDir(sectionId) {
  return path.join(filesRoot(), sectionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function listSections(filter = null) {
  const state = load();
  if (filter) return state.sections.filter((s) => s.type === filter);
  return state.sections;
}

function createSection({ type, label, description = '', ticker = null }) {
  if (!['company', 'industry', 'misc'].includes(type)) throw new Error('Invalid section type');
  if (!label || !String(label).trim()) throw new Error('Label required');
  const state = load();
  // For companies, dedupe by ticker
  if (type === 'company') {
    const upper = String(ticker || label).toUpperCase().trim();
    const existing = state.sections.find((s) => s.type === 'company' && s.ticker === upper);
    if (existing) return existing;
    const id = `company:${upper}`;
    const sec = {
      id, type, ticker: upper, label: upper, description: description.trim(),
      isManual: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.sections.push(sec);
    save(state);
    return sec;
  }
  const id = newId(type === 'industry' ? 'ind' : 'misc');
  const sec = {
    id, type, label: String(label).trim(), description: description.trim(),
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.sections.push(sec);
  save(state);
  return sec;
}

function updateSection(id, patch) {
  const state = load();
  const s = state.sections.find((x) => x.id === id);
  if (!s) throw new Error('Section not found');
  if (patch.label != null) s.label = String(patch.label).trim();
  if (patch.description != null) s.description = String(patch.description).trim();
  s.updatedAt = Date.now();
  save(state);
  return s;
}

function deleteSection(id) {
  const state = load();
  const before = state.sections.length;
  state.sections = state.sections.filter((s) => s.id !== id);
  if (state.sections.length === before) throw new Error('Section not found');
  // Also delete files for this section (file index entries + on-disk files)
  const filesForSection = state.files.filter((f) => f.sectionId === id);
  state.files = state.files.filter((f) => f.sectionId !== id);
  save(state);
  // Best-effort delete on-disk files
  for (const f of filesForSection) {
    try { fs.unlinkSync(f.path); } catch {}
  }
  try { fs.rmdirSync(sectionDir(id)); } catch {}
  return true;
}

function listFiles(sectionId = null) {
  const state = load();
  return sectionId ? state.files.filter((f) => f.sectionId === sectionId) : state.files;
}

function addFileFromPath(sectionId, sourcePath, opts = {}) {
  if (!fs.existsSync(sourcePath)) throw new Error('Source file not found');
  const state = load();
  // Allow uploading to a synthetic company section that doesn't exist yet
  let sec = state.sections.find((s) => s.id === sectionId);
  if (!sec && sectionId.startsWith('company:')) {
    const ticker = sectionId.slice(8);
    sec = {
      id: sectionId, type: 'company', ticker, label: ticker,
      description: '', isManual: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.sections.push(sec);
  }
  if (!sec) throw new Error('Section not found');
  ensureDir(sectionDir(sectionId));
  const baseName = safeFilename(path.basename(sourcePath));
  let target = path.join(sectionDir(sectionId), baseName);
  if (fs.existsSync(target)) {
    const parsed = path.parse(baseName);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    target = path.join(sectionDir(sectionId), `${parsed.name} (${stamp})${parsed.ext}`);
  }
  fs.copyFileSync(sourcePath, target);
  const stat = fs.statSync(target);
  const ext = path.extname(target).toLowerCase();
  const isTextExt = ext === '.md' || ext === '.markdown' || ext === '.txt';
  // forceType overrides extension-based detection (e.g. uploading a PDF as a "note")
  const type = opts.forceType === 'note' ? 'note'
             : opts.forceType === 'model' ? 'model'
             : (isTextExt ? 'note' : 'model');
  const f = {
    id: newId('f'),
    sectionId,
    name: path.basename(target),
    path: target,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ext,
    type,
    source: opts.source || (type === 'note' && isTextExt ? null : (opts.source || 'Mine')),
    note: opts.note || '',
    uploadedAt: Date.now(),
  };
  state.files.push(f);
  sec.updatedAt = Date.now();
  save(state);
  return f;
}

function updateFile(id, patch) {
  const state = load();
  const f = state.files.find((x) => x.id === id);
  if (!f) throw new Error('File not found');
  if (patch.source != null) f.source = patch.source;
  if (patch.note != null) f.note = patch.note;
  save(state);
  return f;
}

function deleteFile(id) {
  const state = load();
  const f = state.files.find((x) => x.id === id);
  if (!f) throw new Error('File not found');
  // Security: only allow deletion inside research-files
  const root = path.resolve(filesRoot());
  const resolved = path.resolve(f.path);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to delete file outside research-files');
  }
  try { fs.unlinkSync(resolved); } catch {}
  state.files = state.files.filter((x) => x.id !== id);
  save(state);
  return true;
}

function readNoteContent(fileId) {
  const state = load();
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return null;
  if (f.type !== 'note') return null;
  try {
    const text = fs.readFileSync(f.path, 'utf8');
    return { text, name: f.name, mtimeMs: f.mtimeMs, path: f.path };
  } catch {
    return null;
  }
}

module.exports = {
  load, save,
  listSections, createSection, updateSection, deleteSection,
  listFiles, addFileFromPath, updateFile, deleteFile,
  readNoteContent, sectionDir, filesRoot,
};

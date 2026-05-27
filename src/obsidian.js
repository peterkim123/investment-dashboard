const fs = require('fs');
const path = require('path');

const fileCache = new Map();
const TTL_MS = 60 * 1000;

function listMarkdownFiles(dir, depth = 0, maxDepth = 4, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      listMarkdownFiles(full, depth + 1, maxDepth, out);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: {}, body: text };
  const fmText = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, '');
  const frontmatter = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // Array: [foo, bar] or [foo]
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    frontmatter[m[1].toLowerCase()] = v;
  }
  return { frontmatter, body };
}

function readWithCache(file) {
  const cached = fileCache.get(file);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parseFrontmatter(text);
  const value = { ...parsed, mtimeMs: stat.mtimeMs, size: stat.size };
  fileCache.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

function tickerMatchesFrontmatter(fm, target) {
  const upper = target.toUpperCase();
  const candidates = [];
  for (const key of ['ticker', 'tickers', 'symbol', 'symbols']) {
    const v = fm[key];
    if (v == null) continue;
    if (Array.isArray(v)) candidates.push(...v);
    else candidates.push(v);
  }
  return candidates.some((c) => String(c).toUpperCase().trim() === upper);
}

function findNoteForTicker(vaultPath, ticker) {
  if (!vaultPath || !ticker) return null;
  if (!fs.existsSync(vaultPath)) return null;
  const upper = ticker.toUpperCase();
  const files = listMarkdownFiles(vaultPath);
  // Priority 1: exact filename match
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    if (base.toUpperCase() === upper) return f;
  }
  // Priority 2: filename starts with TICKER followed by non-alphanumeric (e.g. "AAPL - Apple.md")
  const re = new RegExp(`^${upper}([^A-Za-z0-9]|$)`);
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    if (re.test(base.toUpperCase())) return f;
  }
  // Priority 3: frontmatter property
  for (const f of files) {
    const parsed = readWithCache(f);
    if (parsed && tickerMatchesFrontmatter(parsed.frontmatter, upper)) return f;
  }
  return null;
}

function vaultNameFromPath(vaultPath) {
  if (!vaultPath) return '';
  return path.basename(vaultPath.replace(/[\\/]$/, ''));
}

function obsidianUrlFor(vaultPath, notePath) {
  const vault = vaultNameFromPath(vaultPath);
  const rel = path.relative(vaultPath, notePath).replace(/\\/g, '/');
  const noExt = rel.replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(noExt)}`;
}

async function getNoteForTicker(vaultPath, ticker) {
  if (!vaultPath) return { ok: false, configured: false };
  if (!fs.existsSync(vaultPath)) return { ok: false, error: 'Vault folder not found' };
  const notePath = findNoteForTicker(vaultPath, ticker);
  if (!notePath) return { ok: true, found: false, vault: vaultNameFromPath(vaultPath) };
  const parsed = readWithCache(notePath);
  if (!parsed) return { ok: false, error: 'Could not read note' };
  return {
    ok: true,
    found: true,
    notePath,
    filename: path.basename(notePath),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    mtimeMs: parsed.mtimeMs,
    size: parsed.size,
    obsidianUrl: obsidianUrlFor(vaultPath, notePath),
    vault: vaultNameFromPath(vaultPath),
  };
}

const CATEGORY_RULES = [
  { id: 'companies', label: 'Companies', folders: ['companies', 'company', 'stocks', 'tickers', 'names', 'positions'] },
  { id: 'sectors',   label: 'Sectors',   folders: ['sectors', 'sector', 'industries', 'industry'] },
  { id: 'themes',    label: 'Themes',    folders: ['themes', 'theme', 'thesis', 'topics', 'macro', 'macros'] },
  { id: 'rx',        label: 'Rx / Healthcare', folders: ['rx', 'pharma', 'biotech', 'healthcare', 'pharmaceuticals'] },
];

function categorizeByPath(filePath, vaultPath) {
  const rel = path.relative(vaultPath, filePath);
  const parts = rel.split(/[\\/]/).slice(0, -1).map((s) => s.toLowerCase());
  for (const rule of CATEGORY_RULES) {
    if (parts.some((p) => rule.folders.includes(p))) {
      return { id: rule.id, label: rule.label };
    }
  }
  return { id: 'other', label: 'Other' };
}

function categorizeByFrontmatter(frontmatter) {
  const t = (frontmatter?.type || frontmatter?.category || '').toString().toLowerCase().trim();
  if (!t) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.id === t || rule.label.toLowerCase() === t || rule.folders.includes(t)) {
      return { id: rule.id, label: rule.label };
    }
  }
  return null;
}

function extractTickersFromFrontmatter(fm) {
  const out = new Set();
  for (const key of ['ticker', 'tickers', 'symbol', 'symbols']) {
    const v = fm?.[key];
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => out.add(String(x).toUpperCase().trim()));
    else out.add(String(v).toUpperCase().trim());
  }
  return [...out].filter(Boolean);
}

function detectTickerFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Pattern 1: TICKER (1-6 uppercase letters or digits, with optional . separators like BRK.B)
  const m1 = /^([A-Z][A-Z0-9.]{0,6})(\s|-|—|_|\.|$)/.exec(base);
  if (m1) {
    const candidate = m1[1].replace(/\.$/, '');
    if (candidate.length >= 1 && candidate.length <= 6) return candidate;
  }
  return null;
}

async function listAllNotes(vaultPath) {
  if (!vaultPath || !fs.existsSync(vaultPath)) return [];
  const files = listMarkdownFiles(vaultPath);
  const notes = [];
  for (const f of files) {
    const parsed = readWithCache(f);
    if (!parsed) continue;
    const cat = categorizeByFrontmatter(parsed.frontmatter) || categorizeByPath(f, vaultPath);
    const fmTickers = extractTickersFromFrontmatter(parsed.frontmatter);
    const filenameTicker = detectTickerFromFilename(f);
    const tickers = [...new Set([...fmTickers, ...(filenameTicker ? [filenameTicker] : [])])];
    // If a ticker is detected, force category to 'companies' (overrides folder-based)
    const finalCat = tickers.length > 0 ? { id: 'companies', label: 'Companies' } : cat;
    notes.push({
      notePath: f,
      filename: path.basename(f),
      title: (parsed.frontmatter?.title || path.basename(f, path.extname(f))).toString(),
      relPath: path.relative(vaultPath, f).replace(/\\/g, '/'),
      category: finalCat,
      tickers,
      frontmatter: parsed.frontmatter,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      obsidianUrl: obsidianUrlFor(vaultPath, f),
    });
  }
  notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return notes;
}

async function readNote(notePath) {
  const parsed = readWithCache(notePath);
  if (!parsed) return null;
  return parsed;
}

module.exports = {
  getNoteForTicker,
  findNoteForTicker,
  listMarkdownFiles,
  listAllNotes,
  readNote,
  obsidianUrlFor,
  vaultNameFromPath,
  CATEGORY_RULES,
};

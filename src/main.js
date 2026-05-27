const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');

const market = require('./yahoo-direct');
const edgar = require('./edgar');
const metrics = require('./metrics');
const storage = require('./storage');
const sync = require('./sync');
const earnings = require('./earnings');
const obsidian = require('./obsidian');
const models = require('./models');
const research = require('./research');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#000000',
    title: 'PK Terminal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const ANNUAL_RISK_FREE = 0.043;

ipcMain.handle('positions:load', () => storage.loadPositions());

ipcMain.handle('positions:save', (_e, positions) => {
  storage.savePositions(positions);
  return { ok: true };
});

ipcMain.handle('watchlist:load', () => storage.loadWatchlist());

ipcMain.handle('watchlist:save', (_e, items) => {
  storage.saveWatchlist(items);
  return { ok: true };
});

ipcMain.handle('earnings:batch', async (_e, symbols) => {
  try {
    return { ok: true, data: await earnings.getEarningsBatch(symbols || []) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), data: {} };
  }
});

ipcMain.handle('alerts:load', () => storage.loadAlerts());

ipcMain.handle('alerts:save', (_e, alerts) => {
  storage.saveAlerts(Array.isArray(alerts) ? alerts : []);
  return { ok: true };
});

ipcMain.handle('portfolios:state', () => {
  const s = storage.loadPortfolios();
  return {
    active: s.active,
    portfolios: s.portfolios.map((p) => ({ id: p.id, name: p.name, count: (p.positions || []).length })),
  };
});

ipcMain.handle('portfolios:setActive', (_e, id) => {
  const state = storage.loadPortfolios();
  if (!state.portfolios.find((p) => p.id === id)) return { ok: false, error: 'unknown portfolio' };
  state.active = id;
  storage.savePortfolios(state);
  return { ok: true };
});

ipcMain.handle('portfolios:create', (_e, name) => {
  const state = storage.loadPortfolios();
  const trimmed = String(name || '').trim() || 'Untitled';
  const id = storage.newId();
  state.portfolios.push({
    id, name: trimmed, positions: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  state.active = id;
  storage.savePortfolios(state);
  return { ok: true, id };
});

ipcMain.handle('portfolios:rename', (_e, { id, name }) => {
  const state = storage.loadPortfolios();
  const p = state.portfolios.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'unknown portfolio' };
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, error: 'name required' };
  p.name = trimmed;
  p.updatedAt = Date.now();
  storage.savePortfolios(state);
  return { ok: true };
});

ipcMain.handle('portfolios:delete', (_e, id) => {
  const state = storage.loadPortfolios();
  if (state.portfolios.length <= 1) return { ok: false, error: 'must keep at least one portfolio' };
  state.portfolios = state.portfolios.filter((p) => p.id !== id);
  if (state.active === id) state.active = state.portfolios[0].id;
  storage.savePortfolios(state);
  return { ok: true, newActive: state.active };
});

ipcMain.handle('settings:load', () => storage.loadSettings());

ipcMain.handle('settings:save', (_e, settings) => {
  storage.saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('quotes:get', async (_e, symbols) => market.getQuotes(symbols));

ipcMain.handle('quote:single', async (_e, symbol) => {
  try {
    return { ok: true, quote: await market.getQuote(symbol) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('history:get', async (_e, { symbol, range }) => {
  try {
    const rows = await market.getHistorical(symbol, range || '1Y');
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), rows: [] };
  }
});

ipcMain.handle('symbol:search', async (_e, query) => market.search(query));

ipcMain.handle('news:get', async (_e, { symbol, limit }) => {
  return market.getNews(symbol, limit ?? 10);
});

ipcMain.handle('filings:get', async (_e, { symbol, lookbackDays, max }) => {
  try {
    return await edgar.getRecentFilings(symbol, lookbackDays ?? 90, max ?? 25);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), filings: [] };
  }
});

ipcMain.handle('metrics:compute', async (_e, { symbol, purchaseDate }) => {
  try {
    const now = new Date();
    const purchase = new Date(purchaseDate);
    const oneYearAgo = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
    const earliest = purchase < oneYearAgo ? purchase : oneYearAgo;
    const sinceCutoff = purchase > new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
      ? new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
      : purchase;

    const [stockHist, benchHist] = await Promise.all([
      market.getDailyHistorySince(symbol, earliest),
      market.getDailyHistorySince('SPY', earliest),
    ]);

    const stockSince = stockHist.filter((r) => r.date >= sinceCutoff);
    const benchSince = benchHist.filter((r) => r.date >= sinceCutoff);
    const stock1Y = stockHist.filter((r) => r.date >= oneYearAgo);
    const bench1Y = benchHist.filter((r) => r.date >= oneYearAgo);

    return {
      ok: true,
      sincePurchase: metrics.computeForSeries(stockSince, benchSince, ANNUAL_RISK_FREE),
      trailing1Y: metrics.computeForSeries(stock1Y, bench1Y, ANNUAL_RISK_FREE),
      riskFreeRate: ANNUAL_RISK_FREE,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (typeof url !== 'string') return { ok: false };
  if (!/^(https?|obsidian):\/\//i.test(url)) return { ok: false, error: 'Disallowed URL scheme' };
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (typeof p !== 'string') return { ok: false };
  const err = await shell.openPath(p);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

ipcMain.handle('shell:revealInFolder', async (_e, p) => {
  if (typeof p !== 'string') return { ok: false };
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('dialog:openFolder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Select your Obsidian vault folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
  const win = BrowserWindow.getFocusedWindow();
  const dialogOpts = {
    title: opts.title || 'Select file',
    properties: ['openFile', 'multiSelections'],
  };
  // Only attach filter list if caller actually provided one with entries —
  // omitting `filters` lets Windows show every file by default.
  if (Array.isArray(opts.filters) && opts.filters.length > 0) {
    dialogOpts.filters = opts.filters;
  }
  const result = await dialog.showOpenDialog(win, dialogOpts);
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, paths: result.filePaths };
});

ipcMain.handle('obsidian:get', async (_e, ticker) => {
  const settings = storage.loadSettings();
  return obsidian.getNoteForTicker(settings.obsidianVaultPath, ticker);
});

ipcMain.handle('obsidian:listAll', async () => {
  const settings = storage.loadSettings();
  try {
    return { ok: true, vault: settings.obsidianVaultPath || '', notes: await obsidian.listAllNotes(settings.obsidianVaultPath) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), notes: [] };
  }
});

ipcMain.handle('obsidian:read', async (_e, notePath) => {
  const settings = storage.loadSettings();
  if (!settings.obsidianVaultPath) return { ok: false, error: 'No vault path' };
  // Security: only allow reads within the vault
  const root = path.resolve(settings.obsidianVaultPath);
  const resolved = path.resolve(notePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { ok: false, error: 'Path outside vault' };
  }
  try {
    const parsed = await obsidian.readNote(resolved);
    if (!parsed) return { ok: false, error: 'Note not found' };
    return {
      ok: true,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      notePath: resolved,
      obsidianUrl: obsidian.obsidianUrlFor(settings.obsidianVaultPath, resolved),
      filename: path.basename(resolved),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('models:list', async (_e, ticker) => {
  try {
    return { ok: true, files: models.listForTicker(ticker) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), files: [] };
  }
});

ipcMain.handle('models:listAll', async () => {
  try {
    return { ok: true, files: models.listAll() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), files: [] };
  }
});

ipcMain.handle('models:add', async (_e, { ticker, sourcePaths, source, note }) => {
  try {
    const added = [];
    for (const p of sourcePaths || []) {
      added.push(models.addFile(ticker, p, { source, note }));
    }
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('models:updateMeta', async (_e, { ticker, name, source, note }) => {
  try {
    const m = models.updateMeta(ticker, name, { source, note });
    return { ok: true, meta: m };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// ─── Research sections + files ──────────────────────────────────────────────

ipcMain.handle('research:state', async () => {
  try {
    return { ok: true, ...research.load() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), sections: [], files: [] };
  }
});

ipcMain.handle('research:createSection', async (_e, payload) => {
  try {
    return { ok: true, section: research.createSection(payload) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:updateSection', async (_e, { id, patch }) => {
  try {
    return { ok: true, section: research.updateSection(id, patch) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:deleteSection', async (_e, id) => {
  try {
    research.deleteSection(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:addFiles', async (_e, { sectionId, sourcePaths, source, note, forceType }) => {
  try {
    const added = [];
    for (const p of sourcePaths || []) {
      added.push(research.addFileFromPath(sectionId, p, { source, note, forceType }));
    }
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:updateFile', async (_e, { id, patch }) => {
  try {
    return { ok: true, file: research.updateFile(id, patch) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:deleteFile', async (_e, id) => {
  try {
    research.deleteFile(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('research:readNote', async (_e, fileId) => {
  try {
    const r = research.readNoteContent(fileId);
    if (!r) return { ok: false, error: 'Not a note or not found' };
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('models:remove', async (_e, filePath) => {
  try {
    models.removeFile(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('rf:get', async () => ANNUAL_RISK_FREE);

ipcMain.handle('sync:test', async (_e, { url, token }) => sync.test(url, token));

ipcMain.handle('sync:pull', async () => {
  const s = storage.loadSettings();
  if (!s.syncUrl || !s.syncToken) return { ok: false, configured: false };
  try {
    const res = await sync.pull(s.syncUrl, s.syncToken);
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true, error: res.data?.error || 'Auth failed' };
    if (!res.ok) return { ok: false, error: res.data?.error || `HTTP ${res.status}` };
    return { ok: true, version: res.data?.version || 0, positions: res.data?.positions || [], updatedAt: res.data?.updatedAt };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('sync:push', async (_e, { positions }) => {
  const s = storage.loadSettings();
  if (!s.syncUrl || !s.syncToken) return { ok: false, configured: false };
  try {
    const res = await sync.push(s.syncUrl, s.syncToken, positions, s.syncVersion || 0);
    if (res.status === 409) {
      return { ok: false, conflict: true, current: res.data?.current };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true, error: res.data?.error };
    if (!res.ok) return { ok: false, error: res.data?.error || `HTTP ${res.status}` };
    storage.saveSettings({ ...s, syncVersion: res.data?.version || 0, lastSyncAt: res.data?.updatedAt });
    return { ok: true, version: res.data?.version || 0, updatedAt: res.data?.updatedAt };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('sync:setBaseVersion', async (_e, version) => {
  const s = storage.loadSettings();
  storage.saveSettings({ ...s, syncVersion: version || 0, lastSyncAt: new Date().toISOString() });
  return { ok: true };
});

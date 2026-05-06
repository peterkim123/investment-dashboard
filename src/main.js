const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const market = require('./yahoo-direct');
const edgar = require('./edgar');
const metrics = require('./metrics');
const storage = require('./storage');
const sync = require('./sync');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1116',
    title: 'Investment Dashboard',
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
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs allowed' };
  shell.openExternal(url);
  return { ok: true };
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

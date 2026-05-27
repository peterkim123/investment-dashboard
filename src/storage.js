const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const POSITIONS_FILE = () => path.join(app.getPath('userData'), 'positions.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const WATCHLIST_FILE = () => path.join(app.getPath('userData'), 'watchlist.json');
const PORTFOLIOS_FILE = () => path.join(app.getPath('userData'), 'portfolios.json');
const ALERTS_FILE = () => path.join(app.getPath('userData'), 'alerts.json');

function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Failed to read ${file}:`, e);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadPortfolios() {
  const file = PORTFOLIOS_FILE();
  if (fs.existsSync(file)) {
    const state = readJson(file, null);
    if (state && Array.isArray(state.portfolios) && state.portfolios.length > 0) {
      if (!state.portfolios.find((p) => p.id === state.active)) {
        state.active = state.portfolios[0].id;
      }
      return state;
    }
  }
  const legacyPositions = readJson(POSITIONS_FILE(), []);
  const id = newId();
  const state = {
    active: id,
    portfolios: [{
      id,
      name: 'Main',
      positions: Array.isArray(legacyPositions) ? legacyPositions : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  };
  writeJson(file, state);
  return state;
}

function savePortfolios(state) {
  writeJson(PORTFOLIOS_FILE(), state);
}

function getActivePortfolio() {
  const state = loadPortfolios();
  return state.portfolios.find((p) => p.id === state.active) || state.portfolios[0] || null;
}

function loadPositions() {
  const p = getActivePortfolio();
  return p ? p.positions || [] : [];
}

function savePositions(positions) {
  const state = loadPortfolios();
  const p = state.portfolios.find((x) => x.id === state.active) || state.portfolios[0];
  if (!p) return;
  p.positions = Array.isArray(positions) ? positions : [];
  p.updatedAt = Date.now();
  savePortfolios(state);
}

function loadSettings() {
  const defaults = {
    autoRefresh: true,
    refreshIntervalSec: 30,
    syncUrl: '',
    syncToken: '',
    syncVersion: 0,
    lastSyncAt: null,
    leftSplitTopFraction: 0.6,
    mainSplitLeftFraction: 0.5,
    filingFilters: [],
    filingYears: [],
    obsidianVaultPath: '',
  };
  return { ...defaults, ...readJson(SETTINGS_FILE(), {}) };
}

function saveSettings(settings) {
  writeJson(SETTINGS_FILE(), settings);
}

function loadWatchlist() {
  return readJson(WATCHLIST_FILE(), []);
}

function saveWatchlist(items) {
  writeJson(WATCHLIST_FILE(), items);
}

function loadAlerts() {
  return readJson(ALERTS_FILE(), []);
}

function saveAlerts(alerts) {
  writeJson(ALERTS_FILE(), alerts);
}

module.exports = {
  loadPositions, savePositions,
  loadSettings, saveSettings,
  loadWatchlist, saveWatchlist,
  loadPortfolios, savePortfolios, getActivePortfolio, newId,
  loadAlerts, saveAlerts,
};

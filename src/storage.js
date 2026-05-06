const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const POSITIONS_FILE = () => path.join(app.getPath('userData'), 'positions.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const WATCHLIST_FILE = () => path.join(app.getPath('userData'), 'watchlist.json');

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

function loadPositions() {
  return readJson(POSITIONS_FILE(), []);
}

function savePositions(positions) {
  writeJson(POSITIONS_FILE(), positions);
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
    filingFilters: [],
    filingYears: [],
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

module.exports = { loadPositions, savePositions, loadSettings, saveSettings, loadWatchlist, saveWatchlist };

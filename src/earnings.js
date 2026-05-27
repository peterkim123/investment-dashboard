const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_FILE = () => path.join(app.getPath('userData'), 'earnings-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_DAYS = 70; // ~10 weeks forward; covers quarterly cycle for any name

let memLookup = null;
let memLookupAt = 0;
let inflight = null;

function fetchJSON(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      const status = res.statusCode || 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (status < 200 || status >= 300) return reject(new Error(`Nasdaq HTTP ${status}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Nasdaq request timed out')));
  });
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function loadDiskCache() {
  try {
    const f = CACHE_FILE();
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (raw && raw.at && Date.now() - raw.at < TTL_MS && raw.data) {
      return { at: raw.at, data: raw.data };
    }
  } catch {}
  return null;
}

function saveDiskCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ at: Date.now(), data }, null, 2));
  } catch (e) {
    console.error('earnings cache write failed:', e.message);
  }
}

function normalizeTime(t) {
  if (!t) return null;
  if (/after-hours/i.test(t)) return 'AMC';
  if (/pre-market/i.test(t)) return 'BMO';
  if (/not-supplied/i.test(t)) return null;
  return null;
}

async function buildLookup() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue; // skip weekends
    dates.push(fmtDate(d));
  }
  const data = {};
  const batchSize = 6;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((d) =>
        fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`)
          .then((j) => ({ d, rows: j.data?.rows || [] }))
          .catch(() => ({ d, rows: [] })),
      ),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { d, rows } = r.value;
      for (const row of rows) {
        const sym = (row.symbol || '').toUpperCase();
        if (!sym) continue;
        if (data[sym] && data[sym].date <= d) continue;
        data[sym] = {
          date: d,
          time: normalizeTime(row.time),
          epsForecast: row.epsForecast || null,
          numEstimates: row.noOfEsts != null ? parseInt(row.noOfEsts, 10) || null : null,
          fiscalQuarter: row.fiscalQuarterEnding || null,
          lastYearDate: row.lastYearRptDt || null,
          lastYearEPS: row.lastYearEPS || null,
          name: row.name || null,
        };
      }
    }
  }
  return data;
}

async function getLookup({ force = false } = {}) {
  if (!force && memLookup && Date.now() - memLookupAt < TTL_MS) return memLookup;
  if (!force) {
    const disk = loadDiskCache();
    if (disk) {
      memLookup = disk.data;
      memLookupAt = disk.at;
      return memLookup;
    }
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await buildLookup();
      memLookup = data;
      memLookupAt = Date.now();
      saveDiskCache(data);
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function getEarnings(symbol) {
  const m = await getLookup();
  return m[symbol.toUpperCase()] || null;
}

async function getEarningsBatch(symbols) {
  const m = await getLookup();
  const out = {};
  for (const s of symbols || []) {
    const k = (s || '').toUpperCase();
    if (k) out[k] = m[k] || null;
  }
  return out;
}

module.exports = { getEarnings, getEarningsBatch, getLookup };

'use strict';

const fmtUSD = (v, signed = false) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  return signed && v > 0 ? '+' + s : s;
};

const ZERO_DECIMAL_CCY = new Set(['JPY', 'KRW', 'CLP', 'IDR', 'VND', 'HUF']);
function fmtPriceForQuote(value, currency = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  const ccy = (currency || 'USD').toUpperCase();
  const zeroDp = ZERO_DECIMAL_CCY.has(ccy);
  try {
    return value.toLocaleString('en-US', {
      style: 'currency',
      currency: ccy,
      maximumFractionDigits: zeroDp ? 0 : 2,
      minimumFractionDigits: zeroDp ? 0 : 2,
    });
  } catch {
    // Unknown currency code — fall back to USD-style number with code prefix
    return `${ccy} ${value.toLocaleString('en-US', { maximumFractionDigits: zeroDp ? 0 : 2 })}`;
  }
}
const fmtPct = (v, signed = true) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(2) + '%';
  return signed && v > 0 ? '+' + s : s;
};
const fmtNum = (v, dp = 2) => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(dp);
};
const signClass = (v) => (v == null || !Number.isFinite(v) || v === 0 ? 'dim' : v > 0 ? 'gain' : 'loss');

const MIN_IRR_DAYS = 14;

function daysBetween(d1, d2) {
  return (new Date(d2).getTime() - new Date(d1).getTime()) / 86400000;
}

function simpleAnnualReturn(initialCost, currentValue, days) {
  if (!(initialCost > 0) || !(currentValue > 0) || !(days >= MIN_IRR_DAYS)) return null;
  return Math.pow(currentValue / initialCost, 365.25 / days) - 1;
}

function npv(rate, flows) {
  if (rate <= -0.999999) return null;
  const t0 = flows[0].date.getTime();
  let v = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / (365.25 * 86400000);
    v += f.amount / Math.pow(1 + rate, years);
  }
  return v;
}

function dnpv(rate, flows) {
  const t0 = flows[0].date.getTime();
  let d = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / (365.25 * 86400000);
    d += -years * f.amount / Math.pow(1 + rate, years + 1);
  }
  return d;
}

function irr(flows, guess = 0.1) {
  if (!flows || flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => a.date - b.date);
  if (!sorted.some((f) => f.amount > 0) || !sorted.some((f) => f.amount < 0)) return null;
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const v = npv(r, sorted);
    if (v == null) break;
    if (Math.abs(v) < 1e-7) return r;
    const d = dnpv(r, sorted);
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - r) < 1e-7) return next;
    r = next;
  }
  return null;
}

function portfolioIRR(positions, quotes) {
  const flows = [];
  let totalCurrent = 0;
  let earliestPurchase = null;
  for (const p of positions) {
    const q = quotes[p.symbol];
    if (!q || !Number.isFinite(q.regularMarketPrice)) continue;
    const buyDate = new Date(p.purchaseDate);
    if (!earliestPurchase || buyDate < earliestPurchase) earliestPurchase = buyDate;
    flows.push({ date: buyDate, amount: -p.shares * p.avgCost });
    totalCurrent += p.shares * q.regularMarketPrice;
  }
  if (flows.length === 0 || !earliestPurchase) return null;
  const days = daysBetween(earliestPurchase, new Date());
  if (days < MIN_IRR_DAYS) return null;
  flows.push({ date: new Date(), amount: totalCurrent });
  return irr(flows);
}

let positions = [];
let watchlist = [];
let currentFilings = [];
let filingFilters = new Set();
let filingYears = new Set();
let portfolioState = { active: null, portfolios: [] };
let allAlerts = [];
let earningsByTicker = {};
let activeView = 'dashboard';

// Research tab state
let researchNotes = [];        // Obsidian-detected notes (passive backup)
let researchSearch = '';
let researchLoaded = false;
let researchActiveTab = 'companies';
let researchSections = [];      // user-created sections (sourced from research.json)
let researchFiles = [];         // uploaded files (sourced from research.json)
let drillSectionId = null;      // currently drilled section
let drillNoteViewerId = null;   // currently previewed note file id
let notesSortBy = 'date';       // 'name' | 'type' | 'size' | 'date'
let notesSortDir = 'desc';      // 'asc' | 'desc'
let modelsSortBy = 'date';
let modelsSortDir = 'desc';
let quotes = {};
let metricsCache = {};
let selectedSymbol = null;
let selectedSource = null;
let currentRange = '1M';
let priceChart = null;
let refreshTimer = null;
let syncPollTimer = null;
let benchmark1Y = null;
let syncConfigured = false;

const $ = (id) => document.getElementById(id);

let _toastWrap = null;
function toast(msg, type = 'success', durationMs) {
  if (!_toastWrap) {
    _toastWrap = document.createElement('div');
    _toastWrap.className = 'toast-wrap';
    document.body.appendChild(_toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  _toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  const ms = durationMs ?? (type === 'error' ? 4500 : 2200);
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

function setBusy(btn, busyLabel) {
  if (!btn) return () => {};
  const original = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-inline"></span>${busyLabel ?? ''}`;
  return () => {
    btn.innerHTML = original;
    btn.disabled = wasDisabled;
  };
}

function setRefreshSpinning(on) {
  const btn = $('refresh-btn');
  if (!btn) return;
  btn.classList.toggle('spinning', !!on);
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  portfolioState = await window.api.portfolios.state();
  positions = await window.api.positions.load();
  watchlist = await window.api.watchlist.load();
  allAlerts = await window.api.alerts.load();
  const settings = await window.api.settings.load();
  $('auto-refresh').checked = !!settings.autoRefresh;
  syncConfigured = !!(settings.syncUrl && settings.syncToken);
  updateSyncStatus(syncConfigured ? 'idle' : 'offline');
  applySplitFraction(settings.leftSplitTopFraction || 0.6);
  applyMainSplitFraction(settings.mainSplitLeftFraction || 0.5);
  filingFilters = new Set(settings.filingFilters || []);
  filingYears = new Set((settings.filingYears || []).map(String));
  syncFilingPills();

  bindEvents();
  setupLeftSplitter();
  setupMainSplitter();
  bindFilingFilterPills();
  bindPortfolioControls();
  bindViewTabs();
  bindResearchView();
  bindReaderModal();
  bindUploadModal();
  refreshPortfolioUI();

  if (syncConfigured) {
    await pullFromCloud({ silent: true });
  }
  await refreshAll();
  updateMarketStatus();
  setInterval(updateMarketStatus, 30 * 1000);
  scheduleAutoRefresh(settings);
  scheduleSyncPoll();
}

function bindEvents() {
  $('refresh-btn').addEventListener('click', () => refreshAll({ manual: true }));
  $('auto-refresh').addEventListener('change', async (e) => {
    const settings = await window.api.settings.load();
    settings.autoRefresh = e.target.checked;
    await window.api.settings.save(settings);
    scheduleAutoRefresh(settings);
  });

  $('add-position-btn').addEventListener('click', openAddModal);
  $('add-modal-close').addEventListener('click', closeAddModal);
  $('add-cancel').addEventListener('click', closeAddModal);
  $('add-save').addEventListener('click', saveNewPosition);
  document.querySelectorAll('.input-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setAddInputMode(btn.dataset.mode));
  });
  $('add-shares').addEventListener('input', updateAddPreview);
  $('add-total').addEventListener('input', updateAddPreview);
  $('add-cost').addEventListener('input', updateAddPreview);

  $('settings-btn').addEventListener('click', openSettingsModal);
  $('settings-modal-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('settings-cancel').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('settings-test').addEventListener('click', testSyncSettings);
  $('settings-save').addEventListener('click', saveSyncSettings);
  $('settings-vault-browse').addEventListener('click', browseVaultFolder);
  $('notes-open-obsidian').addEventListener('click', openCurrentNoteInObsidian);
  $('models-upload').addEventListener('click', uploadModelForCurrentTicker);

  $('add-watch-btn').addEventListener('click', openWatchModal);
  $('watch-modal-close').addEventListener('click', closeWatchModal);
  $('watch-cancel').addEventListener('click', closeWatchModal);
  $('watch-save').addEventListener('click', saveNewWatchItem);
  const watchInput = $('watch-ticker');
  let watchSearchTimer = null;
  watchInput.addEventListener('input', () => {
    if (watchSearchTimer) clearTimeout(watchSearchTimer);
    watchSearchTimer = setTimeout(() => runWatchSearch(normalizeTicker(watchInput.value)), 200);
  });
  watchInput.addEventListener('blur', () => {
    setTimeout(() => $('watch-suggestions').classList.add('hidden'), 150);
  });

  const tickerInput = $('add-ticker');
  let searchTimer = null;
  tickerInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSymbolSearch(normalizeTicker(tickerInput.value)), 200);
  });
  tickerInput.addEventListener('blur', () => {
    setTimeout(() => $('add-suggestions').classList.add('hidden'), 150);
  });

  document.querySelectorAll('.range-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      if (selectedSymbol) loadChart(selectedSymbol, currentRange);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAddModal();
    if ((e.key === 'r' || e.key === 'R') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      refreshAll({ manual: true });
    }
  });
}

function isMarketHours() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ny = new Date(utc - 4 * 60 * 60 * 1000);
  const day = ny.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ny.getHours() * 60 + ny.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function updateMarketStatus() {
  const open = isMarketHours();
  const el = $('market-status');
  el.textContent = open ? '● Market open' : '● Market closed';
  el.className = 'market-status ' + (open ? 'open' : 'closed');
}

function scheduleAutoRefresh(settings) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!settings.autoRefresh) return;
  const interval = (settings.refreshIntervalSec || 30) * 1000;
  refreshTimer = setInterval(() => {
    if (isMarketHours()) refreshAll();
  }, interval);
}

async function refreshAll(opts = {}) {
  const manual = !!opts.manual;
  setRefreshSpinning(true);
  try {
    // Always reload alerts from disk — picks up any out-of-band updates to alerts.json
    allAlerts = await window.api.alerts.load();
    if (selectedSymbol) renderAlerts(selectedSymbol);

    const allSymbols = [
      ...positions.map((p) => p.symbol),
      ...watchlist.map((w) => w.symbol),
    ];
    if (allSymbols.length === 0) {
      renderTable();
      renderWatchlist();
      renderHeader();
      $('last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;
      if (manual) {
        if (activeView === 'research') {
          loadResearchData();
          toast('Research loaded');
        } else {
          toast('Nothing to refresh yet — add a position', 'info');
        }
      }
      return;
    }
    const results = await window.api.quotes.getMany(allSymbols);
    quotes = {};
    let okCount = 0;
    for (const r of results) {
      if (r.ok && r.quote) { quotes[r.symbol] = r.quote; okCount++; }
    }
    if (!benchmark1Y) {
      const spy = await window.api.history('SPY', '1Y');
      if (spy.ok && spy.rows.length >= 2) {
        const closes = spy.rows.map((r) => r.adjclose ?? r.close);
        benchmark1Y = closes[closes.length - 1] / closes[0] - 1;
      }
    }
    await ensureMetrics();
    fetchEarnings(allSymbols);
    renderTable();
    renderWatchlist();
    renderHeader();
    $('last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;

    if (selectedSymbol && quotes[selectedSymbol]) {
      updateDetailHeader(selectedSymbol);
    }
    if (manual) {
      if (activeView === 'research') {
        loadResearchData();
        toast(`Research loaded`);
      } else if (okCount === allSymbols.length) {
        toast(`Refreshed ${okCount} ${okCount === 1 ? 'quote' : 'quotes'}`);
      } else {
        toast(`Refreshed ${okCount} of ${allSymbols.length} — some failed`, 'error');
      }
    }
  } catch (e) {
    console.error('Refresh failed:', e);
    $('last-refresh').textContent = 'Refresh failed';
    if (manual) toast(`Refresh failed: ${e.message || e}`, 'error');
  } finally {
    setRefreshSpinning(false);
  }
}

async function ensureMetrics() {
  const tasks = [];
  for (const p of positions) {
    if (!metricsCache[p.symbol]) {
      tasks.push(
        window.api.metrics(p.symbol, p.purchaseDate).then((m) => {
          metricsCache[p.symbol] = m;
        }),
      );
    }
  }
  const oneYearAgo = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
  for (const w of watchlist) {
    if (!metricsCache[w.symbol]) {
      tasks.push(
        window.api.metrics(w.symbol, oneYearAgo).then((m) => {
          metricsCache[w.symbol] = m;
        }),
      );
    }
  }
  await Promise.allSettled(tasks);
}

function renderTable() {
  const tbody = $('positions-tbody');
  if (positions.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="13">No positions yet — click <strong>+ Add</strong> to start.</td></tr>';
    return;
  }
  const totalValue = positions.reduce((s, p) => s + posValue(p), 0);
  tbody.innerHTML = '';
  for (const p of positions) {
    const q = quotes[p.symbol];
    const last = q?.regularMarketPrice;
    const dayChg = q?.regularMarketChange;
    const dayChgPct = q?.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null;
    const dayPnl = last != null && dayChg != null ? dayChg * p.shares : null;
    const totalChgPct = last != null ? last / p.avgCost - 1 : null;
    const totalPnl = last != null ? (last - p.avgCost) * p.shares : null;
    const value = posValue(p);
    const weight = totalValue > 0 ? value / totalValue : null;
    const m1Y = metricsCache[p.symbol]?.trailing1Y;
    const days = daysBetween(p.purchaseDate, new Date());
    const posIrr = last != null ? simpleAnnualReturn(p.avgCost, last, days) : null;

    const tr = document.createElement('tr');
    tr.dataset.symbol = p.symbol;
    if (p.symbol === selectedSymbol) tr.classList.add('selected');
    tr.innerHTML = `
      <td class="ticker-cell">${p.symbol}</td>
      <td class="num">${fmtNum(p.shares, p.shares % 1 === 0 ? 0 : 4)}</td>
      <td class="num">${fmtUSD(p.avgCost)}</td>
      <td class="num">${fmtUSD(last)}</td>
      <td class="num ${signClass(dayChgPct)}">${fmtPct(dayChgPct)}</td>
      <td class="num ${signClass(dayPnl)}">${fmtUSD(dayPnl, true)}</td>
      <td class="num ${signClass(totalChgPct)}">${fmtPct(totalChgPct)}</td>
      <td class="num ${signClass(totalPnl)}">${fmtUSD(totalPnl, true)}</td>
      <td class="num ${signClass(posIrr)}">${fmtPct(posIrr)}</td>
      <td class="num dim">${fmtPct(weight, false)}</td>
      <td class="num">${fmtNum(m1Y?.sharpe)}</td>
      <td class="num">${fmtNum(m1Y?.beta)}</td>
      <td class="num ${signClass(m1Y?.alpha)}">${fmtPct(m1Y?.alpha)}</td>
      <td><button class="btn-danger" data-action="delete" title="Remove">×</button></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target?.dataset?.action === 'delete') {
        e.stopPropagation();
        deletePosition(p.symbol);
      } else {
        selectPosition(p.symbol);
      }
    });
    tbody.appendChild(tr);
  }
}

function posValue(p) {
  const q = quotes[p.symbol];
  const last = q?.regularMarketPrice;
  if (last == null) return p.avgCost * p.shares;
  return last * p.shares;
}

function renderHeader() {
  if (positions.length === 0) {
    $('stat-value').textContent = '—';
    $('stat-day').textContent = '—';
    $('stat-total').textContent = '—';
    $('stat-return').textContent = '—';
    $('stat-irr').textContent = '—';
    $('stat-vsspy').textContent = '—';
    $('stat-beta').textContent = '—';
    return;
  }
  let totalValue = 0;
  let totalCost = 0;
  let dayPnl = 0;
  let weightedBeta = 0;
  let weightedReturn = 0;
  let priceCoverageWeight = 0;
  for (const p of positions) {
    const q = quotes[p.symbol];
    const last = q?.regularMarketPrice;
    const cost = p.avgCost * p.shares;
    totalCost += cost;
    if (last == null) {
      totalValue += cost;
      continue;
    }
    const value = last * p.shares;
    totalValue += value;
    const change = q.regularMarketChange ?? 0;
    dayPnl += change * p.shares;
    priceCoverageWeight += value;
    const m = metricsCache[p.symbol]?.trailing1Y;
    if (m?.beta != null) weightedBeta += m.beta * value;
    if (m?.stockReturn != null) weightedReturn += m.stockReturn * value;
  }
  const totalPnl = totalValue - totalCost;
  const totalRet = totalCost > 0 ? totalPnl / totalCost : null;
  const dayPct = totalValue - dayPnl > 0 ? dayPnl / (totalValue - dayPnl) : null;

  $('stat-value').textContent = fmtUSD(totalValue);
  setColored('stat-day', `${fmtUSD(dayPnl, true)} (${fmtPct(dayPct)})`, dayPnl);
  setColored('stat-total', `${fmtUSD(totalPnl, true)} (${fmtPct(totalRet)})`, totalPnl);
  setColored('stat-return', fmtPct(totalRet), totalRet);
  const portIrr = portfolioIRR(positions, quotes);
  setColored('stat-irr', fmtPct(portIrr), portIrr);

  if (priceCoverageWeight > 0 && benchmark1Y != null) {
    const portRet1Y = weightedReturn / priceCoverageWeight;
    const excess = portRet1Y - benchmark1Y;
    setColored('stat-vsspy', fmtPct(excess), excess);
  } else {
    $('stat-vsspy').textContent = '—';
  }
  if (priceCoverageWeight > 0) {
    $('stat-beta').textContent = fmtNum(weightedBeta / priceCoverageWeight);
  } else {
    $('stat-beta').textContent = '—';
  }
}

function setColored(id, text, signedValue) {
  const el = $(id);
  el.textContent = text;
  el.className = 'stat-value ' + signClass(signedValue);
}

async function selectPosition(symbol, source = 'position') {
  selectedSymbol = symbol;
  selectedSource = source;
  document.querySelectorAll('.positions-table tbody tr').forEach((tr) => {
    tr.classList.toggle('selected', tr.dataset.symbol === symbol);
  });
  $('detail-empty').classList.add('hidden');
  $('detail-content').classList.remove('hidden');

  const p = positions.find((x) => x.symbol === symbol);
  $('detail-symbol').textContent = symbol;
  $('detail-name').textContent = quotes[symbol]?.longName || quotes[symbol]?.shortName || '—';
  updateDetailHeader(symbol);
  renderMetrics(symbol);
  renderEarningsCard(symbol);
  loadChart(symbol, currentRange);
  loadNotesAndModels(symbol);
  loadNews(symbol);
  loadFilings(symbol);
  renderAlerts(symbol);
  if (p && !metricsCache[symbol]) {
    const m = await window.api.metrics(symbol, p.purchaseDate);
    metricsCache[symbol] = m;
    renderMetrics(symbol);
  }
}

function updateDetailHeader(symbol) {
  const q = quotes[symbol];
  if (!q) return;
  $('detail-last').textContent = fmtUSD(q.regularMarketPrice);
  const chg = q.regularMarketChange;
  const chgPct = q.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null;
  const el = $('detail-change');
  el.textContent = `${fmtUSD(chg, true)} (${fmtPct(chgPct)})`;
  el.className = 'detail-change ' + signClass(chg);
}

function renderMetrics(symbol) {
  const m = metricsCache[symbol];
  const since = m?.sincePurchase || {};
  const y1 = m?.trailing1Y || {};
  const fillCard = (prefix, data) => {
    setMetricVal(`m-${prefix}-ret`, fmtPct(data.stockReturn), data.stockReturn);
    setMetricVal(`m-${prefix}-bench`, fmtPct(data.benchReturn), data.benchReturn);
    setMetricVal(`m-${prefix}-excess`, fmtPct(data.excessReturn), data.excessReturn);
    $(`m-${prefix}-sharpe`).textContent = fmtNum(data.sharpe);
    $(`m-${prefix}-beta`).textContent = fmtNum(data.beta);
    setMetricVal(`m-${prefix}-alpha`, fmtPct(data.alpha), data.alpha);
  };
  fillCard('since', since);
  fillCard('1y', y1);

  const p = positions.find((x) => x.symbol === symbol);
  const last = quotes[symbol]?.regularMarketPrice;
  const posIrr = p && last != null ? simpleAnnualReturn(p.avgCost, last, daysBetween(p.purchaseDate, new Date())) : null;
  setMetricVal('m-since-irr', fmtPct(posIrr), posIrr);

  const sinceCard = document.querySelector('.metric-card:first-child');
  if (sinceCard) sinceCard.classList.toggle('hidden', selectedSource === 'watchlist');
}

function renderWatchlist() {
  const tbody = $('watchlist-tbody');
  if (watchlist.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No watchlist yet — click <strong>+ Add</strong> to track names you don’t own.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const w of watchlist) {
    const q = quotes[w.symbol];
    const last = q?.regularMarketPrice;
    const dayChg = q?.regularMarketChange;
    const dayChgPct = q?.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null;
    const m1Y = metricsCache[w.symbol]?.trailing1Y;
    const tr = document.createElement('tr');
    tr.dataset.symbol = w.symbol;
    if (w.symbol === selectedSymbol) tr.classList.add('selected');
    tr.innerHTML = `
      <td class="ticker-cell">${w.symbol}</td>
      <td class="dim"></td>
      <td class="num">${fmtUSD(last)}</td>
      <td class="num ${signClass(dayChgPct)}">${fmtPct(dayChgPct)}</td>
      <td class="num ${signClass(dayChg)}">${fmtUSD(dayChg, true)}</td>
      <td class="num">${fmtNum(m1Y?.sharpe)}</td>
      <td class="num">${fmtNum(m1Y?.beta)}</td>
      <td class="num ${signClass(m1Y?.alpha)}">${fmtPct(m1Y?.alpha)}</td>
      <td><button class="btn-danger" data-action="delete" title="Remove">×</button></td>
    `;
    tr.querySelector('.dim').textContent = q?.shortName || q?.longName || '';
    tr.addEventListener('click', (e) => {
      if (e.target?.dataset?.action === 'delete') {
        e.stopPropagation();
        deleteWatchItem(w.symbol);
      } else {
        selectPosition(w.symbol, 'watchlist');
      }
    });
    tbody.appendChild(tr);
  }
}

function openWatchModal() {
  $('watch-ticker').value = '';
  $('watch-error').classList.add('hidden');
  $('watch-suggestions').classList.add('hidden');
  $('watch-modal').classList.remove('hidden');
  setTimeout(() => $('watch-ticker').focus(), 50);
}

function closeWatchModal() {
  $('watch-modal').classList.add('hidden');
}

async function runWatchSearch(query) {
  const box = $('watch-suggestions');
  if (!query || query.trim().length < 1) { box.classList.add('hidden'); return; }
  const results = await window.api.search(query.trim());
  if (!results || results.length === 0) { box.classList.add('hidden'); return; }
  box.innerHTML = '';
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    const sym = document.createElement('span');
    sym.className = 'suggestion-symbol';
    sym.textContent = r.symbol;
    const name = document.createElement('span');
    name.className = 'suggestion-name';
    name.textContent = r.name;
    div.appendChild(sym);
    div.appendChild(name);
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('watch-ticker').value = r.symbol;
      box.classList.add('hidden');
      $('watch-save').focus();
    });
    box.appendChild(div);
  }
  box.classList.remove('hidden');
}

async function saveNewWatchItem() {
  const symbol = normalizeTicker($('watch-ticker').value);
  const err = $('watch-error');
  err.classList.add('hidden');
  if (!symbol) return showWatchError('Ticker is required.');
  if (watchlist.some((w) => w.symbol === symbol)) return showWatchError(`${symbol} is already in your watchlist.`);
  const saveBtn = $('watch-save');
  const restore = setBusy(saveBtn, 'Adding…');
  try {
    const test = await window.api.quotes.getOne(symbol);
    if (!test.ok || !test.quote) { restore(); return showWatchError(`Couldn't find a quote for "${symbol}".`); }
    watchlist.push({ symbol, addedAt: Date.now() });
    await window.api.watchlist.save(watchlist);
    closeWatchModal();
    await refreshAll();
    toast(`Added ${symbol} to watchlist`);
  } catch (e) {
    showWatchError(e?.message || String(e));
  } finally {
    restore();
  }
}

function showWatchError(msg) {
  const err = $('watch-error');
  err.textContent = msg;
  err.classList.remove('hidden');
}

function applySplitFraction(frac) {
  const f = Math.max(0.1, Math.min(0.9, Number.isFinite(frac) ? frac : 0.6));
  const top = document.querySelector('.positions-pane');
  const bot = document.querySelector('.watchlist-pane');
  if (!top || !bot) return;
  top.style.flex = `${f} 1 0`;
  bot.style.flex = `${1 - f} 1 0`;
}

function applyMainSplitFraction(frac) {
  const f = Math.max(0.2, Math.min(0.85, Number.isFinite(frac) ? frac : 0.5));
  const left = document.querySelector('.left-column');
  const right = document.querySelector('.detail-pane');
  if (!left || !right) return;
  left.style.flex = `${f} 1 0`;
  right.style.flex = `${1 - f} 1 0`;
}

function setupLeftSplitter() {
  const splitter = $('left-splitter');
  const column = document.querySelector('.left-column');
  const top = document.querySelector('.positions-pane');
  const bot = document.querySelector('.watchlist-pane');
  if (!splitter || !column || !top || !bot) return;

  let dragging = false;
  let saveTimer = null;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = column.getBoundingClientRect();
    const splitterRect = splitter.getBoundingClientRect();
    const usable = rect.height - splitterRect.height;
    const offset = e.clientY - rect.top;
    const frac = Math.max(0.1, Math.min(0.9, offset / usable));
    top.style.flex = `${frac} 1 0`;
    bot.style.flex = `${1 - frac} 1 0`;

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const settings = await window.api.settings.load();
      await window.api.settings.save({ ...settings, leftSplitTopFraction: frac });
    }, 200);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function setupMainSplitter() {
  const splitter = $('layout-splitter');
  const layout = document.querySelector('.layout');
  const left = document.querySelector('.left-column');
  const right = document.querySelector('.detail-pane');
  if (!splitter || !layout || !left || !right) return;

  let dragging = false;
  let saveTimer = null;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    const splitterRect = splitter.getBoundingClientRect();
    const usable = rect.width - splitterRect.width;
    const offset = e.clientX - rect.left;
    const frac = Math.max(0.2, Math.min(0.85, offset / usable));
    left.style.flex = `${frac} 1 0`;
    right.style.flex = `${1 - frac} 1 0`;

    if (priceChart) {
      try { priceChart.resize(); } catch {}
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const settings = await window.api.settings.load();
      await window.api.settings.save({ ...settings, mainSplitLeftFraction: frac });
    }, 200);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (priceChart) {
      try { priceChart.resize(); } catch {}
    }
  });
}

function bindViewTabs() {
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(view) {
  if (view === activeView) return;
  activeView = view;
  document.querySelectorAll('.view-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('view-dashboard').classList.toggle('hidden', view !== 'dashboard');
  $('view-research').classList.toggle('hidden', view !== 'research');
  if (view === 'research') {
    if (!researchLoaded) loadResearchData();
    else if (drillSectionId) showDrill(); else showGrid();
  }
}

// ─── Research view (card grid + drill-down) ────────────────────────────────

function bindResearchView() {
  document.querySelectorAll('.research-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      researchActiveTab = btn.dataset.rtab;
      document.querySelectorAll('.research-tab').forEach((b) => b.classList.toggle('active', b.dataset.rtab === researchActiveTab));
      drillSectionId = null;
      drillNoteViewerId = null;
      showGrid();
    });
  });
  $('research-search').addEventListener('input', (e) => {
    researchSearch = (e.target.value || '').trim().toLowerCase();
    if (drillSectionId) renderDrill(); else renderResearchGrid();
  });
  $('research-refresh').addEventListener('click', () => loadResearchData({ silent: false }));
  $('research-new-btn').addEventListener('click', () => openNewSectionModal(researchActiveTab));

  $('drill-back').addEventListener('click', () => { drillSectionId = null; drillNoteViewerId = null; showGrid(); });
  $('drill-rename').addEventListener('click', renameDrillSection);
  $('drill-delete').addEventListener('click', deleteDrillSection);
  $('drill-open-obsidian').addEventListener('click', () => {
    const url = $('drill-open-obsidian').dataset.url;
    if (url) window.api.openExternal(url);
  });
  $('drill-add-note').addEventListener('click', () => uploadToDrillSection({ noteOnly: true }));
  $('drill-add-model').addEventListener('click', () => uploadToDrillSection({ noteOnly: false }));
  $('drill-note-viewer-close').addEventListener('click', () => { drillNoteViewerId = null; renderDrillNoteViewer(); });

  // Bind new-section modal
  $('new-section-close').addEventListener('click', closeNewSectionModal);
  $('new-section-cancel').addEventListener('click', closeNewSectionModal);
  $('new-section-save').addEventListener('click', saveNewSection);
  $('new-section-type').addEventListener('change', updateNewSectionForm);
}

function showGrid() {
  $('research-grid').classList.remove('hidden');
  $('research-drill').classList.add('hidden');
  renderResearchGrid();
}

function showDrill() {
  $('research-grid').classList.add('hidden');
  $('research-drill').classList.remove('hidden');
  renderDrill();
}

async function loadResearchData({ silent = true } = {}) {
  if (!silent) toast('Loading research…', 'info');
  const [obsidianRes, researchRes] = await Promise.all([
    window.api.obsidian.listAll(),
    window.api.research.state(),
  ]);
  researchNotes = obsidianRes.ok ? (obsidianRes.notes || []) : [];
  researchSections = researchRes.ok ? (researchRes.sections || []) : [];
  researchFiles = researchRes.ok ? (researchRes.files || []) : [];
  researchLoaded = true;
  if (drillSectionId) renderDrill();
  else renderResearchGrid();
}

// Helper: get Obsidian notes that match a given ticker
function obsidianNotesForTicker(ticker) {
  const upper = (ticker || '').toUpperCase();
  return researchNotes.filter((n) => (n.tickers || []).includes(upper));
}

function filesForSection(sectionId) {
  return researchFiles.filter((f) => f.sectionId === sectionId);
}

function buildCompanyCards() {
  // Tickers from positions + watchlist + sections with type=company + files with company sectionId
  const tickerSet = new Set([
    ...positions.map((p) => (p.symbol || '').toUpperCase()),
    ...watchlist.map((w) => (w.symbol || '').toUpperCase()),
  ]);
  for (const s of researchSections) {
    if (s.type === 'company' && s.ticker) tickerSet.add(s.ticker.toUpperCase());
  }
  for (const f of researchFiles) {
    if (f.sectionId.startsWith('company:')) tickerSet.add(f.sectionId.slice(8));
  }
  // Also include tickers from Obsidian notes
  for (const n of researchNotes) for (const t of n.tickers || []) tickerSet.add(t);

  const tickers = [...tickerSet].filter(Boolean).sort();
  return tickers.map((t) => {
    const sectionId = `company:${t}`;
    const files = filesForSection(sectionId);
    const noteFiles = files.filter((f) => f.type === 'note');
    const modelFiles = files.filter((f) => f.type === 'model');
    const obsidianNotes = obsidianNotesForTicker(t);
    const q = quotes[t];
    const er = earningsByTicker[t];
    return {
      id: sectionId,
      type: 'company',
      ticker: t,
      name: q?.longName || q?.shortName || '',
      price: q?.regularMarketPrice,
      currency: q?.currency || 'USD',
      changePct: q?.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null,
      noteCount: noteFiles.length + obsidianNotes.length,
      modelCount: modelFiles.length,
      hasObsidian: obsidianNotes.length > 0,
      er,
    };
  });
}

function buildSectionCards(type) {
  return researchSections
    .filter((s) => s.type === type)
    .map((s) => {
      const files = filesForSection(s.id);
      return {
        id: s.id,
        type: s.type,
        label: s.label,
        description: s.description || '',
        noteCount: files.filter((f) => f.type === 'note').length,
        modelCount: files.filter((f) => f.type === 'model').length,
        updatedAt: s.updatedAt,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function renderResearchGrid() {
  const grid = $('research-grid');
  let cards = [];
  if (researchActiveTab === 'companies') cards = buildCompanyCards();
  else if (researchActiveTab === 'industries') cards = buildSectionCards('industry');
  else if (researchActiveTab === 'misc') cards = buildSectionCards('misc');

  const q = researchSearch;
  const filtered = q
    ? cards.filter((c) =>
        (c.ticker && c.ticker.toLowerCase().includes(q)) ||
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.label && c.label.toLowerCase().includes(q)) ||
        (c.description && c.description.toLowerCase().includes(q)))
    : cards;

  let html = '';
  for (const c of filtered) {
    html += renderCardHTML(c);
  }
  // Add the "+ Add new" card at the end
  const addLabel = researchActiveTab === 'companies' ? 'Add company' : researchActiveTab === 'industries' ? 'Add industry' : 'Add section';
  html += `<div class="research-card add-card" data-add="${researchActiveTab}">
    <div style="font-size:28px">＋</div>
    <div style="font-weight:600">${addLabel}</div>
  </div>`;

  if (filtered.length === 0 && !researchSearch) {
    // empty state already covered by add-card
  } else if (filtered.length === 0) {
    grid.innerHTML = '<div class="research-empty muted">No matches for "' + escapeHtml(researchSearch) + '"</div>';
    return;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.research-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('add-card')) {
        openNewSectionModal(researchActiveTab);
      } else {
        drillSectionId = el.dataset.id;
        showDrill();
      }
    });
  });
}

function renderCardHTML(c) {
  if (c.type === 'company') {
    const priceCls = c.changePct == null ? 'dim' : c.changePct > 0 ? 'gain' : c.changePct < 0 ? 'loss' : 'dim';
    const priceStr = c.price != null
      ? `<span class="${priceCls}">${fmtPriceForQuote(c.price, c.currency)} ${c.changePct != null ? `(${fmtPct(c.changePct)})` : ''}</span>`
      : '<span class="dim">no quote</span>';
    let erStr = '';
    if (c.er && c.er.date) {
      const days = Math.floor((new Date(c.er.date + 'T12:00:00Z').getTime() - Date.now()) / 86400000);
      const cls = days < 0 ? '' : days < 7 ? 'imminent' : days < 14 ? 'soon' : '';
      const d = new Date(c.er.date + 'T12:00:00Z');
      const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      erStr = `<div class="card-er ${cls}">ER ${short}${c.er.time ? ' · ' + c.er.time : ''}</div>`;
    }
    const displayName = c.name || c.ticker;
    return `<div class="research-card company-card" data-id="${escapeHtml(c.id)}">
      <div class="card-header">
        <div class="card-title company-title" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
        <span class="research-tag companies">Co</span>
      </div>
      <div class="card-ticker">${escapeHtml(c.ticker)}</div>
      <div class="card-price">${priceStr}</div>
      ${erStr}
      <div class="card-meta">
        <span><b>${c.noteCount}</b> note${c.noteCount === 1 ? '' : 's'}</span>
        <span><b>${c.modelCount}</b> model${c.modelCount === 1 ? '' : 's'}</span>
        ${c.hasObsidian ? '<span class="research-tag obsidian" style="font-size:9px;padding:1px 5px">obsidian</span>' : ''}
      </div>
    </div>`;
  }
  const tagCls = c.type === 'industry' ? 'industries' : 'misc';
  const tagLabel = c.type === 'industry' ? 'Ind' : 'Misc';
  return `<div class="research-card" data-id="${escapeHtml(c.id)}">
    <div class="card-header">
      <span class="card-title" style="font-size:16px">${escapeHtml(c.label)}</span>
      <span class="research-tag ${tagCls}">${tagLabel}</span>
    </div>
    ${c.description ? `<div class="card-description">${escapeHtml(c.description)}</div>` : ''}
    <div class="card-meta">
      <span><b>${c.noteCount}</b> note${c.noteCount === 1 ? '' : 's'}</span>
      <span><b>${c.modelCount}</b> model${c.modelCount === 1 ? '' : 's'}</span>
    </div>
  </div>`;
}

// ─── Drill-down view ───────────────────────────────────────────────────────

function getDrillSection(sectionId) {
  // For real sections, look in researchSections
  const real = researchSections.find((s) => s.id === sectionId);
  if (real) return real;
  // Synthesize a company section if needed
  if (sectionId.startsWith('company:')) {
    const ticker = sectionId.slice(8);
    return {
      id: sectionId, type: 'company', ticker, label: ticker, description: '',
      isManual: false,
    };
  }
  return null;
}

async function renderDrill() {
  if (!drillSectionId) return showGrid();
  const sec = getDrillSection(drillSectionId);
  if (!sec) return showGrid();

  const tickerLine = $('drill-ticker');
  if (sec.type === 'company') {
    const q = quotes[sec.ticker];
    const displayName = q?.longName || q?.shortName || sec.ticker;
    $('drill-title').textContent = displayName;
    tickerLine.textContent = sec.ticker;
    tickerLine.classList.remove('hidden');
  } else {
    $('drill-title').textContent = sec.label;
    tickerLine.classList.add('hidden');
    tickerLine.textContent = '';
  }
  const tag = $('drill-tag');
  if (sec.type === 'company') { tag.textContent = 'Company'; tag.className = 'research-tag companies'; }
  else if (sec.type === 'industry') { tag.textContent = 'Industry'; tag.className = 'research-tag industries'; }
  else { tag.textContent = 'Miscellaneous'; tag.className = 'research-tag misc'; }

  const metaParts = [];
  if (sec.type === 'company') {
    const q = quotes[sec.ticker];
    if (q?.regularMarketPrice != null) metaParts.push(`${fmtPriceForQuote(q.regularMarketPrice, q.currency)} (${fmtPct((q.regularMarketChangePercent || 0) / 100)})`);
    const er = earningsByTicker[sec.ticker];
    if (er?.date) {
      const d = new Date(er.date + 'T12:00:00Z');
      metaParts.push(`Next ER: ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}${er.time ? ' ' + er.time : ''}`);
    }
    if (q?.exchange) metaParts.push(q.exchange);
  }
  $('drill-meta').textContent = metaParts.join(' · ');
  $('drill-desc').textContent = sec.description || '';

  // Buttons visibility
  $('drill-delete').classList.toggle('hidden', sec.type === 'company');
  $('drill-open-obsidian').classList.add('hidden');

  // Notes: user-uploaded + Obsidian (for company sections)
  const userFiles = filesForSection(drillSectionId);
  const userNotes = userFiles.filter((f) => f.type === 'note');
  const userModels = userFiles.filter((f) => f.type === 'model');
  const obsidianNotes = sec.type === 'company' ? obsidianNotesForTicker(sec.ticker) : [];

  renderDrillNotes(userNotes, obsidianNotes);
  renderDrillModels(userModels);
  renderDrillNoteViewer();
}

function detectFileTypeLabel(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  if (!m) return 'FILE';
  const ext = m[1].toLowerCase();
  if (['md', 'markdown'].includes(ext)) return 'MD';
  if (ext === 'txt') return 'TXT';
  if (['xlsx', 'xls', 'xlsm', 'xlsb'].includes(ext)) return 'XLS';
  if (ext === 'csv') return 'CSV';
  if (ext === 'ods') return 'ODS';
  if (ext === 'pdf') return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['ppt', 'pptx'].includes(ext)) return 'PPT';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'IMG';
  if (ext === 'svg') return 'SVG';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'ZIP';
  return ext.toUpperCase();
}

function detectFileIcon(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  const ext = m ? m[1].toLowerCase() : '';
  if (['md', 'markdown', 'txt'].includes(ext)) return '📄';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📃';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️';
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx', 'key'].includes(ext)) return '🎞️';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return '🗜️';
  return '📎';
}

function formatFileSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDateShort(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: '2-digit' });
}

function buildSortHeaderHTML(sortBy, sortDir, opts = {}) {
  const arrow = sortDir === 'asc' ? '↑' : '↓';
  const cols = [
    { id: 'name', label: 'Name', cls: 'col-name', align: 'left' },
    { id: 'type', label: 'Type', cls: 'col-type', align: 'right' },
    { id: 'size', label: 'Size', cls: 'col-size', align: 'right' },
    { id: 'date', label: opts.dateLabel || 'Date added', cls: 'col-date', align: 'right' },
  ];
  const colHtml = cols.map((c) => {
    const active = c.id === sortBy;
    return `<span class="sort-col ${c.cls}${active ? ' active' : ''}" data-sort="${c.id}">${c.label}${active ? ` <span class="sort-arrow">${arrow}</span>` : ''}</span>`;
  }).join('');
  // grid cols: 24 icon | name | type | size | date | actions
  return `<span></span>${colHtml}<span></span>`;
}

function compareFiles(by, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let av, bv;
    if (by === 'name') { av = (a._sortName || '').toLowerCase(); bv = (b._sortName || '').toLowerCase(); }
    else if (by === 'type') { av = a._sortType || ''; bv = b._sortType || ''; }
    else if (by === 'size') { av = a._sortSize || 0; bv = b._sortSize || 0; }
    else { av = a._sortDate || 0; bv = b._sortDate || 0; }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  };
}

function bindSortHeader(headerEl, currentByGetter, currentDirGetter, setSort, rerender) {
  headerEl.querySelectorAll('[data-sort]').forEach((el) => {
    el.addEventListener('click', () => {
      const newBy = el.dataset.sort;
      const currentBy = currentByGetter();
      const currentDir = currentDirGetter();
      if (newBy === currentBy) {
        setSort(newBy, currentDir === 'asc' ? 'desc' : 'asc');
      } else {
        // Name/Type default ascending; Size/Date default descending
        setSort(newBy, newBy === 'name' || newBy === 'type' ? 'asc' : 'desc');
      }
      rerender();
    });
  });
}

function renderDrillNotes(userNotes, obsidianNotes) {
  const list = $('drill-notes');
  const header = $('drill-notes-sort');
  const count = $('drill-notes-count');
  const total = userNotes.length + obsidianNotes.length;
  count.textContent = total > 0 ? `· ${total}` : '';
  if (total === 0) {
    header.classList.add('hidden');
    list.innerHTML = '<li class="muted">No notes yet. Click + Add note file to upload anything (.md, .pdf, .docx, etc.).</li>';
    return;
  }

  // Normalize Obsidian + user notes into a single sortable array
  const rows = [];
  for (const n of obsidianNotes) {
    rows.push({
      _kind: 'obsidian',
      _ref: n,
      _sortName: (n.title || n.filename || '').toLowerCase(),
      _sortType: detectFileTypeLabel(n.filename || '.md').toLowerCase(),
      _sortSize: n.size || 0,
      _sortDate: n.mtimeMs || 0,
    });
  }
  for (const f of userNotes) {
    rows.push({
      _kind: 'user',
      _ref: f,
      _sortName: (f.name || '').toLowerCase(),
      _sortType: detectFileTypeLabel(f.name).toLowerCase(),
      _sortSize: f.size || 0,
      _sortDate: f.uploadedAt || f.mtimeMs || 0,
    });
  }
  rows.sort(compareFiles(notesSortBy, notesSortDir));

  header.classList.remove('hidden');
  header.innerHTML = buildSortHeaderHTML(notesSortBy, notesSortDir);
  bindSortHeader(
    header,
    () => notesSortBy,
    () => notesSortDir,
    (by, dir) => { notesSortBy = by; notesSortDir = dir; },
    () => renderDrill(),
  );

  list.innerHTML = '';
  for (const row of rows) {
    if (row._kind === 'obsidian') {
      const n = row._ref;
      list.appendChild(buildObsidianNoteRow(n));
    } else {
      const f = row._ref;
      list.appendChild(buildUserFileRow(f, { isNote: true }));
    }
  }
}

function buildObsidianNoteRow(n) {
  const li = document.createElement('li');
  li.className = 'drill-file';
  const type = detectFileTypeLabel(n.filename || '.md');
  li.innerHTML = `
    <span class="df-icon">📝</span>
    <div class="df-name-row">
      <div class="df-name"></div>
      <div class="df-subtle"></div>
    </div>
    <span class="df-type-col">${type}</span>
    <span class="df-size-col">${formatFileSize(n.size || 0)}</span>
    <span class="df-date-col">${formatDateShort(n.mtimeMs)}</span>
    <div class="df-actions">
      <button class="btn-secondary" data-action="preview">Preview</button>
      <button class="btn-secondary" data-action="obsidian">Obsidian</button>
      <button class="btn-secondary" data-action="reveal">Reveal</button>
    </div>
  `;
  li.querySelector('.df-name').textContent = n.title || n.filename;
  li.querySelector('.df-subtle').innerHTML = `<span class="df-source obsidian">Obsidian</span><span>${escapeHtml(n.relPath || '')}</span>`;
  li.querySelector('[data-action="preview"]').addEventListener('click', (e) => { e.stopPropagation(); previewObsidianNote(n); });
  li.querySelector('[data-action="obsidian"]').addEventListener('click', (e) => { e.stopPropagation(); if (n.obsidianUrl) window.api.openExternal(n.obsidianUrl); });
  li.querySelector('[data-action="reveal"]').addEventListener('click', (e) => { e.stopPropagation(); window.api.revealInFolder(n.notePath); });
  li.addEventListener('click', () => previewObsidianNote(n));
  return li;
}

function buildUserFileRow(f, opts = {}) {
  const isText = /\.(md|markdown|txt)$/i.test(f.name);
  const icon = detectFileIcon(f.name);
  const type = detectFileTypeLabel(f.name);
  const li = document.createElement('li');
  li.className = 'drill-file';
  let subtleHtml = '';
  if (!opts.isNote && f.source) {
    subtleHtml = `<span class="df-source ${(f.source || 'Mine').toLowerCase()}">${escapeHtml(f.source || 'Mine')}</span>`;
  }
  if (f.note) subtleHtml += `<span>${escapeHtml(f.note)}</span>`;
  li.innerHTML = `
    <span class="df-icon">${icon}</span>
    <div class="df-name-row">
      <div class="df-name"></div>
      ${subtleHtml ? `<div class="df-subtle">${subtleHtml}</div>` : ''}
    </div>
    <span class="df-type-col">${type}</span>
    <span class="df-size-col">${formatFileSize(f.size)}</span>
    <span class="df-date-col">${formatDateShort(f.uploadedAt || f.mtimeMs)}</span>
    <div class="df-actions">
      ${opts.isNote && isText ? '<button class="btn-secondary" data-action="preview">Preview</button>' : ''}
      <button class="btn-secondary" data-action="open">Open</button>
      <button class="btn-secondary" data-action="reveal">Reveal</button>
      <button class="btn-danger" data-action="remove">×</button>
    </div>
  `;
  li.querySelector('.df-name').textContent = f.name;
  const previewBtn = li.querySelector('[data-action="preview"]');
  if (previewBtn) {
    previewBtn.addEventListener('click', (e) => { e.stopPropagation(); previewUserNote(f); });
  }
  li.querySelector('[data-action="open"]').addEventListener('click', (e) => { e.stopPropagation(); window.api.openPath(f.path); });
  li.querySelector('[data-action="reveal"]').addEventListener('click', (e) => { e.stopPropagation(); window.api.revealInFolder(f.path); });
  li.querySelector('[data-action="remove"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove "${f.name}"?`)) return;
    await window.api.research.deleteFile(f.id);
    await loadResearchData();
  });
  li.addEventListener('click', () => {
    if (opts.isNote && isText) previewUserNote(f);
    else window.api.openPath(f.path);
  });
  return li;
}

function renderDrillModels(files) {
  const list = $('drill-models');
  const header = $('drill-models-sort');
  const count = $('drill-models-count');
  count.textContent = files.length > 0 ? `· ${files.length}` : '';
  if (files.length === 0) {
    header.classList.add('hidden');
    list.innerHTML = '<li class="muted">No models or files uploaded yet.</li>';
    return;
  }
  // Normalize for sort
  const rows = files.map((f) => ({
    _ref: f,
    _sortName: (f.name || '').toLowerCase(),
    _sortType: detectFileTypeLabel(f.name).toLowerCase(),
    _sortSize: f.size || 0,
    _sortDate: f.uploadedAt || f.mtimeMs || 0,
  }));
  rows.sort(compareFiles(modelsSortBy, modelsSortDir));

  header.classList.remove('hidden');
  header.innerHTML = buildSortHeaderHTML(modelsSortBy, modelsSortDir);
  bindSortHeader(
    header,
    () => modelsSortBy,
    () => modelsSortDir,
    (by, dir) => { modelsSortBy = by; modelsSortDir = dir; },
    () => renderDrill(),
  );

  list.innerHTML = '';
  for (const row of rows) {
    list.appendChild(buildUserFileRow(row._ref, { isNote: false }));
  }
}

let drillNoteViewerContent = null;
async function previewObsidianNote(note) {
  const r = await window.api.obsidian.read(note.notePath);
  if (!r.ok) {
    toast(r.error || 'Could not read note', 'error');
    return;
  }
  drillNoteViewerId = `obsidian:${note.notePath}`;
  drillNoteViewerContent = r;
  renderDrillNoteViewer();
}

async function previewUserNote(file) {
  // Only attempt to render text-based notes inline; anything else opens externally.
  if (!/\.(md|markdown|txt)$/i.test(file.name)) {
    window.api.openPath(file.path);
    return;
  }
  const r = await window.api.research.readNote(file.id);
  if (!r.ok) {
    toast(r.error || 'Could not read note', 'error');
    return;
  }
  drillNoteViewerId = `user:${file.id}`;
  drillNoteViewerContent = { body: r.text, frontmatter: {}, filename: r.name, mtimeMs: r.mtimeMs };
  renderDrillNoteViewer();
}

function renderDrillNoteViewer() {
  const wrap = $('drill-note-viewer-wrap');
  const viewer = $('drill-note-viewer');
  const title = $('drill-note-viewer-title');
  const closeBtn = $('drill-note-viewer-close');
  if (!drillNoteViewerId || !drillNoteViewerContent) {
    title.textContent = 'Note preview';
    viewer.innerHTML = '<div class="muted">Click a note above to preview it here.</div>';
    closeBtn.classList.add('hidden');
    return;
  }
  closeBtn.classList.remove('hidden');
  title.textContent = drillNoteViewerContent.filename || 'Note';
  // Re-use renderNoteBody (defined elsewhere) for consistency
  renderNoteBody(viewer, drillNoteViewerContent);
}

async function uploadToDrillSection({ noteOnly }) {
  if (!drillSectionId) return;
  // For notes: no filters so the dialog shows every file type natively.
  // For models: keep helpful spreadsheet/PDF/image filters but with "All files" too.
  const dialogOpts = noteOnly
    ? { title: 'Upload note (any file type)' }
    : {
        title: 'Upload file',
        filters: [
          { name: 'All files', extensions: ['*'] },
          { name: 'Excel & spreadsheets', extensions: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'Word', extensions: ['doc', 'docx'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        ],
      };
  const r = await window.api.dialog.openFile(dialogOpts);
  if (!r.ok || !r.paths || r.paths.length === 0) return;
  // For model uploads, prompt for source via the existing upload modal flow
  if (!noteOnly) {
    pendingDrillUpload = { sectionId: drillSectionId, paths: r.paths };
    openDrillUploadConfirm();
    return;
  }
  // Notes: force type=note regardless of extension, upload directly with no source/note prompt
  const res = await window.api.research.addFiles(drillSectionId, r.paths, null, null, 'note');
  if (!res.ok) {
    toast(res.error || 'Upload failed', 'error');
    return;
  }
  toast(`Uploaded ${res.added.length} note${res.added.length === 1 ? '' : 's'}`);
  await loadResearchData();
}

let pendingDrillUpload = null;
function openDrillUploadConfirm() {
  if (!pendingDrillUpload) return;
  uploadPendingFiles = pendingDrillUpload.paths;
  uploadPendingTicker = pendingDrillUpload.sectionId; // reusing variable; we'll handle in saveUploadedModels override
  uploadPendingIsDrill = true;
  // Repurpose the existing upload-model modal
  $('upload-model-ticker').textContent = drillSectionId.startsWith('company:') ? drillSectionId.slice(8) : (researchSections.find((s) => s.id === drillSectionId)?.label || 'section');
  $('upload-model-source').value = 'Mine';
  $('upload-model-note').value = '';
  const summary = $('upload-files-summary');
  summary.classList.add('has-files');
  summary.innerHTML = pendingDrillUpload.paths.map((p) => `<div>📄 ${escapeHtml(p.split(/[\\/]/).pop())}</div>`).join('');
  $('upload-model-save').disabled = false;
  $('upload-model-error').classList.add('hidden');
  $('upload-model-modal').classList.remove('hidden');
}

async function renameDrillSection() {
  if (!drillSectionId) return;
  const sec = getDrillSection(drillSectionId);
  if (!sec) return;
  const currentLabel = sec.label;
  const newLabel = prompt(`Rename "${currentLabel}":`, currentLabel);
  if (!newLabel || newLabel.trim() === currentLabel) return;
  // For synthetic company sections, create a real entry on rename
  if (sec.type === 'company' && !researchSections.find((s) => s.id === drillSectionId)) {
    await window.api.research.createSection({ type: 'company', ticker: sec.ticker, label: newLabel.trim() });
  } else {
    await window.api.research.updateSection(drillSectionId, { label: newLabel.trim() });
  }
  await loadResearchData();
}

async function deleteDrillSection() {
  if (!drillSectionId) return;
  const sec = getDrillSection(drillSectionId);
  if (!sec || sec.type === 'company') return;
  const files = filesForSection(drillSectionId);
  if (!confirm(`Delete "${sec.label}"? This will remove ${files.length} attached file${files.length === 1 ? '' : 's'}.`)) return;
  await window.api.research.deleteSection(drillSectionId);
  drillSectionId = null;
  await loadResearchData();
  showGrid();
}

// ─── New section modal ─────────────────────────────────────────────────────

function openNewSectionModal(forTab) {
  const map = { companies: 'company', industries: 'industry', misc: 'misc' };
  const type = map[forTab] || 'company';
  $('new-section-type').value = type;
  $('new-section-ticker').value = '';
  $('new-section-name').value = '';
  $('new-section-desc').value = '';
  $('new-section-error').classList.add('hidden');
  updateNewSectionForm();
  $('new-section-modal').classList.remove('hidden');
  setTimeout(() => (type === 'company' ? $('new-section-ticker') : $('new-section-name')).focus(), 50);
}

function closeNewSectionModal() { $('new-section-modal').classList.add('hidden'); }

function updateNewSectionForm() {
  const t = $('new-section-type').value;
  $('new-section-ticker-label').style.display = t === 'company' ? '' : 'none';
  $('new-section-name-label').style.display = t === 'company' ? 'none' : '';
}

async function saveNewSection() {
  const type = $('new-section-type').value;
  const ticker = $('new-section-ticker').value.trim().replace(/^\$+/, '').toUpperCase();
  const name = $('new-section-name').value.trim();
  const description = $('new-section-desc').value.trim();
  const err = $('new-section-error');
  err.classList.add('hidden');
  if (type === 'company' && !ticker) { err.textContent = 'Ticker required.'; err.classList.remove('hidden'); return; }
  if (type !== 'company' && !name) { err.textContent = 'Name required.'; err.classList.remove('hidden'); return; }
  const payload = type === 'company'
    ? { type, ticker, label: ticker, description }
    : { type, label: name, description };
  const r = await window.api.research.createSection(payload);
  if (!r.ok) { err.textContent = r.error || 'Could not create.'; err.classList.remove('hidden'); return; }
  closeNewSectionModal();
  toast('Section created');
  await loadResearchData();
  researchActiveTab = type === 'company' ? 'companies' : type === 'industry' ? 'industries' : 'misc';
  document.querySelectorAll('.research-tab').forEach((b) => b.classList.toggle('active', b.dataset.rtab === researchActiveTab));
  drillSectionId = r.section.id;
  showDrill();
}

function renderNoteBody(container, noteResult) {
  const fmKeys = Object.keys(noteResult.frontmatter || {});
  let fmHtml = '';
  if (fmKeys.length > 0) {
    const items = fmKeys.slice(0, 10).map((k) => {
      const v = noteResult.frontmatter[k];
      const display = Array.isArray(v) ? v.join(', ') : v;
      return `<span><b>${escapeHtml(k)}:</b> ${escapeHtml(String(display))}</span>`;
    });
    fmHtml = `<div class="notes-frontmatter">${items.join('')}</div>`;
  }
  const html = renderObsidianMarkdown(noteResult.body || '');
  container.innerHTML = fmHtml + html;
  // Wire wikilink clicks
  container.querySelectorAll('.wikilink').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const target = el.dataset.target;
      if (!target) return;
      // Try to find a note matching that target
      const match = researchNotes.find((n) => {
        const base = n.filename.replace(/\.md$/i, '').toLowerCase();
        return base === target.toLowerCase();
      });
      if (match) {
        ev.preventDefault();
        researchSelectedKey = match.tickers.length > 0 ? `ticker:${match.tickers[0]}` : `note:${match.notePath}`;
        renderResearchSidebar();
        renderResearchContent(researchSelectedKey);
      }
    });
  });
  // Wire external link clicks
  container.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.api.openExternal(href);
      });
    }
  });
}

// ─── Obsidian-aware markdown rendering ──────────────────────────────────────

function renderObsidianMarkdown(src) {
  if (!src) return '';
  if (typeof marked === 'undefined') {
    return '<pre>' + escapeHtml(src) + '</pre>';
  }
  // Pre-process Obsidian-specific syntax before passing to marked
  let text = src;
  // Wikilinks [[Page]] or [[Page|Display]]
  text = text.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, target, _p, display) => {
    const label = display || target;
    return `<span class="wikilink" data-target="${target.trim()}">${label}</span>`;
  });
  // Embedded images ![[image.png]] — render as placeholder with caption (file:// not usable without vault path)
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_m, p) => {
    return `<figure class="embedded"><div class="muted">📎 ${p}</div></figure>`;
  });
  // Callouts: > [!type] Optional title
  //          > content...
  text = text.replace(/(^|\n)((?:> ?[^\n]*(?:\n|$))+)/g, (whole, before, block) => {
    const lines = block.split('\n').filter((l) => l.startsWith('>'));
    const first = lines[0].replace(/^>\s?/, '');
    const m = /^\[!([\w-]+)\]\s*(.*)$/.exec(first);
    if (!m) return whole; // not a callout
    const type = m[1].toLowerCase();
    const title = m[2] || (type.charAt(0).toUpperCase() + type.slice(1));
    const rest = lines.slice(1).map((l) => l.replace(/^>\s?/, '')).join('\n');
    return `\n<div class="callout ${type}"><div class="callout-title">${escapeHtml(title)}</div>\n\n${rest}\n\n</div>\n`;
  });

  // Dataview / Excalidraw placeholders
  text = text.replace(/```dataview\n[\s\S]*?\n```/g, '<div class="callout warning"><div class="callout-title">Dataview block</div>Open in Obsidian to run this query.</div>');
  text = text.replace(/```excalidraw\n[\s\S]*?\n```/g, '<div class="callout note"><div class="callout-title">Excalidraw diagram</div>Open in Obsidian to view.</div>');

  // Parse with marked (GFM + breaks)
  marked.use({
    gfm: true,
    breaks: false,
  });
  return marked.parse(text);
}

// ─── Upload modal ──────────────────────────────────────────────────────────

let uploadPendingFiles = [];
let uploadPendingTicker = null;
let uploadPendingIsDrill = false;

function bindUploadModal() {
  $('upload-model-close').addEventListener('click', closeUploadModal);
  $('upload-model-cancel').addEventListener('click', closeUploadModal);
  $('upload-model-pick').addEventListener('click', pickUploadFiles);
  $('upload-model-save').addEventListener('click', saveUploadedModels);
}

function openUploadModal(ticker) {
  uploadPendingFiles = [];
  uploadPendingTicker = ticker;
  uploadPendingIsDrill = false;
  $('upload-model-ticker').textContent = ticker;
  $('upload-model-source').value = 'Mine';
  $('upload-model-note').value = '';
  $('upload-files-summary').textContent = 'No files selected.';
  $('upload-files-summary').classList.remove('has-files');
  $('upload-model-save').disabled = true;
  $('upload-model-error').classList.add('hidden');
  $('upload-model-modal').classList.remove('hidden');
}

function closeUploadModal() {
  $('upload-model-modal').classList.add('hidden');
  uploadPendingIsDrill = false;
}

async function pickUploadFiles() {
  const r = await window.api.dialog.openFile({
    title: `Upload model for ${uploadPendingTicker}`,
    filters: [
      { name: 'Excel & spreadsheets', extensions: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!r.ok || !r.paths || r.paths.length === 0) return;
  uploadPendingFiles = r.paths;
  const summary = $('upload-files-summary');
  summary.classList.add('has-files');
  summary.innerHTML = uploadPendingFiles.map((p) => `<div>📄 ${escapeHtml(p.split(/[\\/]/).pop())}</div>`).join('');
  $('upload-model-save').disabled = false;
}

async function saveUploadedModels() {
  if (uploadPendingFiles.length === 0) return;
  const source = $('upload-model-source').value;
  const note = $('upload-model-note').value.trim();
  let r;
  if (uploadPendingIsDrill) {
    // Drill view upload — sectionId stored in uploadPendingTicker
    r = await window.api.research.addFiles(uploadPendingTicker, uploadPendingFiles, source, note);
  } else {
    // Per-position dashboard upload — goes to legacy models store
    r = await window.api.modelsApi.add(uploadPendingTicker, uploadPendingFiles, source, note);
  }
  if (!r.ok) {
    const err = $('upload-model-error');
    err.textContent = r.error || 'Upload failed';
    err.classList.remove('hidden');
    return;
  }
  toast(`Uploaded ${r.added.length} ${source} file${r.added.length === 1 ? '' : 's'}`);
  closeUploadModal();
  uploadPendingIsDrill = false;
  await loadResearchData();
  if (selectedSymbol === uploadPendingTicker) loadModelsFor(uploadPendingTicker);
}

function bindReaderModal() {
  $('reader-close').addEventListener('click', () => $('alert-reader-modal').classList.add('hidden'));
  $('reader-done').addEventListener('click', () => $('alert-reader-modal').classList.add('hidden'));
  $('reader-open-gmail').addEventListener('click', () => {
    const url = $('reader-open-gmail').dataset.url;
    if (url) window.api.openExternal(url);
  });
}

function openReader(alert) {
  if (!alert) return;
  $('reader-type').textContent = alert.type || 'NEWS';
  $('reader-date').textContent = alert.date ? new Date(alert.date).toLocaleString() : '';
  $('reader-subject').textContent = alert.subject || '(no subject)';
  $('reader-meta-line').textContent = `${alert.sender || ''}`;
  const tickersEl = $('reader-tickers');
  tickersEl.innerHTML = (alert.tickers || []).map((t) => `<span class="ticker-tag">${escapeHtml(t)}</span>`).join('');

  const summaryWrap = $('reader-summary');
  const summaryText = $('reader-summary-text');
  if (alert.summary) {
    if (Array.isArray(alert.summary)) {
      summaryText.innerHTML = '<ul>' + alert.summary.map((b) => `<li>${escapeHtml(b)}</li>`).join('') + '</ul>';
    } else {
      summaryText.textContent = alert.summary;
    }
    summaryWrap.classList.remove('hidden');
  } else if (alert.snippet && !alert.fullText) {
    summaryText.textContent = alert.snippet;
    summaryWrap.classList.remove('hidden');
  } else {
    summaryWrap.classList.add('hidden');
  }

  const fullWrap = $('reader-fulltext-wrap');
  const fullText = alert.fullText || alert.body;
  if (fullText) {
    $('reader-text').textContent = fullText;
    fullWrap.style.display = '';
    fullWrap.open = !alert.summary;
  } else {
    $('reader-text').textContent = alert.snippet || '(open in Gmail for full text)';
    fullWrap.style.display = alert.snippet ? '' : 'none';
    fullWrap.open = false;
  }

  $('reader-open-gmail').dataset.url = alert.gmailUrl || '';
  $('alert-reader-modal').classList.remove('hidden');
}

function refreshPortfolioUI() {
  const active = portfolioState.portfolios.find((p) => p.id === portfolioState.active);
  $('portfolio-current-name').textContent = active ? active.name : '—';
}

function bindPortfolioControls() {
  const button = $('portfolio-button');
  const menu = $('portfolio-menu');

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) {
      renderPortfolioMenu();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== button && !button.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  $('manage-portfolios-close').addEventListener('click', () => $('manage-portfolios-modal').classList.add('hidden'));
  $('manage-portfolios-done').addEventListener('click', () => $('manage-portfolios-modal').classList.add('hidden'));
  $('new-portfolio-add').addEventListener('click', addNewPortfolio);
  $('new-portfolio-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addNewPortfolio();
  });
}

function renderPortfolioMenu() {
  const menu = $('portfolio-menu');
  menu.innerHTML = '';
  for (const p of portfolioState.portfolios) {
    const btn = document.createElement('button');
    btn.className = 'portfolio-menu-item' + (p.id === portfolioState.active ? ' active' : '');
    btn.innerHTML = `
      <span class="pname"></span>
      <span class="pcount"></span>
      <span class="check"></span>
    `;
    btn.querySelector('.pname').textContent = p.name;
    btn.querySelector('.pcount').textContent = `${p.count} pos`;
    btn.querySelector('.check').textContent = p.id === portfolioState.active ? '✓' : '';
    btn.addEventListener('click', async () => {
      menu.classList.add('hidden');
      if (p.id !== portfolioState.active) await switchPortfolio(p.id);
    });
    menu.appendChild(btn);
  }
  const divider = document.createElement('div');
  divider.className = 'portfolio-menu-divider';
  menu.appendChild(divider);
  const manage = document.createElement('button');
  manage.className = 'portfolio-menu-item manage';
  manage.textContent = 'Manage portfolios…';
  manage.addEventListener('click', () => {
    menu.classList.add('hidden');
    openManagePortfolios();
  });
  menu.appendChild(manage);
}

async function switchPortfolio(id) {
  await window.api.portfolios.setActive(id);
  portfolioState = await window.api.portfolios.state();
  const newActive = portfolioState.portfolios.find((p) => p.id === id);
  positions = await window.api.positions.load();
  if (selectedSymbol && selectedSource === 'position' && !positions.some((p) => p.symbol === selectedSymbol)) {
    selectedSymbol = null;
    selectedSource = null;
    $('detail-empty').classList.remove('hidden');
    $('detail-content').classList.add('hidden');
  }
  refreshPortfolioUI();
  await refreshAll();
  if (newActive) toast(`Switched to ${newActive.name}`, 'info');
}

function openManagePortfolios() {
  $('manage-portfolios-error').classList.add('hidden');
  $('new-portfolio-name').value = '';
  renderPortfolioList();
  $('manage-portfolios-modal').classList.remove('hidden');
}

function renderPortfolioList() {
  const list = $('portfolio-list');
  list.innerHTML = '';
  for (const p of portfolioState.portfolios) {
    const li = document.createElement('li');
    li.className = 'portfolio-list-item' + (p.id === portfolioState.active ? ' active' : '');
    li.innerHTML = `
      <div class="portfolio-list-item-name" title="Click to switch to this portfolio"></div>
      <div class="portfolio-list-item-count"></div>
      <div class="portfolio-list-item-actions">
        <button class="btn-secondary" data-action="rename">Rename</button>
        <button class="btn-danger" data-action="delete">Delete</button>
      </div>
    `;
    const nameEl = li.querySelector('.portfolio-list-item-name');
    nameEl.textContent = p.name;
    li.querySelector('.portfolio-list-item-count').textContent = `${p.count} pos`;
    nameEl.addEventListener('click', async () => {
      if (p.id !== portfolioState.active) {
        await switchPortfolio(p.id);
        renderPortfolioList();
      }
    });
    li.querySelector('[data-action="rename"]').addEventListener('click', () => beginRename(p, li, nameEl));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deletePortfolio(p));
    list.appendChild(li);
  }
}

function beginRename(p, li, nameEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = p.name;
  input.maxLength = 40;
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  const finish = async (commit) => {
    if (commit) {
      const newName = input.value.trim();
      if (newName && newName !== p.name) {
        const r = await window.api.portfolios.rename(p.id, newName);
        if (r.ok) {
          portfolioState = await window.api.portfolios.state();
          renderPortfolioList();
          refreshPortfolioUI();
          toast(`Renamed to "${newName}"`);
          return;
        }
        showManageError(r.error || 'Rename failed');
        toast(`Rename failed: ${r.error || ''}`, 'error');
      }
    }
    nameEl.textContent = p.name;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deletePortfolio(p) {
  if (portfolioState.portfolios.length <= 1) {
    showManageError('Cannot delete the only portfolio.');
    return;
  }
  if (!confirm(`Delete "${p.name}" and its ${p.count} positions? This cannot be undone.`)) return;
  const r = await window.api.portfolios.delete(p.id);
  if (!r.ok) {
    showManageError(r.error || 'Delete failed');
    toast(`Delete failed: ${r.error || ''}`, 'error');
    return;
  }
  toast(`Deleted portfolio "${p.name}"`);
  portfolioState = await window.api.portfolios.state();
  if (r.newActive && r.newActive !== p.id) {
    positions = await window.api.positions.load();
    if (selectedSymbol && selectedSource === 'position' && !positions.some((x) => x.symbol === selectedSymbol)) {
      selectedSymbol = null;
      selectedSource = null;
      $('detail-empty').classList.remove('hidden');
      $('detail-content').classList.add('hidden');
    }
    refreshPortfolioUI();
    await refreshAll();
  }
  renderPortfolioList();
}

async function addNewPortfolio() {
  const name = $('new-portfolio-name').value.trim();
  if (!name) return showManageError('Name required.');
  const addBtn = $('new-portfolio-add');
  const restore = setBusy(addBtn, '');
  try {
    const r = await window.api.portfolios.create(name);
    if (!r.ok) { showManageError(r.error || 'Create failed'); return; }
    $('new-portfolio-name').value = '';
    $('manage-portfolios-error').classList.add('hidden');
    portfolioState = await window.api.portfolios.state();
    positions = await window.api.positions.load();
    selectedSymbol = null;
    selectedSource = null;
    $('detail-empty').classList.remove('hidden');
    $('detail-content').classList.add('hidden');
    refreshPortfolioUI();
    renderPortfolioList();
    await refreshAll();
    toast(`Created portfolio "${name}"`);
  } finally {
    restore();
  }
}

function showManageError(msg) {
  const el = $('manage-portfolios-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function deleteWatchItem(symbol) {
  if (!confirm(`Remove ${symbol} from watchlist?`)) return;
  watchlist = watchlist.filter((w) => w.symbol !== symbol);
  await window.api.watchlist.save(watchlist);
  if (selectedSymbol === symbol && selectedSource === 'watchlist') {
    selectedSymbol = null;
    selectedSource = null;
    $('detail-empty').classList.remove('hidden');
    $('detail-content').classList.add('hidden');
  }
  await refreshAll();
  toast(`Removed ${symbol} from watchlist`);
}

function setMetricVal(id, text, signedValue) {
  const el = $(id);
  el.textContent = text;
  el.className = signClass(signedValue);
}

async function loadChart(symbol, range) {
  const result = await window.api.history(symbol, range);
  const rows = result.ok ? result.rows : [];
  const data = rows.map((r) => ({ x: new Date(r.date), y: r.close ?? r.adjclose }));
  const first = data[0]?.y ?? 0;
  const last = data[data.length - 1]?.y ?? 0;
  const color = last >= first ? 'rgba(22, 199, 132, 0.95)' : 'rgba(234, 57, 67, 0.95)';
  const fill = last >= first ? 'rgba(22, 199, 132, 0.08)' : 'rgba(234, 57, 67, 0.08)';

  if (priceChart) priceChart.destroy();
  const ctx = $('price-chart').getContext('2d');
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: fill,
          borderWidth: 1.5,
          fill: true,
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => fmtUSD(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: range === '1W' ? 'day' : range === '1M' || range === '3M' ? 'week' : range === '5Y' ? 'year' : 'month',
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#8b96a3', maxTicksLimit: 8 },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#8b96a3',
            callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
          },
        },
      },
    },
  });
}

function renderAlerts(symbol) {
  const list = $('alerts-list');
  const summary = $('alerts-summary');
  const matching = (allAlerts || []).filter((a) => Array.isArray(a.tickers) && a.tickers.includes(symbol));
  if (matching.length === 0) {
    list.innerHTML = '<li class="muted">No FactSet alerts mention this ticker.</li>';
    summary.textContent = '';
    return;
  }
  matching.sort((a, b) => new Date(b.date) - new Date(a.date));
  summary.textContent = `· ${matching.length}`;
  list.innerHTML = '';
  for (const a of matching) {
    const li = document.createElement('li');
    li.className = 'alert-item';
    const when = a.date ? new Date(a.date).toLocaleString() : '';
    const typeLabel = a.type || 'ALERT';
    li.innerHTML = `
      <div><span class="alert-type"></span><span class="alert-sender"></span></div>
      <div class="alert-subject"></div>
      <div class="alert-snippet"></div>
      <div class="alert-tickers"></div>
      <div class="alert-meta"></div>
    `;
    li.querySelector('.alert-type').textContent = typeLabel;
    li.querySelector('.alert-sender').textContent = a.sender || '';
    li.querySelector('.alert-sender').className = 'muted alert-sender';
    li.querySelector('.alert-subject').textContent = a.subject || '(no subject)';
    li.querySelector('.alert-snippet').textContent = a.snippet || '';
    const tickersEl = li.querySelector('.alert-tickers');
    const tickerSpans = (a.tickers || []).map((t) => {
      const cls = t === symbol ? 'alert-ticker-hit' : '';
      return `<span class="${cls}">${escapeHtml(t)}</span>`;
    });
    tickersEl.innerHTML = tickerSpans.join(' · ');
    li.querySelector('.alert-meta').textContent = when;
    li.addEventListener('click', () => openReader(a));
    list.appendChild(li);
  }
}

async function loadNews(symbol) {
  const list = $('news-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  const news = await window.api.news(symbol, 10);
  if (!news || news.length === 0) {
    list.innerHTML = '<li class="muted">No recent news.</li>';
    return;
  }
  list.innerHTML = '';
  for (const n of news) {
    const li = document.createElement('li');
    li.className = 'news-item';
    const when = n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toLocaleString() : '—';
    li.innerHTML = `
      <div class="news-title"></div>
      <div class="news-meta"><span class="news-publisher"></span><span></span></div>
    `;
    li.querySelector('.news-title').textContent = n.title || '(untitled)';
    li.querySelector('.news-publisher').textContent = n.publisher || '—';
    li.querySelector('.news-meta span:last-child').textContent = when;
    li.addEventListener('click', () => {
      if (n.link) window.api.openExternal(n.link);
    });
    list.appendChild(li);
  }
}

const FILING_CATEGORY_FORMS = {
  annual: ['10-K', '10-K/A', '20-F'],
  quarterly: ['10-Q', '10-Q/A', '6-K'],
  material: ['8-K', '8-K/A'],
  proxy: ['DEF 14A', 'DEFA14A', 'PRE 14A'],
  insider: ['4', 'SC 13D', 'SC 13G'],
  other: ['S-1', 'S-1/A', 'S-3', '13F-HR'],
};

function categoryForForm(form) {
  for (const [cat, forms] of Object.entries(FILING_CATEGORY_FORMS)) {
    if (forms.includes(form)) return cat;
  }
  return 'other';
}

async function loadFilings(symbol) {
  const list = $('filings-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  $('filings-summary').textContent = '(loading…)';
  const r = await window.api.filings(symbol, 20 * 365, 1000);
  if (!r.ok) {
    currentFilings = [];
    rebuildYearPills();
    list.innerHTML = `<li class="muted">${escapeHtml(r.error || 'Could not load filings.')}</li>`;
    return;
  }
  currentFilings = r.filings || [];
  rebuildYearPills();
  renderFilings();
}

function rebuildYearPills() {
  const yearsInData = new Set();
  for (const f of currentFilings) {
    const y = String(f.filingDate || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) yearsInData.add(y);
  }
  for (const y of [...filingYears]) {
    if (!yearsInData.has(y)) filingYears.delete(y);
  }
  const sorted = [...yearsInData].sort((a, b) => b.localeCompare(a));
  const container = $('filings-years');
  container.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-pill' + (filingYears.size === 0 ? ' active' : '');
  allBtn.dataset.year = 'all';
  allBtn.textContent = 'All';
  container.appendChild(allBtn);
  for (const y of sorted) {
    const b = document.createElement('button');
    b.className = 'filter-pill' + (filingYears.has(y) ? ' active' : '');
    b.dataset.year = y;
    b.textContent = y;
    container.appendChild(b);
  }
  bindYearPills();
}

function bindYearPills() {
  document.querySelectorAll('#filings-years .filter-pill').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const y = btn.dataset.year;
      if (y === 'all') {
        filingYears.clear();
      } else {
        if (filingYears.has(y)) filingYears.delete(y);
        else filingYears.add(y);
      }
      syncYearPills();
      const settings = await window.api.settings.load();
      await window.api.settings.save({ ...settings, filingYears: [...filingYears] });
      renderFilings();
    });
  });
}

function syncYearPills() {
  document.querySelectorAll('#filings-years .filter-pill').forEach((btn) => {
    const y = btn.dataset.year;
    if (y === 'all') btn.classList.toggle('active', filingYears.size === 0);
    else btn.classList.toggle('active', filingYears.has(y));
  });
}

function renderFilings() {
  const list = $('filings-list');
  if (!currentFilings || currentFilings.length === 0) {
    list.innerHTML = '<li class="muted">No filings available.</li>';
    $('filings-summary').textContent = '';
    return;
  }
  const filtered = currentFilings.filter((f) => {
    if (filingFilters.size > 0 && !filingFilters.has(categoryForForm(f.form))) return false;
    if (filingYears.size > 0) {
      const y = String(f.filingDate || '').slice(0, 4);
      if (!filingYears.has(y)) return false;
    }
    return true;
  });
  const oldest = currentFilings.reduce((min, f) => (f.filingDate < min ? f.filingDate : min), '9999-12-31');
  const newest = currentFilings.reduce((max, f) => (f.filingDate > max ? f.filingDate : max), '0000-01-01');
  $('filings-summary').textContent = `(${filtered.length} of ${currentFilings.length} · ${oldest.slice(0,4)}–${newest.slice(0,4)})`;
  if (filtered.length === 0) {
    list.innerHTML = '<li class="muted">No filings match the selected filters.</li>';
    return;
  }
  list.innerHTML = '';
  for (const f of filtered) {
    const li = document.createElement('li');
    li.className = 'filing-item';
    li.innerHTML = `
      <div class="filing-meta">
        <span class="filing-form"></span>
        <span class="filing-date"></span>
        ${f.reportDate ? '<span class="dim">period: <span class="report-date"></span></span>' : ''}
      </div>
      <div class="filing-desc"></div>
    `;
    li.querySelector('.filing-form').textContent = f.form;
    li.querySelector('.filing-date').textContent = `Filed ${f.filingDate}`;
    if (f.reportDate) li.querySelector('.report-date').textContent = f.reportDate;
    li.querySelector('.filing-desc').textContent = f.description || `${f.form} filing`;
    li.addEventListener('click', () => {
      if (f.url) window.api.openExternal(f.url);
    });
    list.appendChild(li);
  }
}

function bindFilingFilterPills() {
  document.querySelectorAll('#filings-filters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cat = btn.dataset.cat;
      if (cat === 'all') {
        filingFilters.clear();
      } else {
        if (filingFilters.has(cat)) filingFilters.delete(cat);
        else filingFilters.add(cat);
      }
      syncFilingPills();
      const settings = await window.api.settings.load();
      await window.api.settings.save({ ...settings, filingFilters: [...filingFilters] });
      renderFilings();
    });
  });
}

function syncFilingPills() {
  document.querySelectorAll('#filings-filters .filter-pill').forEach((btn) => {
    const cat = btn.dataset.cat;
    if (cat === 'all') btn.classList.toggle('active', filingFilters.size === 0);
    else btn.classList.toggle('active', filingFilters.has(cat));
  });
}

async function fetchEarnings(symbols) {
  if (!symbols || symbols.length === 0) return;
  try {
    const r = await window.api.earnings.batch(symbols);
    if (r.ok && r.data) {
      earningsByTicker = { ...earningsByTicker, ...r.data };
      renderTable();
      renderWatchlist();
      if (selectedSymbol) renderEarningsCard(selectedSymbol);
    }
  } catch (e) {
    console.error('earnings fetch failed:', e);
  }
}

function fmtErShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function erDaysAhead(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

function erCellHtml(symbol) {
  const e = earningsByTicker[symbol];
  if (!e || !e.date) return '<span class="dim">—</span>';
  const days = erDaysAhead(e.date);
  const cls = days != null && days < 0 ? 'dim' : days < 7 ? 'er-cell imminent' : days < 14 ? 'er-cell soon' : 'er-cell';
  const time = e.time ? ` <span class="dim">${e.time}</span>` : '';
  return `<span class="${cls}">${fmtErShort(e.date)}${time}</span>`;
}

let currentNoteContext = { symbol: null, notePath: null, obsidianUrl: null };

async function loadNotesAndModels(symbol) {
  loadNotesFor(symbol);
  loadModelsFor(symbol);
}

async function loadNotesFor(symbol) {
  const body = $('notes-body');
  const meta = $('notes-meta');
  const openBtn = $('notes-open-obsidian');
  openBtn.classList.add('hidden');
  meta.textContent = '';
  currentNoteContext = { symbol, notePath: null, obsidianUrl: null };
  const settings = await window.api.settings.load();
  if (!settings.obsidianVaultPath) {
    body.innerHTML = '<div class="muted">No notes folder configured. Set your Obsidian vault path in <strong>Settings</strong>.</div>';
    return;
  }
  body.innerHTML = '<div class="muted">Looking for note…</div>';
  const r = await window.api.obsidian.get(symbol);
  if (!r.ok) {
    body.innerHTML = `<div class="muted">${escapeHtml(r.error || 'Could not read vault.')}</div>`;
    return;
  }
  if (!r.found) {
    body.innerHTML = `<div class="muted">No <code>${escapeHtml(symbol)}.md</code> found in <strong>${escapeHtml(r.vault || 'vault')}</strong>. Tried filename match, prefix match, and <code>ticker:</code> frontmatter.</div>`;
    return;
  }
  currentNoteContext = { symbol, notePath: r.notePath, obsidianUrl: r.obsidianUrl };
  openBtn.classList.remove('hidden');
  const fmKeys = Object.keys(r.frontmatter || {});
  let fmHtml = '';
  if (fmKeys.length > 0) {
    const items = [];
    for (const k of fmKeys.slice(0, 8)) {
      const v = r.frontmatter[k];
      const display = Array.isArray(v) ? v.join(', ') : v;
      items.push(`<span><b>${escapeHtml(k)}:</b> ${escapeHtml(String(display))}</span>`);
    }
    fmHtml = `<div class="notes-frontmatter">${items.join('')}</div>`;
  }
  const html = renderMarkdown(r.body || '');
  body.innerHTML = fmHtml + html;
  const when = r.mtimeMs ? new Date(r.mtimeMs).toLocaleString() : '';
  meta.textContent = `· ${r.filename || ''} · updated ${when}`;
  // Re-bind external link clicks to use openExternal
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openExternal(href);
      });
    } else {
      a.removeAttribute('href');
      a.style.cursor = 'default';
    }
  });
}

function openCurrentNoteInObsidian() {
  if (currentNoteContext.obsidianUrl) {
    window.api.openExternal(currentNoteContext.obsidianUrl);
  }
}

async function loadModelsFor(symbol) {
  const list = $('models-list');
  const meta = $('models-meta');
  list.innerHTML = '<li class="muted">Loading…</li>';
  meta.textContent = '';
  const r = await window.api.modelsApi.list(symbol);
  if (!r.ok) {
    list.innerHTML = `<li class="muted">${escapeHtml(r.error || 'Could not list models.')}</li>`;
    return;
  }
  if (!r.files || r.files.length === 0) {
    list.innerHTML = '<li class="muted">No models uploaded for this ticker yet.</li>';
    return;
  }
  meta.textContent = `· ${r.files.length}`;
  list.innerHTML = '';
  for (const f of r.files) {
    const li = document.createElement('li');
    li.className = 'model-item';
    li.innerHTML = `
      <span class="model-icon">📊</span>
      <div class="model-info">
        <div class="model-name"></div>
        <div class="model-meta"></div>
      </div>
      <div class="model-actions">
        <button class="btn-secondary" data-action="open">Open</button>
        <button class="btn-secondary" data-action="reveal">Reveal</button>
        <button class="btn-danger" data-action="remove" title="Remove">×</button>
      </div>
    `;
    li.querySelector('.model-name').textContent = f.name;
    const sizeKb = (f.size / 1024).toFixed(1);
    const when = new Date(f.mtimeMs).toLocaleDateString();
    li.querySelector('.model-meta').textContent = `${sizeKb} KB · uploaded ${when}`;
    li.querySelector('[data-action="open"]').addEventListener('click', () => {
      window.api.openPath(f.path);
    });
    li.querySelector('[data-action="reveal"]').addEventListener('click', () => {
      window.api.revealInFolder(f.path);
    });
    li.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (!confirm(`Remove "${f.name}"?`)) return;
      const rr = await window.api.modelsApi.remove(f.path);
      if (rr.ok) {
        toast(`Removed ${f.name}`, 'info');
        loadModelsFor(symbol);
      } else {
        toast(rr.error || 'Remove failed', 'error');
      }
    });
    list.appendChild(li);
  }
}

async function uploadModelForCurrentTicker() {
  if (!selectedSymbol) {
    toast('Select a position or watchlist item first', 'info');
    return;
  }
  openUploadModal(selectedSymbol);
}

// Minimal markdown renderer — covers headers, bold/italic, links, code,
// lists, blockquotes, hr, line breaks. Not a full CommonMark implementation.
function renderMarkdown(src) {
  if (!src) return '';
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Extract fenced code blocks first to protect their content
  const codeBlocks = [];
  src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    codeBlocks.push({ lang, code });
    return ` CODEBLOCK${codeBlocks.length - 1} `;
  });

  // Escape HTML in the rest
  let text = escape(src);

  // Headers
  text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
             .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
             .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
             .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
             .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
             .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  text = text.replace(/^---+$/gm, '<hr>');

  // Blockquote (single-line)
  text = text.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');

  // Wikilinks [[Page]] or [[Page|Display]] — for Obsidian
  text = text.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, page, _p, display) =>
    `<span class="wikilink">[[${display || page}]]</span>`);

  // Inline links [text](url) — only http(s) allowed by openExternal
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    if (!/^https?:\/\//i.test(url)) return label;
    return `<a href="${url}">${label}</a>`;
  });

  // Bold then italic (bold uses ** or __, italic uses * or _)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
             .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
             .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
             .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Lists — simple per-line: lines starting with -, *, + become <li>, group adjacent
  const lines = text.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  for (const line of lines) {
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ul) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${ol[2]}</li>`);
    } else {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      out.push(line);
    }
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  text = out.join('\n');

  // Paragraphs — wrap blank-line separated chunks that aren't already block-level
  text = text.split(/\n{2,}/).map((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return '';
    if (/^<(h[1-6]|ul|ol|li|blockquote|hr|pre|p)/i.test(trimmed)) return chunk;
    if (/^ CODEBLOCK/.test(trimmed)) return chunk;
    return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Re-inject code blocks
  text = text.replace(/ CODEBLOCK(\d+) /g, (_m, idx) => {
    const b = codeBlocks[parseInt(idx, 10)];
    const cls = b.lang ? ` class="lang-${escape(b.lang)}"` : '';
    return `<pre><code${cls}>${escape(b.code)}</code></pre>`;
  });

  return text;
}

function renderEarningsCard(symbol) {
  const card = $('earnings-card');
  const e = earningsByTicker[symbol];
  if (!e || !e.date) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden', 'imminent', 'soon');
  const days = erDaysAhead(e.date);
  if (days != null && days >= 0 && days < 7) card.classList.add('imminent');
  else if (days != null && days < 14) card.classList.add('soon');
  const d = new Date(e.date + 'T12:00:00Z');
  const longDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const timeLabel = e.time === 'AMC' ? ' · after close' : e.time === 'BMO' ? ' · before open' : '';
  const dayText = days == null ? '' : days < 0 ? '' : days === 0 ? ' (today)' : days === 1 ? ' (tomorrow)' : ` (in ${days} days)`;
  $('earnings-when').textContent = `${longDate}${timeLabel}${dayText}`;
  const parts = [];
  if (e.epsForecast) parts.push(`EPS est <b>${e.epsForecast}</b>`);
  if (e.numEstimates) parts.push(`<b>${e.numEstimates}</b> analyst${e.numEstimates === 1 ? '' : 's'}`);
  if (e.fiscalQuarter) parts.push(`fiscal Q ending <b>${e.fiscalQuarter}</b>`);
  if (e.lastYearDate && e.lastYearEPS) parts.push(`last year ${e.lastYearDate}: <b>${e.lastYearEPS}</b>`);
  $('earnings-detail').innerHTML = parts.join(' · ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let addInputMode = 'shares'; // 'shares' | 'dollar'

function openAddModal() {
  $('add-ticker').value = '';
  $('add-shares').value = '';
  $('add-total').value = '';
  $('add-cost').value = '';
  $('add-date').value = new Date().toISOString().slice(0, 10);
  $('add-error').classList.add('hidden');
  $('add-suggestions').classList.add('hidden');
  $('add-preview').classList.add('hidden');
  setAddInputMode('shares');
  $('add-modal').classList.remove('hidden');
  setTimeout(() => $('add-ticker').focus(), 50);
}

function setAddInputMode(mode) {
  addInputMode = mode;
  document.querySelectorAll('.input-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('add-shares-label').classList.toggle('hidden', mode !== 'shares');
  $('add-total-label').classList.toggle('hidden', mode !== 'dollar');
  updateAddPreview();
}

function updateAddPreview() {
  const cost = parseFloat($('add-cost').value);
  const preview = $('add-preview');
  if (!Number.isFinite(cost) || cost <= 0) {
    preview.classList.add('hidden');
    return;
  }
  if (addInputMode === 'dollar') {
    const total = parseFloat($('add-total').value);
    if (!Number.isFinite(total) || total <= 0) { preview.classList.add('hidden'); return; }
    const shares = total / cost;
    preview.textContent = `→ ${shares.toFixed(4)} shares at $${cost.toFixed(2)}/share`;
    preview.classList.remove('hidden');
  } else {
    const shares = parseFloat($('add-shares').value);
    if (!Number.isFinite(shares) || shares <= 0) { preview.classList.add('hidden'); return; }
    const total = shares * cost;
    preview.textContent = `→ $${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total cost`;
    preview.classList.remove('hidden');
  }
}

function closeAddModal() {
  $('add-modal').classList.add('hidden');
}

async function runSymbolSearch(query) {
  const box = $('add-suggestions');
  if (!query || query.trim().length < 1) {
    box.classList.add('hidden');
    return;
  }
  const results = await window.api.search(query.trim());
  if (!results || results.length === 0) {
    box.classList.add('hidden');
    return;
  }
  box.innerHTML = '';
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    const sym = document.createElement('span');
    sym.className = 'suggestion-symbol';
    sym.textContent = r.symbol;
    const name = document.createElement('span');
    name.className = 'suggestion-name';
    name.textContent = r.name;
    div.appendChild(sym);
    div.appendChild(name);
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('add-ticker').value = r.symbol;
      box.classList.add('hidden');
      $('add-shares').focus();
    });
    box.appendChild(div);
  }
  box.classList.remove('hidden');
}

function normalizeTicker(raw) {
  return String(raw || '').trim().replace(/^\$+/, '').toUpperCase();
}

async function saveNewPosition() {
  const symbol = normalizeTicker($('add-ticker').value);
  const avgCost = parseFloat($('add-cost').value);
  const purchaseDate = $('add-date').value;
  const err = $('add-error');
  err.classList.add('hidden');

  let shares;
  if (addInputMode === 'dollar') {
    const total = parseFloat($('add-total').value);
    if (!Number.isFinite(total) || total <= 0) return showAddError('Total amount must be a positive number.');
    if (!Number.isFinite(avgCost) || avgCost <= 0) return showAddError('Avg cost must be a positive number to compute shares.');
    shares = total / avgCost;
  } else {
    shares = parseFloat($('add-shares').value);
    if (!Number.isFinite(shares) || shares <= 0) return showAddError('Shares must be a positive number.');
    if (!Number.isFinite(avgCost) || avgCost <= 0) return showAddError('Avg cost must be a positive number.');
  }

  if (!symbol) return showAddError('Ticker is required.');
  if (!purchaseDate) return showAddError('Purchase date is required.');

  const saveBtn = $('add-save');
  const restoreSave = setBusy(saveBtn, 'Saving…');
  try {
    const test = await window.api.quotes.getOne(symbol);
    if (!test.ok || !test.quote) { restoreSave(); return showAddError(`Couldn't find a quote for "${symbol}".`); }

    const existing = positions.findIndex((p) => p.symbol === symbol);
    let isUpdate = existing >= 0;
    if (isUpdate) {
      const old = positions[existing];
      const newShares = old.shares + shares;
      const newCost = (old.shares * old.avgCost + shares * avgCost) / newShares;
      positions[existing] = {
        ...old,
        shares: newShares,
        avgCost: newCost,
      };
    } else {
      positions.push({ symbol, shares, avgCost, purchaseDate, addedAt: Date.now() });
    }
    await window.api.positions.save(positions);
    delete metricsCache[symbol];
    closeAddModal();
    await pushToCloud();
    await refreshAll();
    toast(`${isUpdate ? 'Updated' : 'Added'} ${symbol} · ${shares} sh @ ${avgCost.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  } catch (e) {
    showAddError(e?.message || String(e));
  } finally {
    restoreSave();
  }
}

function showAddError(msg) {
  const err = $('add-error');
  err.textContent = msg;
  err.classList.remove('hidden');
}

async function deletePosition(symbol) {
  if (!confirm(`Remove ${symbol} from your dashboard?`)) return;
  positions = positions.filter((p) => p.symbol !== symbol);
  await window.api.positions.save(positions);
  delete metricsCache[symbol];
  if (selectedSymbol === symbol) {
    selectedSymbol = null;
    $('detail-empty').classList.remove('hidden');
    $('detail-content').classList.add('hidden');
  }
  await pushToCloud();
  await refreshAll();
  toast(`Removed ${symbol}`);
}

function updateSyncStatus(state, msg) {
  const el = $('sync-status');
  if (!el) return;
  el.classList.remove('synced', 'error', 'syncing');
  if (state === 'offline' || !syncConfigured) {
    el.textContent = '○ local only';
  } else if (state === 'syncing') {
    el.classList.add('syncing');
    el.textContent = '↻ syncing…';
  } else if (state === 'error') {
    el.classList.add('error');
    el.textContent = '● sync error';
    if (msg) el.title = msg;
  } else if (state === 'synced') {
    el.classList.add('synced');
    el.textContent = '● synced';
  } else {
    el.textContent = '◌ ready';
  }
}

async function pullFromCloud({ silent = false } = {}) {
  if (!syncConfigured) return { ok: false, configured: false };
  if (!silent) updateSyncStatus('syncing');
  const r = await window.api.sync.pull();
  if (!r.ok) {
    updateSyncStatus('error', r.error);
    return r;
  }
  const remote = r.positions || [];
  const settings = await window.api.settings.load();
  const localVersion = settings.syncVersion || 0;
  if ((r.version || 0) > localVersion || positions.length === 0) {
    positions = remote;
    await window.api.positions.save(positions);
  }
  await window.api.sync.setBaseVersion(r.version || 0);
  updateSyncStatus('synced');
  return r;
}

async function pushToCloud() {
  if (!syncConfigured) return { ok: false, configured: false };
  updateSyncStatus('syncing');
  const r = await window.api.sync.push(positions);
  if (r.conflict && r.current) {
    positions = r.current.positions || [];
    await window.api.positions.save(positions);
    await window.api.sync.setBaseVersion(r.current.version || 0);
    updateSyncStatus('synced');
    alert('Another device updated positions while you were editing — pulled the latest. Please re-apply your change if needed.');
    return r;
  }
  if (!r.ok) {
    updateSyncStatus('error', r.error);
    return r;
  }
  updateSyncStatus('synced');
  return r;
}

function scheduleSyncPoll() {
  if (syncPollTimer) clearInterval(syncPollTimer);
  if (!syncConfigured) return;
  syncPollTimer = setInterval(async () => {
    const settings = await window.api.settings.load();
    const before = settings.syncVersion || 0;
    const r = await window.api.sync.pull();
    if (r.ok && (r.version || 0) > before) {
      positions = r.positions || [];
      await window.api.positions.save(positions);
      await window.api.sync.setBaseVersion(r.version || 0);
      updateSyncStatus('synced');
      await refreshAll();
    } else if (r.ok) {
      updateSyncStatus('synced');
    } else {
      updateSyncStatus('error', r.error);
    }
  }, 60 * 1000);
}

function openSettingsModal() {
  window.api.settings.load().then((s) => {
    $('settings-url').value = s.syncUrl || '';
    $('settings-token').value = s.syncToken || '';
    $('settings-vault-path').value = s.obsidianVaultPath || '';
    $('settings-test-result').classList.add('hidden');
    $('settings-modal').classList.remove('hidden');
  });
}

async function browseVaultFolder() {
  const r = await window.api.dialog.openFolder();
  if (r.ok && r.path) {
    $('settings-vault-path').value = r.path;
  }
}

async function testSyncSettings() {
  const url = $('settings-url').value.trim().replace(/\/$/, '');
  const token = $('settings-token').value.trim();
  const out = $('settings-test-result');
  out.classList.remove('ok', 'err', 'hidden');
  if (!url || !token) {
    out.classList.add('err');
    out.textContent = 'Both fields required';
    return;
  }
  const btn = $('settings-test');
  const restore = setBusy(btn, 'Testing…');
  out.textContent = 'Testing…';
  try {
    const r = await window.api.sync.test(url, token);
    if (r.ok) {
      out.classList.add('ok');
      out.textContent = `Connected. Server has version ${r.version}.`;
    } else {
      out.classList.add('err');
      out.textContent = r.error || 'Failed';
    }
  } finally {
    restore();
  }
}

async function saveSyncSettings() {
  const url = $('settings-url').value.trim().replace(/\/$/, '');
  const token = $('settings-token').value.trim();
  const vaultPath = $('settings-vault-path').value.trim();
  const btn = $('settings-save');
  const restore = setBusy(btn, 'Saving…');
  try {
    const settings = await window.api.settings.load();
    const wasConfigured = !!(settings.syncUrl && settings.syncToken);
    const cleared = !url || !token;
    await window.api.settings.save({
      ...settings,
      syncUrl: cleared ? '' : url,
      syncToken: cleared ? '' : token,
      syncVersion: cleared ? 0 : settings.syncVersion || 0,
      obsidianVaultPath: vaultPath,
    });
    syncConfigured = !cleared;
    $('settings-modal').classList.add('hidden');
    if (syncConfigured) {
      await pullFromCloud();
      await pushToCloud();
      await refreshAll();
      toast('Cloud sync enabled');
    } else {
      updateSyncStatus('offline');
      toast('Saved', 'info');
    }
    if (wasConfigured !== syncConfigured) scheduleSyncPoll();
    if (selectedSymbol) loadNotesAndModels(selectedSymbol);
  } finally {
    restore();
  }
}

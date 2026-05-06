'use strict';

const fmtUSD = (v, signed = false) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  return signed && v > 0 ? '+' + s : s;
};
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

document.addEventListener('DOMContentLoaded', init);

async function init() {
  positions = await window.api.positions.load();
  watchlist = await window.api.watchlist.load();
  const settings = await window.api.settings.load();
  $('auto-refresh').checked = !!settings.autoRefresh;
  syncConfigured = !!(settings.syncUrl && settings.syncToken);
  updateSyncStatus(syncConfigured ? 'idle' : 'offline');
  applySplitFraction(settings.leftSplitTopFraction || 0.6);
  filingFilters = new Set(settings.filingFilters || []);
  filingYears = new Set((settings.filingYears || []).map(String));
  syncFilingPills();

  bindEvents();
  setupLeftSplitter();
  bindFilingFilterPills();

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
  $('refresh-btn').addEventListener('click', refreshAll);
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

  $('settings-btn').addEventListener('click', openSettingsModal);
  $('settings-modal-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('settings-cancel').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('settings-test').addEventListener('click', testSyncSettings);
  $('settings-save').addEventListener('click', saveSyncSettings);

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
      refreshAll();
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

async function refreshAll() {
  try {
    const allSymbols = [
      ...positions.map((p) => p.symbol),
      ...watchlist.map((w) => w.symbol),
    ];
    if (allSymbols.length === 0) {
      renderTable();
      renderWatchlist();
      renderHeader();
      $('last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;
      return;
    }
    const results = await window.api.quotes.getMany(allSymbols);
    quotes = {};
    for (const r of results) {
      if (r.ok && r.quote) quotes[r.symbol] = r.quote;
    }
    if (!benchmark1Y) {
      const spy = await window.api.history('SPY', '1Y');
      if (spy.ok && spy.rows.length >= 2) {
        const closes = spy.rows.map((r) => r.adjclose ?? r.close);
        benchmark1Y = closes[closes.length - 1] / closes[0] - 1;
      }
    }
    await ensureMetrics();
    renderTable();
    renderWatchlist();
    renderHeader();
    $('last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;

    if (selectedSymbol && quotes[selectedSymbol]) {
      updateDetailHeader(selectedSymbol);
    }
  } catch (e) {
    console.error('Refresh failed:', e);
    $('last-refresh').textContent = 'Refresh failed';
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
  loadChart(symbol, currentRange);
  loadNews(symbol);
  loadFilings(symbol);
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
  const test = await window.api.quotes.getOne(symbol);
  if (!test.ok || !test.quote) return showWatchError(`Couldn't find a quote for "${symbol}".`);
  watchlist.push({ symbol, addedAt: Date.now() });
  await window.api.watchlist.save(watchlist);
  closeWatchModal();
  await refreshAll();
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
            label: (ctx) => `$${ctx.parsed.y.toFixed(2)}`,
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
          ticks: { color: '#8b96a3', callback: (v) => `$${v}` },
        },
      },
    },
  });
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openAddModal() {
  $('add-ticker').value = '';
  $('add-shares').value = '';
  $('add-cost').value = '';
  $('add-date').value = new Date().toISOString().slice(0, 10);
  $('add-error').classList.add('hidden');
  $('add-suggestions').classList.add('hidden');
  $('add-modal').classList.remove('hidden');
  setTimeout(() => $('add-ticker').focus(), 50);
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
  const shares = parseFloat($('add-shares').value);
  const avgCost = parseFloat($('add-cost').value);
  const purchaseDate = $('add-date').value;
  const err = $('add-error');
  err.classList.add('hidden');

  if (!symbol) return showAddError('Ticker is required.');
  if (!Number.isFinite(shares) || shares <= 0) return showAddError('Shares must be a positive number.');
  if (!Number.isFinite(avgCost) || avgCost <= 0) return showAddError('Avg cost must be a positive number.');
  if (!purchaseDate) return showAddError('Purchase date is required.');

  const test = await window.api.quotes.getOne(symbol);
  if (!test.ok || !test.quote) return showAddError(`Couldn't find a quote for "${symbol}".`);

  const existing = positions.findIndex((p) => p.symbol === symbol);
  if (existing >= 0) {
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
    $('settings-test-result').classList.add('hidden');
    $('settings-modal').classList.remove('hidden');
  });
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
  out.textContent = 'Testing…';
  const r = await window.api.sync.test(url, token);
  if (r.ok) {
    out.classList.add('ok');
    out.textContent = `Connected. Server has version ${r.version}.`;
  } else {
    out.classList.add('err');
    out.textContent = r.error || 'Failed';
  }
}

async function saveSyncSettings() {
  const url = $('settings-url').value.trim().replace(/\/$/, '');
  const token = $('settings-token').value.trim();
  const settings = await window.api.settings.load();
  const wasConfigured = !!(settings.syncUrl && settings.syncToken);
  const cleared = !url || !token;
  await window.api.settings.save({
    ...settings,
    syncUrl: cleared ? '' : url,
    syncToken: cleared ? '' : token,
    syncVersion: cleared ? 0 : settings.syncVersion || 0,
  });
  syncConfigured = !cleared;
  $('settings-modal').classList.add('hidden');
  if (syncConfigured) {
    await pullFromCloud();
    await pushToCloud();
    await refreshAll();
  } else {
    updateSyncStatus('offline');
  }
  if (wasConfigured !== syncConfigured) scheduleSyncPoll();
}

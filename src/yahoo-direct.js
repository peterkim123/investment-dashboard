const https = require('https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' } },
      (res) => {
        const status = res.statusCode || 0;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (status === 404) return reject(new Error('Symbol not found'));
          if (status === 429) return reject(new Error('Rate limited by Yahoo, try again in a minute'));
          if (status < 200 || status >= 300) {
            return reject(new Error(`HTTP ${status}: ${body.slice(0, 120)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Bad JSON from Yahoo'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Yahoo request timed out')));
  });
}

let inflight = Promise.resolve();
function throttled(fn, gapMs = 120) {
  const wait = inflight.then(() => new Promise((r) => setTimeout(r, gapMs)));
  inflight = wait.then(fn).catch(() => {});
  return wait.then(fn);
}

const quoteCache = new Map();
const QUOTE_TTL_MS = 15 * 1000;
const histCache = new Map();
const HIST_TTL_MS = 5 * 60 * 1000;

function rangeToParams(range) {
  switch (range) {
    case '1W': return { range: '5d', interval: '30m' };
    case '1M': return { range: '1mo', interval: '1d' };
    case '3M': return { range: '3mo', interval: '1d' };
    case '6M': return { range: '6mo', interval: '1d' };
    case '1Y': return { range: '1y', interval: '1d' };
    case '5Y': return { range: '5y', interval: '1wk' };
    default:   return { range: '1y', interval: '1d' };
  }
}

async function chart(symbol, params) {
  const sym = encodeURIComponent(symbol.toUpperCase());
  const qs = new URLSearchParams(params).toString();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?${qs}&includePrePost=false`;
  const j = await throttled(() => fetchJSON(url));
  const r = j?.chart?.result?.[0];
  if (!r) {
    const err = j?.chart?.error?.description || 'No data';
    throw new Error(err);
  }
  return r;
}

async function getQuote(symbol) {
  const key = symbol.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.t < QUOTE_TTL_MS) return cached.q;
  const r = await chart(key, { range: '5d', interval: '1d' });
  const meta = r.meta || {};
  const closes = r.indicators?.quote?.[0]?.close || [];
  const lastClose = [...closes].reverse().find((c) => c != null);
  const price = meta.regularMarketPrice ?? lastClose;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? lastClose;
  if (price == null) throw new Error('No price returned');
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : null;
  const q = {
    symbol: meta.symbol || key,
    regularMarketPrice: price,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    regularMarketDayHigh: meta.regularMarketDayHigh ?? null,
    regularMarketDayLow: meta.regularMarketDayLow ?? null,
    regularMarketOpen: meta.regularMarketOpen ?? null,
    regularMarketPreviousClose: prev,
    regularMarketTime: meta.regularMarketTime ?? null,
    longName: meta.longName || null,
    shortName: meta.shortName || meta.longName || null,
    currency: meta.currency || 'USD',
    exchange: meta.exchangeName || null,
  };
  quoteCache.set(key, { t: Date.now(), q });
  return q;
}

async function getQuotes(symbols) {
  if (!symbols || symbols.length === 0) return [];
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = [];
  for (const s of unique) {
    try {
      out.push({ symbol: s, ok: true, quote: await getQuote(s), error: null });
    } catch (e) {
      out.push({ symbol: s, ok: false, quote: null, error: String(e?.message || e) });
    }
  }
  return out;
}

async function getHistorical(symbol, range) {
  const params = rangeToParams(range);
  const cacheKey = `${symbol.toUpperCase()}|${params.range}|${params.interval}`;
  const cached = histCache.get(cacheKey);
  if (cached && Date.now() - cached.t < HIST_TTL_MS) return cached.rows;
  const r = await chart(symbol, params);
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const adj = r.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    rows.push({
      date: new Date(ts[i] * 1000),
      close: closes[i],
      adjclose: adj[i] ?? closes[i],
    });
  }
  histCache.set(cacheKey, { t: Date.now(), rows });
  return rows;
}

async function getDailyHistorySince(symbol, periodStart) {
  const ms = Date.now() - new Date(periodStart).getTime();
  const days = ms / 86400000;
  let range = '1Y';
  if (days > 5 * 365) range = '5Y';
  else if (days > 365) range = '5Y';
  else if (days > 180) range = '1Y';
  else if (days > 90) range = '6M';
  else if (days > 31) range = '3M';
  else range = '1M';
  const rows = await getHistorical(symbol, range);
  return rows.filter((r) => r.date >= new Date(periodStart));
}

async function search(query) {
  if (!query || query.trim().length < 1) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query.trim())}&quotesCount=10&newsCount=0`;
  try {
    const j = await throttled(() => fetchJSON(url));
    return (j.quotes || [])
      .filter((q) => q.symbol && (q.quoteType === 'EQUITY' || q.quoteType === 'ETF'))
      .map((q) => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || '',
        exchange: q.exchange || '',
        type: q.quoteType,
      }));
  } catch (e) {
    console.error('Yahoo search failed:', e.message);
    return [];
  }
}

async function getNews(symbol, limit = 10) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${limit}`;
  try {
    const j = await throttled(() => fetchJSON(url));
    return (j.news || []).slice(0, limit).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      providerPublishTime: n.providerPublishTime,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
      relatedTickers: n.relatedTickers || [],
    }));
  } catch (e) {
    console.error('News fetch failed for', symbol, e.message);
    return [];
  }
}

module.exports = {
  getQuote,
  getQuotes,
  getHistorical,
  getDailyHistorySince,
  search,
  getNews,
};

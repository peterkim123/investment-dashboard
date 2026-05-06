const https = require('https');

const UA = 'Investment Dashboard personal use peter_kim@utexas.edu';

const tickerMapCache = { data: null, t: 0 };
const TICKER_TTL_MS = 24 * 60 * 60 * 1000;

const submissionsCache = new Map();
const SUBMISSIONS_TTL_MS = 15 * 60 * 1000;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timeout on ${url}`));
    });
  });
}

async function getTickerMap() {
  if (tickerMapCache.data && Date.now() - tickerMapCache.t < TICKER_TTL_MS) {
    return tickerMapCache.data;
  }
  const raw = await httpsGetJson('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const k of Object.keys(raw)) {
    const e = raw[k];
    map[String(e.ticker).toUpperCase()] = {
      cik: String(e.cik_str).padStart(10, '0'),
      name: e.title,
    };
  }
  tickerMapCache.data = map;
  tickerMapCache.t = Date.now();
  return map;
}

async function getCikForTicker(ticker) {
  const map = await getTickerMap();
  return map[ticker.toUpperCase()] || null;
}

async function getSubmissions(cik) {
  const cached = submissionsCache.get(cik);
  if (cached && Date.now() - cached.t < SUBMISSIONS_TTL_MS) return cached.data;
  const data = await httpsGetJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  submissionsCache.set(cik, { t: Date.now(), data });
  return data;
}

const TRACKED_FORMS = new Set([
  '10-K',
  '10-K/A',
  '10-Q',
  '10-Q/A',
  '8-K',
  '8-K/A',
  'DEF 14A',
  'DEFA14A',
  'PRE 14A',
  'S-1',
  'S-1/A',
  'S-3',
  '20-F',
  '6-K',
  '4',
  'SC 13D',
  'SC 13G',
  '13F-HR',
]);

async function getRecentFilings(ticker, lookbackDays = 90, maxResults = 25) {
  const entry = await getCikForTicker(ticker);
  if (!entry) return { ok: false, error: `No CIK found for ${ticker}`, filings: [] };
  const sub = await getSubmissions(entry.cik);
  const recent = sub?.filings?.recent;
  if (!recent) return { ok: true, filings: [], cik: entry.cik, name: entry.name };

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const filings = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form[i];
    if (!TRACKED_FORMS.has(form)) continue;
    const filed = new Date(recent.filingDate[i]);
    if (filed < cutoff) continue;
    const accession = recent.accessionNumber[i];
    const accessionNoDash = accession.replace(/-/g, '');
    const primaryDoc = recent.primaryDocument[i];
    filings.push({
      form,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i] || null,
      accession,
      description: recent.primaryDocDescription[i] || '',
      url: `https://www.sec.gov/Archives/edgar/data/${parseInt(entry.cik, 10)}/${accessionNoDash}/${primaryDoc}`,
      indexUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=40`,
    });
    if (filings.length >= maxResults) break;
  }
  return { ok: true, filings, cik: entry.cik, name: entry.name };
}

module.exports = { getCikForTicker, getRecentFilings };

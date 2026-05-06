const TRADING_DAYS = 252;

function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) r.push(closes[i] / prev - 1);
  }
  return r;
}

function mean(xs) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs, m) {
  if (xs.length < 2) return 0;
  m = m ?? mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

function stdev(xs) {
  return Math.sqrt(variance(xs));
}

function covariance(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (xs.length - 1);
}

function alignByDate(seriesA, seriesB) {
  const mapB = new Map();
  for (const r of seriesB) {
    const k = new Date(r.date).toISOString().slice(0, 10);
    mapB.set(k, r.adjclose ?? r.close);
  }
  const a = [];
  const b = [];
  for (const r of seriesA) {
    const k = new Date(r.date).toISOString().slice(0, 10);
    if (mapB.has(k)) {
      a.push(r.adjclose ?? r.close);
      b.push(mapB.get(k));
    }
  }
  return { a, b };
}

function sharpeRatio(returns, annualRiskFree = 0.04) {
  if (returns.length < 2) return null;
  const dailyRf = annualRiskFree / TRADING_DAYS;
  const excess = returns.map((r) => r - dailyRf);
  const sd = stdev(excess);
  if (sd === 0) return null;
  return (mean(excess) / sd) * Math.sqrt(TRADING_DAYS);
}

function betaAndAlpha(stockReturns, benchReturns, annualRiskFree = 0.04) {
  if (stockReturns.length !== benchReturns.length || stockReturns.length < 2) {
    return { beta: null, alpha: null };
  }
  const dailyRf = annualRiskFree / TRADING_DAYS;
  const stockExcess = stockReturns.map((r) => r - dailyRf);
  const benchExcess = benchReturns.map((r) => r - dailyRf);
  const varB = variance(benchExcess);
  if (varB === 0) return { beta: null, alpha: null };
  const beta = covariance(stockExcess, benchExcess) / varB;
  const alphaDaily = mean(stockExcess) - beta * mean(benchExcess);
  const alphaAnnual = alphaDaily * TRADING_DAYS;
  return { beta, alpha: alphaAnnual };
}

function totalReturn(closes) {
  if (closes.length < 2) return null;
  return closes[closes.length - 1] / closes[0] - 1;
}

function computeForSeries(stockHist, benchHist, annualRiskFree) {
  const { a, b } = alignByDate(stockHist, benchHist);
  if (a.length < 5) {
    return {
      sharpe: null,
      beta: null,
      alpha: null,
      excessReturn: null,
      stockReturn: null,
      benchReturn: null,
      n: a.length,
    };
  }
  const sr = dailyReturns(a);
  const br = dailyReturns(b);
  const sharpe = sharpeRatio(sr, annualRiskFree);
  const { beta, alpha } = betaAndAlpha(sr, br, annualRiskFree);
  const stockReturn = totalReturn(a);
  const benchReturn = totalReturn(b);
  return {
    sharpe,
    beta,
    alpha,
    excessReturn: stockReturn - benchReturn,
    stockReturn,
    benchReturn,
    n: a.length,
  };
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

function simpleAnnualReturn(initialCost, currentValue, days) {
  if (!(initialCost > 0) || !(currentValue > 0) || !(days > 0)) return null;
  const years = days / 365.25;
  return Math.pow(currentValue / initialCost, 1 / years) - 1;
}

module.exports = {
  dailyReturns,
  alignByDate,
  sharpeRatio,
  betaAndAlpha,
  totalReturn,
  computeForSeries,
  irr,
  simpleAnnualReturn,
};

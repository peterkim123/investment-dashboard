const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  positions: {
    load: () => ipcRenderer.invoke('positions:load'),
    save: (positions) => ipcRenderer.invoke('positions:save', positions),
  },
  watchlist: {
    load: () => ipcRenderer.invoke('watchlist:load'),
    save: (items) => ipcRenderer.invoke('watchlist:save', items),
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (s) => ipcRenderer.invoke('settings:save', s),
  },
  quotes: {
    getMany: (symbols) => ipcRenderer.invoke('quotes:get', symbols),
    getOne: (symbol) => ipcRenderer.invoke('quote:single', symbol),
  },
  history: (symbol, range) => ipcRenderer.invoke('history:get', { symbol, range }),
  search: (q) => ipcRenderer.invoke('symbol:search', q),
  news: (symbol, limit) => ipcRenderer.invoke('news:get', { symbol, limit }),
  filings: (symbol, lookbackDays, max) =>
    ipcRenderer.invoke('filings:get', { symbol, lookbackDays, max }),
  metrics: (symbol, purchaseDate) =>
    ipcRenderer.invoke('metrics:compute', { symbol, purchaseDate }),
  riskFree: () => ipcRenderer.invoke('rf:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  sync: {
    test: (url, token) => ipcRenderer.invoke('sync:test', { url, token }),
    pull: () => ipcRenderer.invoke('sync:pull'),
    push: (positions) => ipcRenderer.invoke('sync:push', { positions }),
    setBaseVersion: (v) => ipcRenderer.invoke('sync:setBaseVersion', v),
  },
});

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
  alerts: {
    load: () => ipcRenderer.invoke('alerts:load'),
    save: (alerts) => ipcRenderer.invoke('alerts:save', alerts),
  },
  earnings: {
    batch: (symbols) => ipcRenderer.invoke('earnings:batch', symbols),
  },
  obsidian: {
    get: (ticker) => ipcRenderer.invoke('obsidian:get', ticker),
    listAll: () => ipcRenderer.invoke('obsidian:listAll'),
    read: (notePath) => ipcRenderer.invoke('obsidian:read', notePath),
  },
  modelsApi: {
    list: (ticker) => ipcRenderer.invoke('models:list', ticker),
    listAll: () => ipcRenderer.invoke('models:listAll'),
    add: (ticker, sourcePaths, source, note) => ipcRenderer.invoke('models:add', { ticker, sourcePaths, source, note }),
    remove: (filePath) => ipcRenderer.invoke('models:remove', filePath),
    updateMeta: (ticker, name, source, note) => ipcRenderer.invoke('models:updateMeta', { ticker, name, source, note }),
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts || {}),
  },
  research: {
    state: () => ipcRenderer.invoke('research:state'),
    createSection: (payload) => ipcRenderer.invoke('research:createSection', payload),
    updateSection: (id, patch) => ipcRenderer.invoke('research:updateSection', { id, patch }),
    deleteSection: (id) => ipcRenderer.invoke('research:deleteSection', id),
    addFiles: (sectionId, sourcePaths, source, note, forceType) => ipcRenderer.invoke('research:addFiles', { sectionId, sourcePaths, source, note, forceType }),
    updateFile: (id, patch) => ipcRenderer.invoke('research:updateFile', { id, patch }),
    deleteFile: (id) => ipcRenderer.invoke('research:deleteFile', id),
    readNote: (id) => ipcRenderer.invoke('research:readNote', id),
  },
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p),
  portfolios: {
    state: () => ipcRenderer.invoke('portfolios:state'),
    setActive: (id) => ipcRenderer.invoke('portfolios:setActive', id),
    create: (name) => ipcRenderer.invoke('portfolios:create', name),
    rename: (id, name) => ipcRenderer.invoke('portfolios:rename', { id, name }),
    delete: (id) => ipcRenderer.invoke('portfolios:delete', id),
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

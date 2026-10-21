const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', 'data_store.json');
const tmpStorePath = '/tmp/data_store.json';

let storeCache = null;

function getStore() {
  if (storeCache) return storeCache;
  try {
    if (fs.existsSync(tmpStorePath)) {
      storeCache = JSON.parse(fs.readFileSync(tmpStorePath, 'utf8'));
      return storeCache;
    }
  } catch (e) {}

  try {
    if (fs.existsSync(storePath)) {
      storeCache = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return storeCache;
    }
  } catch (e) {
    console.error('[StoreSync] Read error:', e.message);
  }
  storeCache = {};
  return storeCache;
}

function updateStore(updater) {
  try {
    const store = getStore();
    updater(store);
    storeCache = store;

    // 1. Try to write to /tmp/data_store.json (always writable on Vercel serverless)
    try {
      fs.writeFileSync(tmpStorePath, JSON.stringify(store, null, 2), 'utf8');
    } catch (tmpErr) {
      // Ignored if /tmp unavailable
    }

    // 2. Try to write to project root data_store.json (for local development)
    try {
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
    } catch (localErr) {
      // Ignored if root filesystem is read-only (e.g. Vercel Lambda /var/task)
    }

    return store;
  } catch (e) {
    console.error('[StoreSync] Write error:', e.message);
    return null;
  }
}

module.exports = {
  getStore,
  updateStore,
  storePath,
  tmpStorePath
};

const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', 'data_store.json');

function getStore() {
  try {
    if (fs.existsSync(storePath)) {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    }
  } catch (e) {
    console.error('[StoreSync] Read error:', e.message);
  }
  return {};
}

function updateStore(updater) {
  try {
    const store = getStore();
    updater(store);
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
    return store;
  } catch (e) {
    console.error('[StoreSync] Write error:', e.message);
    return null;
  }
}

module.exports = {
  getStore,
  updateStore,
  storePath
};

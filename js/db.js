// IndexedDB storage. All data is loaded into memory at start (it is small) and written through on change.
const DB_NAME = 'masroofi';
const DB_VERSION = 1;
export const STORES = ['entries', 'transfers', 'incomes', 'obligations', 'chat'];

let db;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function openDB() {
  if (db) return db;
  db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return db;
}

const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);

export const getAll = store => req(tx(store).getAll());
export const put = (store, obj) => req(tx(store, 'readwrite').put(obj));
export const del = (store, id) => req(tx(store, 'readwrite').delete(id));
export const clearStore = store => req(tx(store, 'readwrite').clear());
export const kvGet = key => req(tx('kv').get(key));
export const kvSet = (key, val) => req(tx('kv', 'readwrite').put(val, key));
export const kvDel = key => req(tx('kv', 'readwrite').delete(key));

export async function kvAll() {
  const store = tx('kv');
  const [keys, vals] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
  const out = {};
  keys.forEach((k, i) => { out[k] = vals[i]; });
  return out;
}

/** Replace everything (used by import). */
export async function replaceAll(data) {
  const names = [...STORES, 'kv'];
  await new Promise((res, rej) => {
    const t = db.transaction(names, 'readwrite');
    for (const s of STORES) {
      const os = t.objectStore(s);
      os.clear();
      for (const rec of data[s] || []) os.put(rec);
    }
    const kv = t.objectStore('kv');
    const keepKey = data.__keepKey; // keep existing API key if the backup has none
    const oldKeyReq = kv.get('apiKey');
    oldKeyReq.onsuccess = () => {
      const oldKey = oldKeyReq.result;
      kv.clear();
      for (const [k, v] of Object.entries(data.kv || {})) kv.put(v, k);
      if (keepKey && oldKey && !(data.kv && data.kv.apiKey)) kv.put(oldKey, 'apiKey');
    };
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

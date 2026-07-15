// Session persistence (docs/DECISIONS.md D-004).
// IndexedDB is browser-native, so this keeps the "no dependencies, nothing
// leaves the browser" rule. Every call degrades to a no-op when storage is
// unavailable (private mode, disabled storage) - losing resume is acceptable,
// breaking review is not.

const DB_NAME = "fieldtrust";
const DB_VERSION = 1;
const STORE = "sessions";

function openDb() {
  return new Promise(resolve => {
    let req;
    try {
      if (!window.indexedDB) return resolve(null);
      req = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "batchHash" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx(db, mode, fn) {
  return new Promise(resolve => {
    let req;
    try {
      req = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch (e) { return resolve(null); }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function saveSession(session) {
  const db = await openDb();
  if (!db) return null;
  const res = await tx(db, "readwrite", s => s.put(session));
  db.close();
  return res;
}

async function loadSession(batchHash) {
  const db = await openDb();
  if (!db) return null;
  const res = await tx(db, "readonly", s => s.get(batchHash));
  db.close();
  return res || null;
}

async function deleteSession(batchHash) {
  const db = await openDb();
  if (!db) return null;
  const res = await tx(db, "readwrite", s => s.delete(batchHash));
  db.close();
  return res;
}

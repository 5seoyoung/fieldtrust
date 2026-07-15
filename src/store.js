// Session persistence (docs/DECISIONS.md D-004).
// IndexedDB is browser-native, so this keeps the "no dependencies, nothing
// leaves the browser" rule. Every call degrades to a no-op when storage is
// unavailable (private mode, disabled storage) - losing resume is acceptable,
// breaking review is not.

const DB_NAME = "fieldtrust";
const DB_VERSION = 1;
const STORE = "sessions";

let dbPromise = null;

// One cached connection. Opening and closing per write raced badly under a
// fast reviewer: 40 rapid decisions persisted only 34.
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let req;
    try {
      if (!window.indexedDB) return resolve(null);
      req = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "batchHash" });
    };
    req.onsuccess = () => {
      // a dropped connection (storage cleared, version change) must not
      // poison every later write
      req.result.onclose = () => { dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function runTx(db, mode, fn) {
  return new Promise(resolve => {
    let req;
    try {
      req = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch (e) { return resolve(null); }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// Writes are serialized and coalesced: a burst of decisions collapses to a
// couple of transactions, and the newest snapshot is always the one that
// lands. Without this, out-of-order puts silently lost decisions.
let writeChain = Promise.resolve();
let pendingSession = null;

function saveSession(session) {
  // snapshot now - the caller's `corrections` object keeps mutating
  pendingSession = JSON.parse(JSON.stringify(session));
  writeChain = writeChain.then(async () => {
    if (!pendingSession) return;
    const s = pendingSession;
    pendingSession = null;
    const db = await openDb();
    if (!db) return;
    await runTx(db, "readwrite", store => store.put(s));
  });
  return writeChain;
}

// Resolves once every queued write has landed. Tests await this; nothing in
// the app needs to.
function flushSessions() {
  return writeChain;
}

async function loadSession(batchHash) {
  const db = await openDb();
  if (!db) return null;
  return (await runTx(db, "readonly", s => s.get(batchHash))) || null;
}

async function deleteSession(batchHash) {
  await writeChain;                  // do not let a queued write resurrect it
  pendingSession = null;
  const db = await openDb();
  if (!db) return null;
  return runTx(db, "readwrite", s => s.delete(batchHash));
}

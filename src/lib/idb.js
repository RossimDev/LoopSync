/**
 * LoopSync IndexedDB helper
 * Stores: bases (video/image/audio files) and history (metadata + thumb)
 */

const DB_NAME = "loopsync-db";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("bases")) {
        const store = db.createObjectStore("bases", { keyPath: "id" });
        store.createIndex("kind", "kind", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      // Cleanup old stores if any
      if (db.objectStoreNames.contains("templates")) {
        // keep for backwards compat, don't delete
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = callback(store);
    } catch (e) {
      db.close();
      reject(e);
      return;
    }

    if (result && typeof result.then === "function") {
      result.then(
        (v) => {
          tx.oncomplete = () => {
            db.close();
            resolve(v);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        },
        (err) => {
          db.close();
          reject(err);
        }
      );
    } else {
      // If callback returned IDBRequest, handle it
      if (result && result instanceof IDBRequest) {
        result.onsuccess = () => {
          // wait for tx complete
        };
        result.onerror = () => reject(result.error);
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result ? result.result : undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    }
  });
}

// More straightforward promise wrappers
function idbGetAll(storeName) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result || []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    } catch (e) {
      reject(e);
    }
  });
}

function idbGet(storeName, id) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    } catch (e) {
      reject(e);
    }
  });
}

function idbPut(storeName, value) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (e) {
      reject(e);
    }
  });
}

function idbDelete(storeName, id) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (e) {
      reject(e);
    }
  });
}

function idbClear(storeName) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (e) {
      reject(e);
    }
  });
}

export { openDB, idbGetAll, idbGet, idbPut, idbDelete, idbClear };

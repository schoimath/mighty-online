// A browser keeps only messages actually delivered to this room and account.
// The full room archive is independent and cannot be read through this cache.
let opening;
function openDevice() {
  if (!opening) {
    opening = new Promise((resolve,reject) => {
      const request = indexedDB.open('mighty-received-chat',1);
      request.onupgradeneeded = () => request.result.createObjectStore('messages',{keyPath:['account','room','id']});
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => { opening = null; throw error; });
  }
  return opening;
}

export function deviceChat(room, userId) {
  const account = userId || 'anonymous';
  return {
    room, account,
    async save(message, own) {
      const db = await openDevice();
      return new Promise((resolve,reject) => {
        const tx = db.transaction('messages','readwrite');
        tx.objectStore('messages').put({...message,own,account,room});
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    },
    async page(before = null, limit = 60) {
      const db = await openDevice();
      return new Promise((resolve,reject) => {
        const tx = db.transaction('messages','readonly'), rows = [];
        const bounds = IDBKeyRange.bound([account,room,0],[account,room,before ?? Number.MAX_SAFE_INTEGER],false,before !== null);
        const request = tx.objectStore('messages').openCursor(bounds,'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor && rows.length < limit) {
            rows.push(cursor.value); cursor.continue();
          } else resolve({messages:rows.reverse(),hasMore:Boolean(cursor)});
        };
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    }
  };
}

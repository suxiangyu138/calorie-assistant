const DB_NAME = 'calorieApp';
const DB_VERSION = 1;
const STORE_MEALS = 'meals';
const STORE_WEIGHTS = 'weights';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MEALS)) {
        const meals = db.createObjectStore(STORE_MEALS, { keyPath: 'id', autoIncrement: true });
        meals.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_WEIGHTS)) {
        db.createObjectStore(STORE_WEIGHTS, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function withStore(name, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    const req = fn(store);
    if (req) {
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  }));
}

function addMeal(meal) {
  return withStore(STORE_MEALS, 'readwrite', (s) => s.add(meal));
}

function putMeal(meal) {
  return withStore(STORE_MEALS, 'readwrite', (s) => s.put(meal));
}

function deleteMeal(id) {
  return withStore(STORE_MEALS, 'readwrite', (s) => s.delete(id));
}

function getMealsByDate(date) {
  return withStore(STORE_MEALS, 'readonly', (s) => s.index('date').getAll(IDBKeyRange.only(date)))
    .then((rows) => (rows || []).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)));
}

function getMealsRange(start, end) {
  return withStore(STORE_MEALS, 'readonly', (s) => s.index('date').getAll(IDBKeyRange.bound(start, end)))
    .then((rows) => rows || []);
}

function putWeight(record) {
  return withStore(STORE_WEIGHTS, 'readwrite', (s) => s.put(record));
}

function getWeightsRange(start, end) {
  return withStore(STORE_WEIGHTS, 'readonly', (s) => s.getAll(IDBKeyRange.bound(start, end)))
    .then((rows) => (rows || []).sort((a, b) => a.date.localeCompare(b.date)));
}

function getLatestWeight() {
  return withStore(STORE_WEIGHTS, 'readonly', (s) => s.getAll())
    .then((rows) => {
      if (!rows || !rows.length) return null;
      return rows.sort((a, b) => a.date.localeCompare(b.date))[rows.length - 1];
    });
}

function exportAll() {
  return Promise.all([
    withStore(STORE_MEALS, 'readonly', (s) => s.getAll()),
    withStore(STORE_WEIGHTS, 'readonly', (s) => s.getAll())
  ]).then(([meals, weights]) => ({
    app: 'calorieApp',
    version: 1,
    exportedAt: new Date().toISOString(),
    meals: meals || [],
    weights: weights || []
  }));
}

function importAll(data) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MEALS, STORE_WEIGHTS], 'readwrite');
    const meals = tx.objectStore(STORE_MEALS);
    const weights = tx.objectStore(STORE_WEIGHTS);
    meals.clear();
    weights.clear();
    (data.meals || []).forEach((row) => {
      const meal = { ...row };
      delete meal.id;
      meals.add(meal);
    });
    (data.weights || []).forEach((row) => weights.put({ date: row.date, weight: row.weight, bodyFat: row.bodyFat ?? null }));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('import aborted'));
  }));
}

function clearAll() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MEALS, STORE_WEIGHTS], 'readwrite');
    tx.objectStore(STORE_MEALS).clear();
    tx.objectStore(STORE_WEIGHTS).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('clear aborted'));
  }));
}

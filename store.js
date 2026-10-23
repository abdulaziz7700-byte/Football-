// Data layer. Uses Firebase (Firestore) when firebase-config.js is filled in,
// otherwise falls back to this browser's localStorage so the app can be tried locally.
import { FIREBASE_CONFIG } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
export const isOnline = () => Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);

export async function createStore() {
  return isOnline() ? firebaseStore() : localStore();
}

// Every store exposes the same API:
//   subscribe(cb)            cb({trainings, settings}) on every change
//   addTraining(t)           -> id
//   updateTraining(id, fn)   fn(copy) mutates the training; runs atomically
//   deleteTraining(id)
//   saveSettings(s)

async function firebaseStore() {
  const { initializeApp } = await import(`${SDK}/firebase-app.js`);
  const { getAuth, signInAnonymously } = await import(`${SDK}/firebase-auth.js`);
  const fs = await import(`${SDK}/firebase-firestore.js`);
  const app = initializeApp(FIREBASE_CONFIG);
  await signInAnonymously(getAuth(app));
  const db = fs.getFirestore(app);
  const col = fs.collection(db, "trainings");
  const settingsRef = fs.doc(db, "meta", "settings");
  const state = { trainings: [], settings: undefined };
  let cbs = [];
  const emit = () => state.settings !== undefined && cbs.forEach(cb => cb(state));
  fs.onSnapshot(col, snap => { state.trainings = snap.docs.map(d => ({ ...d.data(), id: d.id })); emit(); });
  fs.onSnapshot(settingsRef, snap => { state.settings = snap.exists() ? snap.data() : null; emit(); });
  return {
    subscribe(cb) { cbs.push(cb); emit(); },
    async addTraining(t) { return (await fs.addDoc(col, t)).id; },
    async updateTraining(id, fn) {
      const ref = fs.doc(db, "trainings", id);
      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("التمرين محذوف");
        const t = snap.data();
        fn(t);
        tx.set(ref, t);
      });
    },
    async deleteTraining(id) { await fs.deleteDoc(fs.doc(db, "trainings", id)); },
    async saveSettings(s) { await fs.setDoc(settingsRef, s); },
  };
}

function localStore() {
  const KEY = "kora.data";
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { trainings: [], settings: null }; } catch { return { trainings: [], settings: null }; } };
  const write = d => { localStorage.setItem(KEY, JSON.stringify(d)); emit(); };
  let cbs = [];
  const emit = () => { const d = read(); cbs.forEach(cb => cb(d)); };
  window.addEventListener("storage", e => e.key === KEY && emit());
  return {
    subscribe(cb) { cbs.push(cb); cb(read()); },
    async addTraining(t) { const d = read(); const id = "t" + Date.now().toString(36); d.trainings.push({ ...t, id }); write(d); return id; },
    async updateTraining(id, fn) {
      const d = read(); const t = d.trainings.find(x => x.id === id);
      if (!t) throw new Error("التمرين محذوف");
      fn(t); write(d);
    },
    async deleteTraining(id) { const d = read(); d.trainings = d.trainings.filter(t => t.id !== id); write(d); },
    async saveSettings(s) { const d = read(); d.settings = s; write(d); },
  };
}

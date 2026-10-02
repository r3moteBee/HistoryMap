/**
 * History Map — storage layer (IndexedDB).
 *
 * Shared by the background service worker (which writes visits) and the map page (which reads
 * them and stores notes). Everything stays on this device; nothing is sent anywhere.
 *
 * Database "historymap", version 2:
 *   visits  { id, t, url, from, tabId, newTab }   one row per top-level navigation, indexed by time `t`.
 *                                                 `from` is the page you came from (null = new trail);
 *                                                 `newTab` marks links opened in a new tab.
 *   pages   { url, title, visits, first, last }   one row per normalized URL.
 *   notes   { id, text, updated }                 id = page URL, or "site:<domain>" in grouped view.
 *
 * Loaded as a classic script (importScripts in the worker, <script> in the page), so it exposes
 * two globals: `normUrl` and `HMDB`.
 */
/* exported HMDB, normUrl */

/** Query parameters that only track clicks; stripped so the same page maps to one node. */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_eid$|ref_src$|_hsenc$|_hsmi$)/i;

/**
 * Normalize a URL for use as a page identity: http(s) only, no #fragment, no tracking params.
 * @param {string} u
 * @returns {string|null} normalized URL, or null if the URL shouldn't be recorded
 */
function normUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING_PARAM.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return null;
  }
}

const HMDB = (() => {
  const DB_NAME = 'historymap';
  const DB_VERSION = 2; // v1: visits, pages · v2: + notes
  let dbPromise = null;

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

  /** Open (and if needed create/upgrade) the database. Upgrades are additive, so existing data is kept. */
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('visits')) {
            db.createObjectStore('visits', { keyPath: 'id', autoIncrement: true }).createIndex('t', 't');
          }
          if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
          if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        };
        r.onsuccess = () => {
          const db = r.result;
          // If another context upgrades the schema, close so it isn't blocked; the next call reopens.
          db.onversionchange = () => { db.close(); dbPromise = null; };
          res(db);
        };
        r.onerror = () => rej(r.error);
      });
    }
    return dbPromise;
  }

  /**
   * Record a navigation and bump the page's visit count.
   * @returns {Promise<number>} the new visit id
   */
  async function addVisit({ t, url, from, tabId, newTab = false }) {
    const db = await open();
    const tx = db.transaction(['visits', 'pages'], 'readwrite');
    const id = await req(tx.objectStore('visits').add({ t, url, from: from || null, tabId, newTab }));
    const pages = tx.objectStore('pages');
    const p = (await req(pages.get(url))) || { url, title: '', visits: 0, first: t };
    p.visits += 1;
    p.last = t;
    pages.put(p);
    await done(tx);
    return id;
  }

  /** Fill in a visit's missing "came from" (used when the source is only known after the page loads). */
  async function patchFrom(id, from, newTab = false) {
    const db = await open();
    const tx = db.transaction('visits', 'readwrite');
    const store = tx.objectStore('visits');
    const v = await req(store.get(id));
    if (v && !v.from) { v.from = from; v.newTab = newTab; store.put(v); }
    await done(tx);
  }

  /** @returns {Promise<boolean>} whether this URL has been recorded before */
  async function hasPage(url) {
    const db = await open();
    return (await req(db.transaction('pages').objectStore('pages').getKey(url))) !== undefined;
  }

  async function setTitle(url, title) {
    if (!url || !title) return;
    const db = await open();
    const tx = db.transaction('pages', 'readwrite');
    const store = tx.objectStore('pages');
    const p = await req(store.get(url));
    if (p && p.title !== title) { p.title = title; store.put(p); }
    await done(tx);
  }

  /** @returns {Promise<object[]>} visits with t >= since, oldest first */
  async function getVisits(since = 0) {
    const db = await open();
    return req(db.transaction('visits').objectStore('visits').index('t').getAll(IDBKeyRange.lowerBound(since)));
  }

  /** Cheap change check for the map's auto-refresh. */
  async function countVisits() {
    const db = await open();
    return req(db.transaction('visits').objectStore('visits').count());
  }

  /** @returns {Promise<Map<string, object>>} url -> page */
  async function getPages() {
    const db = await open();
    const all = await req(db.transaction('pages').objectStore('pages').getAll());
    return new Map(all.map((p) => [p.url, p]));
  }

  /** @returns {Promise<Map<string, object>>} id -> note */
  async function getNotes() {
    const db = await open();
    const all = await req(db.transaction('notes').objectStore('notes').getAll());
    return new Map(all.map((n) => [n.id, n]));
  }

  /** Save a note; empty text deletes it. */
  async function setNote(id, text) {
    const db = await open();
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    if (text.trim()) store.put({ id, text, updated: Date.now() }); else store.delete(id);
    await done(tx);
  }

  /** Merge an export file's contents into the database. Visits get new ids; pages/notes overwrite by key. */
  async function importData({ visits = [], pages = [], notes = [] }) {
    if (!Array.isArray(visits) || !Array.isArray(pages) || !Array.isArray(notes)) {
      throw new Error('not a History Map export file');
    }
    const db = await open();
    const tx = db.transaction(['visits', 'pages', 'notes'], 'readwrite');
    const vs = tx.objectStore('visits'), ps = tx.objectStore('pages'), ns = tx.objectStore('notes');
    for (const v of visits) {
      if (typeof v?.url !== 'string' || typeof v?.t !== 'number') continue;
      const { id, ...rest } = v; // eslint-disable-line no-unused-vars
      vs.add(rest);
    }
    for (const p of pages) if (typeof p?.url === 'string') ps.put(p);
    for (const n of notes) if (typeof n?.id === 'string' && typeof n?.text === 'string') ns.put(n);
    await done(tx);
  }

  /** Delete all visits, pages and notes. */
  async function clear() {
    const db = await open();
    const tx = db.transaction(['visits', 'pages', 'notes'], 'readwrite');
    for (const s of ['visits', 'pages', 'notes']) tx.objectStore(s).clear();
    await done(tx);
  }

  return { addVisit, patchFrom, hasPage, setTitle, getVisits, countVisits, getPages, getNotes, setNote, importData, clear };
})();

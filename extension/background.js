/**
 * History Map — background service worker.
 *
 * Records every top-level navigation as an edge "page you were on → page you went to".
 *
 * Where "came from" comes from, in priority order:
 *   1. Same tab: the tab's previous page.
 *   2. New tab, browser-reported: the opener tab (tabs.onCreated.openerTabId /
 *      webNavigation.onCreatedNavigationTarget). Chrome reports this; Safari often doesn't.
 *   3. New tab, click-matched: content.js reports link clicks that will open a new tab
 *      (target=_blank, ⌘/Ctrl-click, middle-click, context menu); we match the new tab's first page
 *      to that click — exact URL first, else the most recent click within a few seconds (redirects).
 *   4. Referrer: the page's document.referrer, but only if it's a page we've already recorded
 *      (cross-site referrers are usually trimmed to just the origin and would attach to the wrong node).
 * A typed URL / bookmark starts a new trail where the browser reports it (Chrome; not Safari).
 *
 * Per-tab state lives in memory and in storage.session so it survives the worker being suspended.
 */
importScripts('db.js');

const api = globalThis.browser ?? globalThis.chrome;
const session = api.storage?.session; // absent on very old Safari; memory-only then

/** Navigations the browser reports as typed / bookmark / address-bar search → start a new trail. */
const FRESH_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword']);
const CLICK_TTL_MS = 15000;       // how long a reported click stays matchable
const CLICK_FALLBACK_MS = 5000;   // window for matching a redirected link to "the most recent click"

// ---------- serialized work queue ----------
// Navigation events arrive concurrently; running handlers one at a time avoids read-modify-write races.
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => console.error('[HistoryMap]', e)));

// ---------- per-tab state ----------
// { url, visitId, needsRef, pendingFrom }
//   url         page currently shown in the tab
//   visitId     id of the visit that brought it there (so its "from" can be patched later)
//   needsRef    "from" is still unknown and may be filled in by a click match or referrer
//   pendingFrom for a brand-new tab: the opener's page, used by the tab's first navigation
const tabs = new Map();
const tabKey = (id) => 'tab:' + id;

async function getTab(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  if (session) {
    const o = await session.get(tabKey(tabId));
    if (o[tabKey(tabId)]) { tabs.set(tabId, o[tabKey(tabId)]); return o[tabKey(tabId)]; }
  }
  return {};
}

async function setTab(tabId, state) {
  tabs.set(tabId, state);
  if (session) await session.set({ [tabKey(tabId)]: state });
}

async function dropTab(tabId) {
  tabs.delete(tabId);
  if (session) await session.remove(tabKey(tabId));
}

// ---------- link clicks reported by content.js ----------
let clicks = []; // { from, to, t, sourceTabId, exactOnly }

/** Find (and consume) the click that most likely opened `url` in tab `tabId`. */
function takeClick(url, tabId, now = Date.now()) {
  clicks = clicks.filter((c) => now - c.t < CLICK_TTL_MS);
  let i = clicks.findIndex((c) => c.to === url && c.sourceTabId !== tabId);
  if (i < 0) {
    // The link probably redirected (t.co, search results…): take the most recent new-tab click.
    for (let j = clicks.length - 1; j >= 0; j--) {
      const c = clicks[j];
      if (!c.exactOnly && c.sourceTabId !== tabId && now - c.t < CLICK_FALLBACK_MS) { i = j; break; }
    }
  }
  return i < 0 ? null : clicks.splice(i, 1)[0];
}

// ---------- navigation handling ----------
function onNavigation(details) {
  if (details.frameId !== 0 || details.tabId < 0) return; // top-level frames in real tabs only
  const url = normUrl(details.url);
  if (!url) return;
  enqueue(async () => {
    const st = await getTab(details.tabId);
    if (st.url === url) return; // reload, or a same-page update
    const fresh = FRESH_TRANSITIONS.has(details.transitionType);
    let from = fresh ? null : (st.url || st.pendingFrom || null);
    let newTab = !st.url && !!st.pendingFrom;
    if (!st.url && !from && !fresh) {
      const c = takeClick(url, details.tabId);
      if (c) { from = c.from; newTab = true; }
    }
    const id = await HMDB.addVisit({ t: Math.round(details.timeStamp || Date.now()), url, from, tabId: details.tabId, newTab });
    await setTab(details.tabId, { url, visitId: id, needsRef: !from && !fresh });
  });
}

/** A tab was opened from another tab: remember the source page for the new tab's first navigation. */
function markOpener(newTabId, sourceTabId) {
  if (sourceTabId == null || sourceTabId < 0 || newTabId === sourceTabId) return;
  enqueue(async () => {
    const src = await getTab(sourceTabId);
    const st = await getTab(newTabId);
    if (src.url && !st.url) await setTab(newTabId, { ...st, pendingFrom: src.url });
  });
}

/** Page loaded (from content.js): store its title and, if still unknown, fill in where it came from. */
function onPageReport(msg, tabId) {
  const url = normUrl(msg.url);
  if (!url) return;
  enqueue(async () => {
    await HMDB.setTitle(url, msg.title);
    const st = await getTab(tabId);
    if (!(st.needsRef && st.url === url && st.visitId)) return;
    const click = takeClick(url, tabId); // may have arrived after the navigation was recorded
    const ref = normUrl(msg.referrer);
    if (click) {
      await HMDB.patchFrom(st.visitId, click.from, true);
    } else if (ref && ref !== url && (await HMDB.hasPage(ref))) {
      await HMDB.patchFrom(st.visitId, ref, false);
    } else {
      return;
    }
    await setTab(tabId, { ...st, needsRef: false });
  });
}

// ---------- wiring ----------
api.webNavigation.onCommitted.addListener(onNavigation);
api.webNavigation.onHistoryStateUpdated?.addListener(onNavigation); // pushState sites (YouTube, GitHub…)
api.webNavigation.onCreatedNavigationTarget?.addListener((d) => markOpener(d.tabId, d.sourceTabId));
api.tabs.onCreated.addListener((tab) => markOpener(tab.id, tab.openerTabId));
api.tabs.onRemoved.addListener((tabId) => enqueue(() => dropTab(tabId)));
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.title && tab.url) enqueue(() => HMDB.setTitle(normUrl(tab.url), change.title));
});

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab) return;
  if (msg.type === 'hm-click') {
    const from = normUrl(msg.from), to = normUrl(msg.to);
    if (from && to) clicks.push({ from, to, t: Date.now(), sourceTabId: sender.tab.id, exactOnly: !!msg.exactOnly });
  } else if (msg.type === 'hm-page') {
    onPageReport(msg, sender.tab.id);
  }
});

api.action.onClicked.addListener(() => api.tabs.create({ url: api.runtime.getURL('map.html') }));

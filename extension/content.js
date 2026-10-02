/**
 * History Map — content script (runs on every http/https page).
 *
 * Sends the background worker two kinds of messages:
 *   hm-page   page URL, title and document.referrer (on load, and when the title changes)
 *   hm-click  a link click that will open a new tab, so the new tab can be tied back to this page.
 *             Safari doesn't reliably tell extensions which tab opened a new one; this fills the gap.
 * Nothing is read from the page beyond its URL, title, referrer and the clicked link's address.
 */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const send = (m) => { try { api.runtime.sendMessage(m); } catch { /* extension was reloaded */ } };
  const reportPage = () => send({ type: 'hm-page', url: location.href, title: document.title, referrer: document.referrer || '' });
  const reportClick = (to, exactOnly = false) => send({ type: 'hm-click', from: location.href, to, exactOnly });

  reportPage();

  // Titles often change after load (single-page apps, lazy titles).
  let lastTitle = document.title;
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      if (document.title !== lastTitle) { lastTitle = document.title; reportPage(); }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  /** The http(s) link an event happened on, if any (works inside shadow DOM too). */
  const linkFrom = (e) => {
    const a = e.composedPath().find((n) => n.tagName === 'A' && typeof n.href === 'string' && n.href);
    return a && /^https?:/.test(a.href) ? a : null;
  };
  const opensNewTab = (a) => !!a.target && !['_self', '_parent', '_top'].includes(a.target);

  // Left click on a target=_blank link, or ⌘/Ctrl-click. (Shift-click in Safari adds to Reading List.)
  document.addEventListener('click', (e) => {
    const a = linkFrom(e);
    if (a && (opensNewTab(a) || e.metaKey || e.ctrlKey)) reportClick(a.href);
  }, true);

  // Middle click.
  document.addEventListener('auxclick', (e) => {
    const a = linkFrom(e);
    if (a && e.button === 1) reportClick(a.href);
  }, true);

  // Right-click → "Open Link in New Tab". We can't know which menu item was chosen, so only an
  // exact URL match will use this.
  document.addEventListener('contextmenu', (e) => {
    const a = linkFrom(e);
    if (a) reportClick(a.href, true);
  }, true);
})();

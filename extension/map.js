/**
 * History Map — map page.
 *
 * Reads recorded visits from IndexedDB (db.js) and draws them as a directed graph with d3:
 * nodes are pages (or whole sites when grouped), edges are "you went from A to B".
 *
 * Sections:
 *   1. Settings & state        6. Rendering (layout, draw, fit)
 *   2. Helpers                 7. Detail panel
 *   3. Node styles & shapes    8. Style picker
 *   4. Building the graph      9. Image export (SVG / PNG / PDF)
 *   5. Sidebar site list      10. Data export / import / clear
 *                             11. Controls, keyboard, live refresh, start-up
 *
 * Settings and styles are stored in localStorage (per-extension, local to this device);
 * history and notes live in IndexedDB.
 */
/* global d3, HMDB */
'use strict';

// =====================================================================
// 1. Settings & state
// =====================================================================

const SETTINGS_KEY = 'hm-settings';
const DEFAULT_SETTINGS = {
  range: 'today',          // today | 24h | 7d | 30d | all
  layout: 'lr',            // lr (left→right tree) | td (top→down tree) | force
  shape: 'circle',         // default node shape
  groupBySite: false,
  showNeighbors: true,     // show pages outside the site filter as grey "ghost" nodes
  showLabels: true,
  sidebar: true,           // options panel open
  excluded: [],            // sites hidden by the filter (stored as exclusions so new sites appear by default)
  styles: {},              // per-site style:  { [site]: { color?, shape? } }
  nodeStyles: {},          // per-page style:  { [url | 'site:x']: { color?, shape?, cascade? } }
};

const settings = { ...DEFAULT_SETTINGS, ...readSettings() };
const excluded = new Set(settings.excluded);

let visits = [];           // all visits, oldest first
let pages = new Map();     // url -> { title, ... }
let notes = new Map();     // note id -> { id, text, updated }
let lastVisitCount = -1;   // for auto-refresh change detection
let siteCounts = new Map();// site -> visits in range (from the last render)
let graph = { nodes: [], links: [] };
let selected = null;       // id of the node shown in the detail panel

function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function save() {
  settings.excluded = [...excluded];
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// =====================================================================
// 2. Helpers
// =====================================================================

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an HTML element with an optional class and text. */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
/** Create an SVG element with attributes. */
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}
function button(cls, text, onClick, title) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  if (onClick) b.onclick = onClick;
  return b;
}
function externalLink(href, text, cls) {
  const a = el('a', cls, text);
  a.href = href; a.target = '_blank'; a.rel = 'noopener';
  return a;
}
function download(blob, filename) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const datedName = (ext) => `history-map-${new Date().toISOString().slice(0, 10)}.${ext}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Two-part public suffixes, so "bbc.co.uk" groups as one site rather than "co.uk". Not exhaustive. */
const TWO_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
  'ne.jp', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.kr', 'co.za', 'com.sg', 'com.tr', 'com.ar', 'gc.ca']);

/** The "site" a URL belongs to (registrable domain, approximately): en.wikipedia.org → wikipedia.org. */
function siteOf(url) {
  const h = hostOf(url);
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h; // IPs, localhost
  const parts = h.split('.');
  const last2 = parts.slice(-2).join('.');
  return parts.length > 2 && TWO_PART_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** Page title for display, without a trailing " - SiteName" (e.g. "France - Wikipedia" → "France"). */
function titleOf(url) {
  const title = pages.get(url)?.title;
  if (!title) {
    try { const u = new URL(url); return hostOf(url) + (u.pathname === '/' ? '' : decodeURIComponent(u.pathname)); } catch { return url; }
  }
  const m = title.match(/^(.*\S)\s+[-–—|·:]\s+([^-–—|·:]{2,40})$/);
  if (!m) return title;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = norm(siteOf(url).split('.')[0]), suffix = norm(m[2]);
  return name && suffix && (suffix.includes(name) || name.includes(suffix)) ? m[1] : title;
}

/** Display label for a graph node. */
const labelOf = (n) => (n.url ? titleOf(n.url) : n.id);

/** Notes and per-page styles are keyed by page URL, or "site:<domain>" in grouped view. */
const nodeKey = (n) => (n.url ? n.url : 'site:' + n.id);

function rangeStart() {
  const now = Date.now(), day = 864e5;
  switch (settings.range) {
    case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case '24h': return now - day;
    case '7d': return now - 7 * day;
    case '30d': return now - 30 * day;
    default: return 0;
  }
}
const RANGE_LABEL = { today: 'Today', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };

// =====================================================================
// 3. Node styles & shapes
// =====================================================================
// Style precedence for a node: its own style > nearest upstream page with "apply downstream"
// > its site's style > defaults (hashed site color, default shape). Color and shape resolve separately.

const PALETTE = ['#2563eb', '#e8590c', '#2f9e44', '#c2255c', '#7048e8', '#0c8599',
  '#e67700', '#5c940d', '#d6336c', '#1971c2', '#9c36b5', '#087f5b'];
const SHAPES = { circle: 'Circle', square: 'Square', diamond: 'Diamond', triangle: 'Triangle',
  hexagon: 'Hexagon', star: 'Star', cross: 'Cross', wye: 'Wye' };
const D3_SYMBOLS = { circle: d3.symbolCircle, square: d3.symbolSquare, diamond: d3.symbolDiamond,
  triangle: d3.symbolTriangle, star: d3.symbolStar, cross: d3.symbolCross, wye: d3.symbolWye };

function hashString(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
const siteColor = (site) => settings.styles[site]?.color || PALETTE[hashString(site) % PALETTE.length];
const siteShape = (site) => settings.styles[site]?.shape || settings.shape;

/** SVG path for a shape with the same area as a circle of radius r (so size still means "visits"). */
function shapePath(shape, r) {
  if (shape === 'hexagon') {
    const R = r * Math.sqrt((2 * Math.PI) / (3 * Math.sqrt(3)));
    return 'M' + d3.range(6).map((i) => [R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)]).join('L') + 'Z';
  }
  return d3.symbol(D3_SYMBOLS[shape] || d3.symbolCircle, Math.PI * r * r)();
}

/** Small inline SVG icon of a shape, for buttons and lists. */
function shapeIcon(shape, fill, size = 14) {
  const icon = svgEl('svg', { width: size, height: size, viewBox: `${-size / 2} ${-size / 2} ${size} ${size}` });
  const p = svgEl('path', { d: shapePath(shape, size * 0.36) });
  p.style.fill = fill;
  icon.append(p);
  return icon;
}

/**
 * Resolve each node's color/shape (own > inherited > site) and count its downstream pages.
 * Relies on parents appearing before children in `nodes` (true: nodes are created in discovery order).
 */
function resolveStyles(nodes, byId) {
  for (const n of nodes) {
    const own = settings.nodeStyles[nodeKey(n)] || {};
    const parent = n.parent && byId.get(n.parent);
    let inherited = {};
    if (parent) {
      const parentOwn = settings.nodeStyles[nodeKey(parent)] || {};
      inherited = parentOwn.cascade ? { ...parent.inherited, ...parentOwn } : parent.inherited;
    }
    n.inherited = inherited;
    n.styleColor = own.color || inherited.color || siteColor(n.site);
    n.styleShape = own.shape || inherited.shape || siteShape(n.site);
    n.descendants = 0;
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const parent = nodes[i].parent && byId.get(nodes[i].parent);
    if (parent) parent.descendants += 1 + nodes[i].descendants;
  }
}

// =====================================================================
// 4. Building the graph
// =====================================================================

/**
 * Turn the visits in the current time range into nodes and links, applying the site filter
 * and grouping. Visits are replayed in time order; each node remembers the node that first led
 * to it (`parent`), which forms the "discovery tree" used by the tree layouts and downstream styles.
 *
 * @returns {{nodes: object[], links: object[], siteCounts: Map<string, number>, total: number}}
 */
function buildGraph() {
  const inRange = visits.filter((v) => v.t >= rangeStart());
  const group = settings.groupBySite;
  const keyOf = (url) => (group ? siteOf(url) : url);
  const included = (url) => !excluded.has(siteOf(url));

  const counts = new Map();
  const nodes = new Map();
  const links = new Map();
  let order = 0;

  const getNode = (url, parent) => {
    const id = keyOf(url);
    let n = nodes.get(id);
    if (!n) {
      n = { id, site: siteOf(url), url: group ? null : url, ghost: !included(url), parent, order: order++,
        visits: 0, first: Infinity, last: 0, urls: new Map() };
      nodes.set(id, n);
    }
    return n;
  };

  for (const v of inRange) {
    counts.set(siteOf(v.url), (counts.get(siteOf(v.url)) || 0) + 1);
    const toIncluded = included(v.url);
    let target = null;

    if (v.from && keyOf(v.from) !== keyOf(v.url)) {
      const fromIncluded = included(v.from);
      if ((fromIncluded && toIncluded) || (settings.showNeighbors && (fromIncluded || toIncluded))) {
        const source = getNode(v.from, null);
        target = getNode(v.url, source.id);
        const k = source.id + '\u0000' + target.id;
        const link = links.get(k) || { source: source.id, target: target.id, count: 0, newTab: false };
        link.count++;
        if (v.newTab) link.newTab = true;
        links.set(k, link);
      }
    }

    if (toIncluded) {
      const n = target || getNode(v.url, null);
      n.visits++;
      n.first = Math.min(n.first, v.t);
      n.last = Math.max(n.last, v.t);
      n.urls.set(v.url, (n.urls.get(v.url) || 0) + 1);
    } else if (target) {
      target.visits++; // ghost destination: still sized by how often you went there
    }
  }

  // A "tree" link is the one that first discovered its target; the rest are revisits / jumps back.
  for (const l of links.values()) l.tree = nodes.get(l.target).parent === l.source;

  return { nodes: [...nodes.values()], links: [...links.values()], siteCounts: counts, total: inRange.length };
}

// =====================================================================
// 5. Sidebar site list
// =====================================================================

function renderSiteList() {
  const q = $('domainSearch').value.trim().toLowerCase();
  const items = [...siteCounts.entries()].sort((a, b) => b[1] - a[1]).filter(([s]) => !q || s.includes(q));

  $('domainList').replaceChildren(...items.map(([site, count]) => {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !excluded.has(site);
    cb.onchange = () => { cb.checked ? excluded.delete(site) : excluded.add(site); save(); render(); };

    const swatch = button('swatch', null, (e) => {
      e.preventDefault(); e.stopPropagation();
      togglePicker({ kind: 'site', site }, swatch);
    }, 'Change color & shape');
    swatch.append(shapeIcon(siteShape(site), siteColor(site), 14));

    const name = el('span', 'name', site);
    name.title = site;

    const label = el('label');
    label.append(cb, swatch, name, el('span', 'count', count));
    label.addEventListener('click', (e) => { // Option/Alt-click: show only this site
      if (!e.altKey) return;
      e.preventDefault();
      for (const s of siteCounts.keys()) excluded.add(s);
      excluded.delete(site); save(); render();
    });
    const li = el('li');
    li.append(label);
    return li;
  }));

  if (!items.length) $('domainList').append(el('li', 'empty', siteCounts.size ? 'No matching sites' : 'No visits in this range'));
}

// =====================================================================
// 6. Rendering
// =====================================================================

const svg = d3.select('#graph');
const defs = svg.append('defs');
// Fixed-size markers (userSpaceOnUse) so arrowheads stay legible regardless of line width.
defs.append('marker').attr('id', 'newtab') // "opened in a new tab" badge at the start of a link
  .attr('viewBox', '-1 -6 12 12').attr('refX', 0).attr('refY', 0)
  .attr('markerUnits', 'userSpaceOnUse').attr('markerWidth', 13).attr('markerHeight', 13).attr('orient', 'auto')
  .append('path').attr('d', 'M0,-4.5H6L10,-1.5V4.5H0Z');
for (const id of ['arrow', 'arrow-hi']) { // arrowhead (normal / highlighted)
  defs.append('marker').attr('id', id)
    .attr('viewBox', '0 -6 12 12').attr('refX', 11).attr('refY', 0)
    .attr('markerUnits', 'userSpaceOnUse').attr('markerWidth', 13).attr('markerHeight', 13).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5.5L12,0L0,5.5L2.5,0Z');
}

const root = svg.append('g');        // zoom/pan transform is applied here
const gLinks = root.append('g');
const gNodes = root.append('g');
let linkSel = gLinks.selectAll('g.link-edge');
let nodeSel = gNodes.selectAll('g.node');

const zoom = d3.zoom().scaleExtent([0.1, 6]).on('zoom', (e) => root.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
svg.on('click', (e) => { if (e.target === svg.node()) select(null); });

const draggedPos = new Map(); // tree layouts: positions of nodes you dragged
const forcePos = new Map();   // force layout: last positions, so refreshes don't reshuffle

// Force-directed layout: live physics, seeded from the tree layout so it starts organized.
const sim = d3.forceSimulation()
  .force('link', d3.forceLink().id((d) => d.id).distance((l) => 45 + l.source.r + l.target.r).strength(0.5))
  .force('charge', d3.forceManyBody().strength(-260))
  .force('collide', d3.forceCollide().radius((d) => d.r + 14))
  .force('x', d3.forceX().strength(0.03))
  .force('y', d3.forceY().strength(0.03))
  .alphaDecay(0.05) // settles in ~2 s
  .on('tick', () => { for (const n of graph.nodes) forcePos.set(n.id, { x: n.x, y: n.y }); draw(); })
  .stop();

/**
 * Tree layout (also the starting point for force layout): each page sits one step right (lr) or
 * down (td) from the page that first led to it; separate starting points sit alongside each other.
 */
function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxR = d3.max(nodes, (n) => n.r) || 5;
  const td = settings.layout === 'td';
  const breadth = td ? Math.max(200, 2 * maxR + 180) : Math.max(46, 2 * maxR + 28); // between siblings
  const depth = td ? Math.max(60, 2 * maxR + 38) : Math.max(172, 2 * maxR + 135);   // between generations
  const ROOT = '\u0000root';
  const tree = d3.stratify()
    .id((d) => d.id)
    .parentId((d) => (d.id === ROOT ? null : (d.parent && byId.has(d.parent) ? d.parent : ROOT)))([{ id: ROOT, order: -1 }, ...nodes]);
  tree.sort((a, b) => a.data.order - b.data.order);
  d3.tree().nodeSize([breadth, depth]).separation((a, b) => (a.parent === b.parent ? 1 : (td ? 1.15 : 1.4)))(tree);
  tree.each((d) => {
    if (d.data.id === ROOT) return;
    const n = d.data;
    const saved = settings.layout === 'force' ? forcePos.get(n.id) : draggedPos.get(n.id);
    n.x = saved ? saved.x : (td ? d.x : (d.depth - 1) * depth);
    n.y = saved ? saved.y : (td ? (d.depth - 1) * depth : d.x);
  });
}

/**
 * Rebuild and redraw the graph from current data and settings.
 * @param {{fit?: boolean}} opts fit (default true): reset layout and zoom to fit; false keeps positions & zoom.
 */
function render({ fit: fitView = true } = {}) {
  if (fitView) { draggedPos.clear(); forcePos.clear(); }
  const force = settings.layout === 'force';
  const built = buildGraph();
  siteCounts = built.siteCounts;
  renderSiteList();

  const { nodes, links } = built;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) { l.source = byId.get(l.source); l.target = byId.get(l.target); }
  graph = { nodes, links };

  const rScale = d3.scaleSqrt().domain([0, d3.max(nodes, (n) => n.visits) || 1]).range([6, settings.groupBySite ? 26 : 16]);
  for (const n of nodes) n.r = rScale(n.visits);
  const hasNewNodes = force && nodes.some((n) => !forcePos.has(n.id));
  layout(nodes);
  resolveStyles(nodes, byId);

  // Links
  const wScale = d3.scaleLinear().domain([1, Math.max(2, d3.max(links, (l) => l.count) || 1)]).range([2, 6]);
  linkSel = gLinks.selectAll('g.link-edge').data(links, (l) => l.source.id + '>' + l.target.id).join((enter) => {
    const g = enter.append('g').attr('class', 'link-edge');
    g.append('path').attr('class', 'edge');
    g.append('title');
    return g;
  });
  linkSel.classed('back', (l) => !l.tree);
  linkSel.select('path.edge')
    .attr('stroke-width', (l) => wScale(l.count))
    .attr('marker-end', 'url(#arrow)')
    .attr('marker-start', (l) => (l.newTab ? 'url(#newtab)' : null));
  linkSel.select('title').text((l) => `${labelOf(l.source)}  →  ${labelOf(l.target)}` +
    (l.count > 1 ? `  (×${l.count})` : '') + (l.newTab ? '\n(opened in a new tab)' : '') + (l.tree ? '' : '\n(revisit / jump back)'));

  // Nodes
  nodeSel = gNodes.selectAll('g.node').data(nodes, (n) => n.id).join((enter) => {
    const g = enter.append('g').attr('class', 'node');
    g.append('path').attr('class', 'shape');
    g.append('text');
    g.append('circle').attr('class', 'note-dot').attr('r', 4);
    g.append('title');
    return g;
  });
  nodeSel.classed('ghost', (d) => d.ghost)
    .call(nodeDrag)
    .on('click', (e, d) => { e.stopPropagation(); select(d.id); })
    .on('dblclick', (e, d) => { e.stopPropagation(); window.open(d.url || 'https://' + d.site, '_blank', 'noopener'); });
  nodeSel.select('path.shape').attr('d', (d) => shapePath(d.styleShape, d.r)).attr('fill', (d) => d.styleColor);
  const td = settings.layout === 'td'; // top-down: labels to the right (links leave from the bottom)
  nodeSel.select('text')
    .attr('text-anchor', td ? 'start' : 'middle')
    .attr('x', (d) => (td ? d.r + 5 : 0))
    .attr('y', (d) => (td ? 4 : d.r + 13))
    .text((d) => (settings.showLabels ? trunc(labelOf(d), settings.layout === 'lr' ? 24 : 30) : ''));
  updateNoteMarks();

  // Force layout: pre-settle off-screen so it doesn't fly around, then let it finish live.
  sim.stop();
  if (force) {
    sim.nodes(nodes);
    sim.force('link').links(links);
    if (fitView) { sim.alpha(1); for (let i = 0; i < 120; i++) sim.tick(); }
    for (const n of nodes) forcePos.set(n.id, { x: n.x, y: n.y });
  }
  draw();
  if (fitView) fit();
  if (force && (fitView || hasNewNodes)) sim.alpha(fitView ? 0.3 : 0.15).restart();

  $('legendFlow').textContent = { lr: 'Flows left → right', td: 'Flows top → down', force: 'Force-directed' }[settings.layout];
  $('empty').hidden = nodes.length > 0;
  $('stats').textContent = `${plural(nodes.filter((n) => !n.ghost).length, settings.groupBySite ? 'site' : 'page')} · ` +
    `${plural(links.length, 'link')} · ${plural(built.total, 'visit')} in range`;
  select(selected && byId.has(selected) ? selected : null);
}

/** Dragging: tree layouts move the node; force layout pins it while dragging so neighbors follow. */
const nodeDrag = d3.drag()
  .on('start', (e, d) => {
    if (settings.layout !== 'force') return;
    if (!e.active) sim.alphaTarget(0.25).restart();
    d.fx = d.x; d.fy = d.y;
  })
  .on('drag', (e, d) => {
    if (settings.layout === 'force') { d.fx = e.x; d.fy = e.y; return; }
    d.x = e.x; d.y = e.y;
    draggedPos.set(d.id, { x: d.x, y: d.y });
    draw();
  })
  .on('end', (e, d) => {
    if (settings.layout !== 'force') return;
    if (!e.active) sim.alphaTarget(0);
    d.fx = null; d.fy = null;
  });

/** Note markers and node tooltips (title, URL, visits, note preview). */
function updateNoteMarks() {
  nodeSel.classed('has-note', (d) => notes.has(nodeKey(d)));
  nodeSel.select('circle.note-dot').attr('cx', (d) => d.r * 0.8).attr('cy', (d) => -d.r * 0.8);
  nodeSel.select('title').text((d) => {
    const note = notes.get(nodeKey(d));
    return (d.url ? titleOf(d.url) + '\n' + d.url : d.id) + '\n' + plural(d.visits, 'visit') +
      (note ? '\n\n📝 ' + trunc(note.text, 200) : '');
  });
}

/**
 * Link geometry as a cubic Bézier, trimmed to the node edges.
 * Forward links in the tree layouts are S-curves along the flow; backward / same-level links arc
 * around; in force layout every link is a gentle arc so A→B and B→A don't overlap.
 */
function linkCurve(l) {
  const s = l.source, t = l.target, mode = settings.layout;
  let p0 = [s.x, s.y], p3 = [t.x, t.y], c1, c2;
  if (mode === 'lr' && t.x - s.x > 1) {
    const mx = (s.x + t.x) / 2;
    c1 = [mx, s.y]; c2 = [mx, t.y];
  } else if (mode === 'td' && t.y - s.y > 1) {
    const my = (s.y + t.y) / 2;
    c1 = [s.x, my]; c2 = [t.x, my];
  } else {
    const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
    const bend = mode === 'force' ? len * 0.15 : Math.max(45, len * 0.4);
    const q = [(s.x + t.x) / 2 - (dy / len) * bend, (s.y + t.y) / 2 + (dx / len) * bend]; // quadratic control point
    c1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
    c2 = [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])];
  }
  const trim = (p, c, r) => { const dx = c[0] - p[0], dy = c[1] - p[1], L = Math.hypot(dx, dy) || 1; return [p[0] + (dx / L) * r, p[1] + (dy / L) * r]; };
  p0 = trim(p0, c1, s.r + 1);
  p3 = trim(p3, c2, t.r + 2);
  return `M${p0}C${c1} ${c2} ${p3}`;
}

/** Position nodes and links (called on render, drag and every force tick). */
function draw() {
  nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
  linkSel.each(function (l) { this.firstChild.setAttribute('d', linkCurve(l)); });
}

/** Zoom to fit the whole graph, leaving room for labels and the legend. */
function fit() {
  const nodes = graph.nodes;
  if (!nodes.length) return;
  const { width, height } = svg.node().getBoundingClientRect();
  const td = settings.layout === 'td';
  const x0 = d3.min(nodes, (n) => n.x) - (td ? 30 : 95), x1 = d3.max(nodes, (n) => n.x) + (td ? 200 : 95);
  const y0 = d3.min(nodes, (n) => n.y - n.r) - 30, y1 = d3.max(nodes, (n) => n.y + n.r) + 40;
  const legendH = ($('legend').offsetHeight || 0) + 16;
  let k = Math.min(1.3, width / (x1 - x0), (height - legendH) / (y1 - y0));
  let t;
  if (k < 0.4) { // very large graph: keep text readable and start at the top-left
    k = 0.4;
    t = d3.zoomIdentity.translate(20 - x0 * k, 20 - y0 * k).scale(k);
  } else {
    t = d3.zoomIdentity.translate((width - (x1 - x0) * k) / 2 - x0 * k, (height - legendH - (y1 - y0) * k) / 2 - y0 * k).scale(k);
  }
  svg.call(zoom.transform, t);
}

const zoomBy = (k) => svg.transition().duration(200).call(zoom.scaleBy, k);

// =====================================================================
// 7. Detail panel
// =====================================================================

/** Select a node (highlight it and its neighbors, show details), or pass null to clear. */
function select(id) {
  if (id !== selected) closePicker();
  selected = id;
  const panel = $('detail');
  const n = id && graph.nodes.find((x) => x.id === id);

  if (!n) {
    selected = null;
    nodeSel.classed('dim', false).classed('sel', false);
    linkSel.classed('dim', false).classed('hi', false).select('path.edge').attr('marker-end', 'url(#arrow)');
    panel.hidden = true;
    return;
  }

  const near = new Set([id]), incoming = [], outgoing = [];
  for (const l of graph.links) {
    if (l.source.id === id) { near.add(l.target.id); outgoing.push(l); }
    if (l.target.id === id) { near.add(l.source.id); incoming.push(l); }
  }
  const touches = (l) => l.source.id === id || l.target.id === id;
  nodeSel.classed('dim', (d) => !near.has(d.id)).classed('sel', (d) => d.id === id);
  linkSel.classed('dim', (l) => !touches(l)).classed('hi', touches)
    .select('path.edge').attr('marker-end', (l) => (touches(l) ? 'url(#arrow-hi)' : 'url(#arrow)'));

  // Don't rebuild the panel while you're typing in it (auto-refresh re-selects).
  if (panel.dataset.id === id && !panel.hidden && panel.contains(document.activeElement)) return;
  panel.dataset.id = id;
  panel.replaceChildren();

  const name = labelOf(n);
  panel.append(button('close-btn', '×', () => select(null), 'Close'), el('h3', null, name));
  if (n.url) panel.append(externalLink(n.url, n.url, 'url'));

  // Style buttons
  const pageBtn = button('btn style-btn', n.url ? ' Style this page…' : ' Style this node…');
  pageBtn.prepend(shapeIcon(n.styleShape, n.ghost ? 'var(--ghost)' : n.styleColor, 12));
  pageBtn.onclick = (e) => { e.stopPropagation(); togglePicker({ kind: 'node', key: nodeKey(n), name }, pageBtn); };
  const siteBtn = button('btn style-btn', ` Style ${n.site}…`);
  siteBtn.prepend(shapeIcon(siteShape(n.site), siteColor(n.site), 12));
  siteBtn.onclick = (e) => { e.stopPropagation(); togglePicker({ kind: 'site', site: n.site }, siteBtn); };
  const styleRow = el('div', 'style-row');
  styleRow.append(pageBtn, siteBtn);
  panel.append(styleRow);

  panel.append(el('div', 'meta', n.visits
    ? plural(n.visits, 'visit') + (n.first < Infinity ? ` · first ${fmtTime(n.first)} · last ${fmtTime(n.last)}` : '')
    : 'Linked page (outside filter or range)'));

  panel.append(...notesEditor(n));

  const linkList = (title, list, other) => {
    if (!list.length) return;
    panel.append(el('h4', null, title));
    const ul = el('ul');
    for (const l of list.sort((a, b) => b.count - a.count).slice(0, 25)) {
      const o = other(l);
      const a = el('a', null, trunc(labelOf(o), 60));
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); select(o.id); };
      const li = el('li');
      li.append(a, (l.count > 1 ? ` ×${l.count}` : '') + (l.newTab ? ' · new tab' : ''));
      ul.append(li);
    }
    panel.append(ul);
  };
  linkList('Came from', incoming, (l) => l.source);
  linkList('Went to', outgoing, (l) => l.target);

  if (!n.url && n.urls.size) { // grouped view: list the site's pages
    panel.append(el('h4', null, 'Pages on this site'));
    const ul = el('ul');
    for (const [u, c] of [...n.urls].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      const li = el('li');
      li.append(externalLink(u, trunc(titleOf(u), 60)), c > 1 ? ` ×${c}` : '');
      ul.append(li);
    }
    panel.append(ul);
  }
  panel.hidden = false;
}

/** Notes heading, textarea (autosaves 0.5 s after typing stops) and status line for a node. */
function notesEditor(n) {
  const id = nodeKey(n);
  const ta = el('textarea', 'notes');
  ta.rows = 4;
  ta.placeholder = 'Why you were here, what to follow up on…';
  ta.value = notes.get(id)?.text || '';
  const status = el('div', 'note-status', notes.get(id) ? `Saved ${fmtTime(notes.get(id).updated)}` : '');
  let timer;
  const saveNote = async () => {
    clearTimeout(timer);
    const text = ta.value;
    await HMDB.setNote(id, text);
    if (text.trim()) notes.set(id, { id, text, updated: Date.now() }); else notes.delete(id);
    status.textContent = text.trim() ? 'Saved' : '';
    updateNoteMarks();
  };
  ta.addEventListener('input', () => { status.textContent = 'Editing…'; clearTimeout(timer); timer = setTimeout(saveNote, 500); });
  ta.addEventListener('blur', () => { if (status.textContent === 'Editing…') saveNote(); });
  return [el('h4', null, n.url ? 'Notes' : `Notes for ${n.id}`), ta, status];
}

// =====================================================================
// 8. Style picker
// =====================================================================
// Target: { kind: 'site', site } or { kind: 'node', key, name }.

const picker = el('div', 'popover');
picker.id = 'picker';
picker.hidden = true;
document.body.append(picker);
let pickerTarget = null;

const targetId = (t) => t.kind + ':' + (t.site || t.key);
const styleStore = (t) => (t.kind === 'site' ? settings.styles : settings.nodeStyles);
const styleKey = (t) => (t.kind === 'site' ? t.site : t.key);

function setStyle(t, patch) {
  const store = styleStore(t), key = styleKey(t);
  if (patch === null) delete store[key]; else store[key] = { ...(store[key] || {}), ...patch };
  save();
  render({ fit: false });
}

function currentStyle(t) {
  if (t.kind === 'site') return { color: siteColor(t.site), shape: siteShape(t.site) };
  const n = graph.nodes.find((x) => nodeKey(x) === t.key);
  return { color: n?.styleColor || PALETTE[0], shape: n?.styleShape || settings.shape, descendants: n?.descendants || 0 };
}

/** Open the picker for a target, anchored below `anchor` (pass null to keep the current position). */
function openPicker(t, anchor) {
  pickerTarget = t;
  const own = styleStore(t)[styleKey(t)] || {};
  const cur = currentStyle(t);
  const update = (patch) => { setStyle(t, patch); openPicker(t, null); };

  picker.replaceChildren(
    button('close-btn', '×', closePicker, 'Close (Esc)'),
    el('div', 'p-kind', t.kind === 'site' ? 'Whole site' : 'This page'),
    el('div', 'p-title', t.kind === 'site' ? t.site : t.name),
    el('div', 'p-label', 'Color'),
  );

  const colors = el('div', 'p-colors');
  for (const c of PALETTE) {
    const b = button('p-color' + (c.toLowerCase() === cur.color.toLowerCase() ? ' on' : ''), null, () => update({ color: c }), c);
    b.style.background = c;
    colors.append(b);
  }
  const custom = el('input', 'p-custom');
  custom.type = 'color';
  custom.value = cur.color;
  custom.title = 'Custom color';
  custom.oninput = () => setStyle(t, { color: custom.value }); // live preview; picker stays open
  colors.append(custom);

  const shapes = el('div', 'p-shapes');
  for (const [k, name] of Object.entries(SHAPES)) {
    const b = button('btn p-shape' + (k === cur.shape ? ' on' : ''), null, () => update({ shape: k }), name);
    b.append(shapeIcon(k, cur.color, 18));
    shapes.append(b);
  }
  picker.append(colors, el('div', 'p-label', 'Shape'), shapes);

  if (t.kind === 'node') {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!own.cascade;
    cb.onchange = () => update({ cascade: cb.checked });
    const label = el('label', 'p-cascade');
    label.append(cb, ` Also apply downstream (${plural(cur.descendants, 'page')})`);
    picker.append(label);
  }
  picker.append(button('link', t.kind === 'site' ? 'Reset site to default' : 'Clear this page’s style', () => update(null)));

  picker.hidden = false;
  if (anchor?.isConnected) {
    const r = anchor.getBoundingClientRect();
    picker.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - picker.offsetHeight - 8)) + 'px';
    picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - picker.offsetWidth - 8)) + 'px';
  }
}

function closePicker() { picker.hidden = true; pickerTarget = null; }
function togglePicker(t, anchor) {
  if (pickerTarget && targetId(pickerTarget) === targetId(t) && !picker.hidden) closePicker(); else openPicker(t, anchor);
}

// =====================================================================
// 9. Image export (SVG / PNG / print-to-PDF)
// =====================================================================
// Builds a standalone SVG of the whole graph: light theme, styles inlined (no CSS variables),
// plus a title line and legend so it reads on its own in a document.

const EXPORT_STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'opacity', 'display', 'font-family', 'font-size', 'font-weight', 'paint-order', 'visibility'];

/** Copy computed styles from a live subtree onto its clone, so the clone renders without our CSS. */
function inlineStyles(src, dst) {
  const a = [src, ...src.querySelectorAll('*')], b = [dst, ...dst.querySelectorAll('*')];
  for (let i = 0; i < a.length; i++) {
    const cs = getComputedStyle(a[i]);
    b[i].setAttribute('style', EXPORT_STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    b[i].removeAttribute('class');
  }
}

/** @returns {SVGSVGElement|null} a self-contained SVG of the current graph, or null if it's empty */
function buildExportSVG() {
  if (!graph.nodes.length) return null;
  const prevSelected = selected;
  if (prevSelected) select(null); // export the whole graph, not a highlighted selection
  document.documentElement.classList.add('force-light');
  try {
    const bb = root.node().getBBox();
    const pad = 28, headerH = 44, legendH = 34;
    const W = Math.ceil(Math.max(bb.width + pad * 2, 560));
    const H = Math.ceil(bb.height + pad * 2 + headerH + legendH);
    const out = svgEl('svg', { xmlns: SVG_NS, width: W, height: H, viewBox: `0 0 ${W} ${H}`,
      'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' });
    out.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }));

    // Markers, renamed so they can't clash with the live map's ids while printing.
    const defsClone = defs.node().cloneNode(true);
    inlineStyles(defs.node(), defsClone);
    for (const m of defsClone.querySelectorAll('marker')) m.id = 'x-' + m.id;
    out.append(defsClone);

    // Title line
    const shown = graph.nodes.filter((n) => !n.ghost).length;
    const hidden = [...siteCounts.keys()].filter((s) => excluded.has(s));
    const date = new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    out.append(svgEl('text', { x: pad, y: 26, 'font-size': 15, 'font-weight': 600, fill: '#1c1c1e' }, 'History Map'));
    out.append(svgEl('text', { x: pad + 98, y: 26, 'font-size': 12, fill: '#6b6b70' },
      `${RANGE_LABEL[settings.range]} · ${date} · ${plural(shown, settings.groupBySite ? 'site' : 'page')}, ${plural(graph.links.length, 'link')}` +
      (hidden.length ? ` · hidden: ${hidden.slice(0, 4).join(', ')}${hidden.length > 4 ? '…' : ''}` : '')));

    // The graph
    const g = root.node().cloneNode(true);
    inlineStyles(root.node(), g);
    g.setAttribute('transform', `translate(${pad - bb.x},${pad + headerH - bb.y})`);
    for (const p of g.querySelectorAll('[marker-end],[marker-start]')) {
      for (const attr of ['marker-end', 'marker-start']) {
        const v = p.getAttribute(attr);
        if (v) p.setAttribute(attr, v.replace('url(#', 'url(#x-'));
      }
    }
    out.append(g);

    // Legend
    const edge = getComputedStyle(document.documentElement).getPropertyValue('--edge').trim() || '#888';
    let lx = pad;
    const legendItem = (dashed, tabBadge, text) => {
      const item = svgEl('g', { transform: `translate(${lx},${H - 16})` });
      item.append(svgEl('path', { d: `M${tabBadge ? 8 : 0} 0H30`, stroke: edge, 'stroke-width': 2, fill: 'none',
        'stroke-dasharray': dashed ? '6 5' : 'none', 'marker-end': 'url(#x-arrow)' }));
      if (tabBadge) item.append(svgEl('path', { d: 'M0,-4H6L9,-1.5V4H0Z', fill: '#fff', stroke: edge, 'stroke-width': 1.4 }));
      item.append(svgEl('text', { x: 40, y: 4, 'font-size': 11, fill: '#6b6b70' }, text));
      out.append(item);
      lx += 40 + text.length * 6.2 + 22;
    };
    legendItem(false, false, 'first time you reached a page');
    legendItem(true, false, 'revisit / jump back');
    if (graph.links.some((l) => l.newTab)) legendItem(false, true, 'opened in a new tab');
    return out;
  } finally {
    document.documentElement.classList.remove('force-light');
    if (prevSelected) select(prevSelected);
  }
}

const serializeSVG = (s) => '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(s);

async function exportImage(format) {
  const s = buildExportSVG();
  if (!s) { alert('Nothing to export — the map is empty for this time range and filter.'); return; }
  const W = +s.getAttribute('width'), H = +s.getAttribute('height');

  if (format === 'svg') {
    download(new Blob([serializeSVG(s)], { type: 'image/svg+xml' }), datedName('svg'));
  } else if (format === 'png') {
    const scale = Math.max(1, Math.min(2, 8000 / Math.max(W, H))); // 2×, capped for very large graphs
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serializeSVG(s));
    await img.decode();
    const canvas = el('canvas');
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, W, H);
    canvas.toBlob((b) => (b ? download(b, datedName('png')) : alert('PNG export failed — try SVG instead.')), 'image/png');
  } else if (format === 'pdf') {
    // Print just the export SVG, fitted to one page; the browser's print dialog saves it as PDF.
    s.removeAttribute('width');
    s.removeAttribute('height');
    s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    let pageStyle = $('printPageStyle');
    if (!pageStyle) { pageStyle = el('style'); pageStyle.id = 'printPageStyle'; document.head.append(pageStyle); }
    pageStyle.textContent = `@page { size: ${W >= H ? 'landscape' : 'portrait'}; margin: 10mm; }`;
    $('printSheet').replaceChildren(s);
    requestAnimationFrame(() => window.print());
  }
}
window.addEventListener('afterprint', () => $('printSheet').replaceChildren());

function setExportMenu(open) {
  $('exportMenu').hidden = !open;
  $('exportBtn').setAttribute('aria-expanded', String(open));
}

// =====================================================================
// 10. Data export / import / clear
// =====================================================================

async function exportData() {
  const data = {
    app: 'History Map',
    exportedAt: new Date().toISOString(),
    visits: await HMDB.getVisits(0),
    pages: [...(await HMDB.getPages()).values()],
    notes: [...(await HMDB.getNotes()).values()],
    styles: { sites: settings.styles, nodes: settings.nodeStyles, defaultShape: settings.shape },
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), datedName('json'));
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    await HMDB.importData(data);
    if (data.styles) {
      Object.assign(settings.styles, data.styles.sites || {});
      Object.assign(settings.nodeStyles, data.styles.nodes || {});
      save();
    }
    await load();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}

async function clearAll() {
  if (!confirm('Delete all recorded history and notes from History Map? Export first if you want a copy.')) return;
  await HMDB.clear();
  selected = null;
  await load();
}

// =====================================================================
// 11. Controls, keyboard, live refresh, start-up
// =====================================================================

/** Show or hide the options sidebar. Keeps the current zoom. */
function setSidebar(open, persist = true) {
  settings.sidebar = open;
  document.body.classList.toggle('sidebar-collapsed', !open);
  const label = open ? 'Hide options' : 'Show options';
  $('sideToggle').setAttribute('aria-expanded', String(open));
  $('sideToggle').setAttribute('aria-label', label);
  $('sideToggle').title = `${label} ([)`;
  if (!open) closePicker();
  if (persist) save();
}

/** Bind a sidebar control to a setting. `refit`: whether changing it resets the layout and zoom. */
function bindSetting(id, key, refit = true) {
  const input = $(id);
  const prop = input.type === 'checkbox' ? 'checked' : 'value';
  input[prop] = settings[key];
  input.onchange = () => {
    settings[key] = input[prop];
    if (key === 'groupBySite') selected = null;
    save();
    render({ fit: refit });
  };
}

async function load() {
  [visits, pages, notes] = await Promise.all([HMDB.getVisits(0), HMDB.getPages(), HMDB.getNotes()]);
  lastVisitCount = visits.length;
  render();
}

/** Pick up new browsing while the map is open, without moving things around. */
async function refreshIfChanged() {
  if (document.hidden) return;
  const count = await HMDB.countVisits();
  if (count === lastVisitCount) return;
  [visits, pages, notes] = await Promise.all([HMDB.getVisits(0), HMDB.getPages(), HMDB.getNotes()]);
  lastVisitCount = visits.length;
  render({ fit: false });
}

function init() {
  for (const [k, name] of Object.entries(SHAPES)) $('defaultShape').append(new Option(name, k));
  bindSetting('range', 'range');
  bindSetting('layoutMode', 'layout');
  bindSetting('defaultShape', 'shape', false);
  bindSetting('groupBySite', 'groupBySite');
  bindSetting('showNeighbors', 'showNeighbors');
  bindSetting('showLabels', 'showLabels', false);

  $('domainSearch').oninput = renderSiteList;
  $('selAll').onclick = () => { excluded.clear(); save(); render(); };
  $('selNone').onclick = () => { for (const s of siteCounts.keys()) excluded.add(s); save(); render(); };

  $('refresh').onclick = load;
  $('relayout').onclick = () => render();
  $('exportData').onclick = exportData;
  $('importData').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => { if (e.target.files[0]) await importData(e.target.files[0]); e.target.value = ''; };
  $('clearAll').onclick = clearAll;

  setSidebar(settings.sidebar !== false, false);
  $('sideToggle').onclick = () => setSidebar(!settings.sidebar);
  $('zoomIn').onclick = () => zoomBy(1.4);
  $('zoomOut').onclick = () => zoomBy(1 / 1.4);
  $('zoomFit').onclick = fit;
  $('exportBtn').onclick = (e) => { e.stopPropagation(); setExportMenu($('exportMenu').hidden); };
  $('exportMenu').onclick = (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    setExportMenu(false);
    exportImage(b.dataset.fmt).catch((err) => alert('Export failed: ' + err.message));
  };

  // Close popovers on outside click. Capture phase, because the map's pan/zoom stops mousedown bubbling.
  document.addEventListener('pointerdown', (e) => {
    if (!picker.hidden && !picker.contains(e.target) && !e.target.closest('.swatch, .style-btn')) closePicker();
    if (!e.target.closest('#exportCtl')) setExportMenu(false);
  }, true);

  // Keyboard: Esc closes popovers; + − 0 zoom; [ toggles the sidebar (ignored while typing).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.activeElement?.tagName === 'TEXTAREA') return; // don't close things mid-note
      closePicker();
      setExportMenu(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
    else if (e.key === '0') fit();
    else if (e.key === '[') setSidebar(!settings.sidebar);
  });

  setInterval(refreshIfChanged, 10000);
  load();
}

init();

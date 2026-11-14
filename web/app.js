import { call, describe, watch, upload, toBase64, previewBlob, rawPreviewUrl, formatBytes, parentOf } from './api.js';
import { t, language } from './locale.js';
import { icon, fileIcon } from './icons.js';
import { readView, writeView, pathSegments, normalizePathInput, selectionFor, selectionSummary, pathsForDrop, shortcutAction } from './view-state.js';
import { renderMarkdown } from './markdown.js';
import { highlightInto, languageForName } from './highlight.js';
import { createQuickSearch } from './quick-search.js';
import { createSidebar } from './sidebar.js';

const $ = id => document.getElementById(id);
const state = { path: '', parent: '', entries: [], selected: new Set(), anchor: -1, focus: -1, roots: [], query: '', sortBy: 'name', sortDir: 'asc', view: 'grid', size: 'medium', theme: 'system', previewOpen: false, platform: 'darwin', hasMore: false, loading: false, busy: false, history: [], historyIndex: -1, request: 0, previewRequest: 0, preview: null, info: null, clipboard: null, error: null, pendingEdit: null };
let listController, previewController, stopWatch, refreshTimer, uploadController, objectUrl, sidebar, quickSearch, lightbox;
let disposed = false;
/** Single source of truth for toolbar buttons and context-menu items. */
const actions = {};
const action = (id, fn) => { actions[id] = fn; return fn; };
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action, className = 'button') {
  const node = element('button', t(label), className); node.type = 'button'; node.addEventListener('click', action); return node;
}
function notice(text, error = false) {
  $('notice-text').textContent = text; $('notice').hidden = false; $('notice').classList.toggle('error', error);
}
function report(error) { if (error?.name !== 'AbortError') notice(t('failed', { message: error?.message ?? error }), true); }
const selected = () => state.entries.filter(entry => state.selected.has(entry.path));
const writable = () => state.info?.security.allowWrite === true;
const system = () => state.info?.backendCapabilities?.osIntegration === true;
const dirty = () => state.preview?.editing && state.preview.draft !== state.preview.result.content;
function date(value) { return value ? new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
/** Fanbox-style relative labels keep scan-friendly recency in the list. */
function relTime(value) {
  if (!value) return '—';
  const minutes = Math.floor((Date.now() - value) / 60000);
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('daysAgo', { count: days });
  return date(value);
}
function fileExtension(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
const THUMB_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const thumbable = entry => entry.kind === 'image' && !entry.isDir && THUMB_EXTENSIONS.has(fileExtension(entry.name));
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);
const isMarkdownName = name => MARKDOWN_EXTENSIONS.has(fileExtension(name));
const isTableName = name => TABLE_EXTENSIONS.has(fileExtension(name));
const isHtmlName = name => ['html', 'htm'].includes(fileExtension(name));
const rootLabel = path => state.roots.find(root => root.path === path)?.label ?? String(path ?? '').split(/[/\\]/).filter(Boolean).at(-1) ?? t('title');

/** Join a directory and a child name without assuming a platform separator. */
function joinPath(dir, name) {
  const clean = String(dir ?? '');
  return /[\\/]$/.test(clean) ? `${clean}${name}` : `${clean}/${name}`;
}

/** Resolve a markdown/HTML reference against the document's folder. */
function resolveRelativePath(base, src) {
  const clean = String(src).replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(clean) || clean.startsWith('//')) return clean;
  if (clean.startsWith('/')) return clean;
  const parts = [];
  for (const segment of String(base ?? '').replaceAll('\\', '/').split('/')) if (segment) parts.push(segment);
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return (String(base ?? '').startsWith('/') ? '/' : '') + parts.join('/');
}

function ask({ title, copy = '', label, value = '', submit = 'create', danger = false }) {
  if ($('dialog').open) return Promise.resolve(null);
  $('dialog-title').textContent = t(title); $('dialog-copy').textContent = copy;
  $('dialog-copy').hidden = !copy; $('dialog-label').textContent = label ? t(label) : '';
  $('dialog-label').hidden = !label; $('dialog-input').hidden = !label;
  $('dialog-input').required = Boolean(label); $('dialog-input').value = value;
  $('dialog-submit').textContent = t(submit); $('dialog-submit').classList.toggle('destructive', danger);
  return new Promise(resolve => {
    let answer = null;
    const submitForm = event => { event.preventDefault(); answer = label ? $('dialog-input').value : true; $('dialog').close(); };
    const cancel = () => $('dialog').close();
    const close = () => {
      $('dialog-form').removeEventListener('submit', submitForm); $('dialog-cancel').removeEventListener('click', cancel);
      resolve(answer);
    };
    $('dialog-form').addEventListener('submit', submitForm); $('dialog-cancel').addEventListener('click', cancel);
    $('dialog').addEventListener('close', close, { once: true }); $('dialog').showModal();
    (danger || !label ? $('dialog-cancel') : $('dialog-input')).focus();
    if (label && !danger) $('dialog-input').select();
  });
}
async function leaveDraft() {
  if (!dirty()) return true;
  return Boolean(await ask({ title: 'unsaved', copy: t('unsavedHint'), submit: 'discard', danger: true }));
}

function actionDisabled() {
  const count = state.selected.size, one = selected()[0], busy = state.busy || state.loading;
  return {
    'new-folder': !writable() || busy, 'new-file': !writable() || busy, upload: !writable() || busy,
    copy: !count || busy, cut: !count || !writable() || busy, paste: !state.clipboard || !writable() || busy,
    rename: count !== 1 || !writable() || busy, trash: !count || !writable() || !system() || busy,
    duplicate: !count || !writable() || busy, zip: !count || !writable() || !system() || busy,
    extract: count !== 1 || one?.kind !== 'archive' || !writable() || !system() || busy,
    open: count !== 1 || !one?.isDir && !system() || busy, reveal: count !== 1 || !system() || busy, 'copy-path': count !== 1 || busy,
    editor: count !== 1 || !system() || busy, 'open-trash': !system() || busy,
    back: state.historyIndex <= 0 || busy, forward: state.historyIndex >= state.history.length - 1 || busy,
    up: !state.path || state.path === state.parent || busy, refresh: !state.path || busy,
    'load-more': busy,
    favorite: count !== 1 || !one?.isDir || busy,
    'disk-usage': !state.path || busy,
    // Context-menu-only actions have no toolbar button. Do not reuse `preview`:
    // that id belongs to the preview pane itself.
    'show-preview': busy,
    'select-all': busy || !state.entries.length,
    'edit-text': count !== 1 || one?.kind !== 'text' || !writable() || busy,
  };
}
function controls() {
  const count = state.selected.size, one = selected()[0], busy = state.busy || state.loading;
  for (const [id, value] of Object.entries(actionDisabled())) {
    const node = $(id);
    if (node) node.disabled = value;
  }
  $('open').textContent = t(one?.isDir ? 'openFolder' : 'open');
  $('rows').setAttribute('aria-disabled', String(busy));
  // Closing the preview is a pure UI action: never block it on a file operation.
  const summary = selectionSummary(selected());
  $('selection-count').textContent = count
    ? summary.files ? t('selected', { count, size: formatBytes(summary.size) }) : t('selected', { count, size: '—' })
    : '';
  $('path').disabled = state.busy; $('search').disabled = state.busy;
  $('clipboard-status').textContent = state.clipboard ? t('clipboard', { count: state.clipboard.paths.length, action: t(state.clipboard.kind === 'copy' ? 'copyVerb' : 'moveVerb') }) : '';
  sidebar?.update(state.path, state.busy);
}

/** Fanbox-style project badges: short tags on folder cards. */
const BADGE_LABELS = { node: 'node', web: 'web', python: 'py', rust: 'rs', go: 'go', git: 'git' };
function badgeNode(entry) {
  const badge = element('span', BADGE_LABELS[entry.projectBadge] ?? entry.projectBadge, `badge badge-${entry.projectBadge}`);
  badge.title = t('badgeTitle', { kind: entry.projectBadge });
  return badge;
}

/** Stable fingerprint so unchanged rows keep their (possibly decoded) nodes. */
function entrySig(entry) {
  return [entry.name, entry.kind, entry.isDir ? 1 : 0, entry.mtime, entry.size, entry.projectBadge ?? '', state.query ? entry.dirHint ?? '' : '', state.view].join('|');
}

function buildRow(entry) {
  const row = element('div', undefined, 'entry');
  row.dataset.path = entry.path;
  row.dataset.sig = entrySig(entry);
  const primary = element('div', undefined, 'entry-primary'), artwork = element('span', undefined, 'icon-wrap');
  if (thumbable(entry)) {
    const thumb = element('img', undefined, 'entry-thumb');
    thumb.src = rawPreviewUrl(entry.path); thumb.loading = 'lazy'; thumb.decoding = 'async';
    thumb.alt = ''; thumb.draggable = false;
    artwork.append(thumb);
  } else artwork.append(fileIcon(entry));
  const copy = element('div', undefined, 'entry-copy');
  copy.append(element('span', entry.name, 'entry-name'));
  if (entry.projectBadge) copy.append(badgeNode(entry));
  if (state.query) copy.append(element('small', entry.dirHint, 'entry-location'));
  primary.append(artwork, copy);
  row.append(primary, element('span', relTime(entry.mtime), 'entry-meta entry-date'), element('span', entry.isDir ? state.view === 'grid' ? t('dir') : '—' : formatBytes(entry.size), 'entry-meta entry-size'), element('span', t(entry.kind), 'entry-meta entry-kind'));
  // Keyed reuse keeps these listeners across re-renders, so look the row up
  // by path: the closure entry may be a stale object after a reload.
  const rowIndex = () => state.entries.findIndex(item => item.path === entry.path);
  row.addEventListener('click', event => { event.stopPropagation(); void selectEntry(rowIndex(), event); });
  row.addEventListener('dblclick', () => void activate(state.entries[rowIndex()] ?? entry));
  row.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); void contextMenu(event, rowIndex()); });
  // Internal drag: move onto a folder (Alt = copy). Read-only hosts stay inert.
  row.draggable = writable();
  row.addEventListener('dragstart', event => {
    if (!writable()) { event.preventDefault(); return; }
    const paths = state.selected.has(entry.path) ? selected().map(item => item.path) : [entry.path];
    event.dataTransfer.setData('application/x-dsh-files', JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'copyMove';
  });
  row.addEventListener('dragend', clearDropHints);
  if (entry.isDir) {
    row.addEventListener('dragover', event => {
      if (![...event.dataTransfer.types].includes('application/x-dsh-files') || !writable() || state.busy) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
      if (!row.classList.contains('drop-into')) { clearDropHints(); row.classList.add('drop-into'); }
    });
    row.addEventListener('drop', event => {
      const raw = event.dataTransfer.getData('application/x-dsh-files');
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropHints();
      void dropInto(entry.path, raw, event.altKey ? 'copy' : 'move');
    });
  }
  return row;
}

function clearDropHints() {
  document.querySelectorAll('.entry.drop-into, .list-scroll.drop-target').forEach(node => node.classList.remove('drop-into', 'drop-target'));
}

/** Move (or Alt-copy) the dragged paths into a folder or the current directory. */
async function dropInto(dest, rawPaths, kind) {
  if (state.busy || !writable()) return;
  let paths;
  try { paths = pathsForDrop(JSON.parse(rawPaths), dest); }
  catch { return; }
  if (!paths.length) return;
  const result = await perform(() => call(`${kind}_batch`, { paths, dest }));
  if (result?.ok && kind === 'move' && state.clipboard) {
    const moved = new Set(paths);
    state.clipboard = { ...state.clipboard, paths: state.clipboard.paths.filter(path => !moved.has(path)) };
    if (!state.clipboard.paths.length) state.clipboard = null;
    renderList();
  }
}

/** Scroll a freshly created/uploaded entry into view and select it. */
async function revealEntry(path) {
  const index = state.entries.findIndex(item => item.path === path);
  if (index < 0) return;
  if (!await leaveDraft()) return;
  state.selected = new Set([path]); state.focus = index; state.anchor = index;
  renderList();
  $(`entry-${index}`)?.scrollIntoView({ block: 'nearest' });
}

function decorateRow(row, entry, index) {
  row.id = `entry-${index}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(state.selected.has(entry.path)));
  row.classList.toggle('selected', state.selected.has(entry.path));
  row.classList.toggle('cut', state.clipboard?.kind === 'move' && state.clipboard.paths.includes(entry.path));
  row.title = entry.path;
}

/**
 * Keyed re-render (path → node, fingerprint → reuse): selection updates and
 * watch refreshes keep thumbnail `<img>` nodes alive instead of re-decoding
 * every image, matching Fanbox's incremental list behaviour.
 */
function renderList() {
  const rows = $('rows');
  const reusable = new Map();
  for (const node of rows.children) reusable.set(node.dataset.path, node);
  const fragment = document.createDocumentFragment();
  for (const [index, entry] of state.entries.entries()) {
    let row = reusable.get(entry.path);
    if (row && row.dataset.sig !== entrySig(entry)) row = undefined;
    if (!row) row = buildRow(entry);
    decorateRow(row, entry, index);
    fragment.append(row);
  }
  rows.replaceChildren(fragment);
  rows.className = `entries ${state.view}`;
  if (state.entries[state.focus]) rows.setAttribute('aria-activedescendant', `entry-${state.focus}`);
  else rows.removeAttribute('aria-activedescendant');
  $('list-head').hidden = state.view !== 'list';
  const empty = $('empty'); empty.hidden = state.entries.length > 0;
  empty.replaceChildren();
  if (!empty.hidden) {
    empty.append(icon(state.loading ? 'refresh' : state.query ? 'search' : 'folder', 40));
    empty.append(element('h2', state.loading ? t('loading') : state.error ? t('pageError') : t(state.query ? 'noResults' : 'empty')));
    empty.append(element('p', state.error || (state.loading ? '' : t(state.query ? 'noResultsHint' : 'emptyHint'))));
    if (state.error) empty.append(button('retry', () => void load()));
  }
  $('load-more').hidden = !state.hasMore;
  $('list-count').textContent = state.loading ? t('loading') : t('items', { count: state.entries.length });
  $('list-scroll').setAttribute('aria-busy', String(state.loading));
  controls();
}

function preferences() {
  document.documentElement.dataset.size = state.size;
  document.documentElement.dataset.theme = state.theme;
  for (const view of ['grid', 'list']) $(`${view}-view`).setAttribute('aria-pressed', String(state.view === view));
  document.querySelectorAll('[data-size]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.size === state.size)));
  document.querySelectorAll('[data-sort]').forEach(node => { node.dataset.active = String(node.dataset.sort === state.sortBy); node.dataset.direction = state.sortDir; });
  $('sort-by').value = state.sortBy; $('sort-direction').value = state.sortDir; $('theme').value = state.theme;
  $('preview').hidden = !state.previewOpen; $('toggle-preview').setAttribute('aria-pressed', String(state.previewOpen));
  try { writeView(localStorage, { ...state, preview: state.previewOpen }); } catch { /* Storage may be unavailable in an embedded host. */ }
}

function breadcrumb() {
  $('breadcrumb').replaceChildren();
  const parts = pathSegments(state.path), home = state.roots.find(root => root.id === 'home');
  const start = home ? parts.findIndex(part => part.path === home.path) : -1;
  for (const [index, part] of (start >= 0 ? parts.slice(start) : parts).entries()) {
    if (index) { const arrow = icon('forward', 11); arrow.classList.add('crumb-separator'); $('breadcrumb').append(arrow); }
    const node = element('button', state.roots.find(root => root.path === part.path)?.label ?? part.name, 'crumb');
    node.title = part.path; node.onclick = () => void navigate(part.path); $('breadcrumb').append(node);
  }
  $('breadcrumb').scrollLeft = $('breadcrumb').scrollWidth;
}

async function selectEntry(index, event = {}) {
  if (state.busy || state.loading || $('dialog').open || !state.entries[index]) return false;
  const next = selectionFor(state.entries, state.selected, index, state.anchor, event, state.platform, state.info.limits.maxPaths);
  if (!next) { notice(t('tooMany', { count: state.info.limits.maxPaths }), true); return false; }
  const samePreview = next.selected.size === 1 && next.selected.has(state.preview?.entry.path);
  if (!samePreview && !await leaveDraft()) return false;
  state.selected = next.selected; state.anchor = next.anchor; state.focus = index;
  renderList(); $('rows').focus({ preventScroll: true });
  if (!samePreview) { state.pendingEdit = null; clearPreview(); if (state.previewOpen && state.selected.size === 1) void choose(selected()[0]); }
  return true;
}

async function activate(entry = selected()[0]) {
  if (!entry || state.busy || state.loading) return;
  if (entry.isDir) return navigate(entry.path);
  if (system()) return perform(() => call('open', { path: entry.path }), false);
  state.previewOpen = true; preferences(); await choose(entry);
}

/**
 * Closing the pane is pure presentation state. It must stay responsive while a
 * file operation is running and when the host webview drops the synthetic
 * `.click()` on hidden toolbar buttons; callers may also trigger it twice.
 */
let closingPreview = false;
async function closePreview() {
  if (!state.previewOpen || closingPreview) return;
  closingPreview = true;
  try {
    if (!await leaveDraft()) return;
    state.previewOpen = false; state.pendingEdit = null;
    preferences(); clearPreview();
    $('rows').focus?.({ preventScroll: true });
  } finally { closingPreview = false; }
}
async function togglePreview(open = !state.previewOpen) {
  if (!open) return closePreview();
  state.previewOpen = true; preferences();
  if (state.selected.size === 1 && !state.preview) await choose(selected()[0]);
}

function editPath(open = true) {
  $('path-form').hidden = !open; $('breadcrumb').hidden = open;
  if (open) { $('path').value = state.path; $('path').focus(); $('path').select(); }
}

function sidebarState() {
  const visible = matchMedia('(max-width: 620px)').matches ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-hidden');
  $('toggle-sidebar').setAttribute('aria-expanded', String(visible));
}

const MENU_LABELS = {
  'new-folder': 'newFolder', 'new-file': 'newFile', upload: 'upload', paste: 'paste',
  'select-all': 'selectAll', refresh: 'refresh', 'show-preview': 'preview', 'edit-text': 'editText',
  open: 'open', editor: 'editorOpen', favorite: 'favoriteFolder', reveal: 'reveal', 'copy-path': 'copyPath',
  copy: 'copy', cut: 'cut', duplicate: 'duplicate', rename: 'rename', zip: 'zip',
  extract: 'extract', trash: 'trash', 'disk-usage': 'diskUsage', 'open-trash': 'openTrash',
};
function hideContextMenu() { $('context-menu').hidden = true; }

/**
 * Menu items call the shared action table directly. Forwarding through
 * `.click()` on hidden toolbar buttons is unreliable in embedded webviews and
 * loses the entry that was right-clicked. `pointerup` + `click` are both
 * handled (de-duplicated) so a dropped click event cannot make a menu inert.
 */
function menuItem(id, label, disabled, danger, run) {
  const item = element('button', label);
  item.type = 'button'; item.disabled = Boolean(disabled); item.setAttribute('role', 'menuitem');
  if (danger) item.className = 'danger';
  const fire = () => {
    hideContextMenu();
    try { Promise.resolve(run()).catch(report); } catch (error) { report(error); }
  };
  // Pointer gestures run on pointerup; keyboard activation arrives as a click
  // with detail === 0. This keeps one action per gesture without a time window.
  item.addEventListener('pointerup', event => { if (!event.button) fire(); });
  item.addEventListener('click', event => { if (event.detail === 0) fire(); });
  return item;
}

async function contextMenu(event, index) {
  if ($('dialog').open || $('place-dialog').open || !state.entries[index] && index !== undefined) return;
  if (index !== undefined && !state.selected.has(state.entries[index].path) && !await selectEntry(index)) return;
  const entry = index === undefined ? null : state.entries[index] ?? selected()[0];
  const disabled = actionDisabled();
  const specs = entry ? [
    { id: 'show-preview' },
    ...(entry.kind === 'text' && writable() ? [{ id: 'edit-text' }] : []),
    { id: 'open', label: t(entry.isDir ? 'openFolder' : 'open') },
    { id: 'editor' },
    ...(entry.isDir ? [{ id: 'favorite' }, { id: 'disk-usage' }] : [{ id: 'reveal' }]),
    { id: 'copy-path' },
    { divider: true },
    { id: 'copy' }, { id: 'cut' }, { id: 'paste' }, { id: 'duplicate' }, { id: 'rename' },
    { divider: true },
    { id: 'zip' },
    ...(entry.kind === 'archive' ? [{ id: 'extract' }] : []),
    { divider: true },
    { id: 'trash', label: state.platform === 'win32' ? t('recycle') : t('trash'), danger: true },
  ] : [
    { id: 'new-folder' }, { id: 'new-file' }, { id: 'upload' },
    { divider: true },
    { id: 'paste' }, { id: 'select-all' },
    { divider: true },
    { id: 'disk-usage' }, { id: 'open-trash' },
    { id: 'refresh' },
  ];
  $('place-menu').hidden = true;
  const menu = $('context-menu'); menu.replaceChildren();
  for (const spec of specs) {
    if (spec.divider) {
      const separator = element('div', undefined, 'menu-separator'); separator.setAttribute('role', 'separator'); menu.append(separator);
      continue;
    }
    const label = spec.label ?? t(MENU_LABELS[spec.id]);
    menu.append(menuItem(spec.id, label, disabled[spec.id], spec.danger, () => actions[spec.id]?.()));
  }
  menu.hidden = false;
  const width = menu.offsetWidth || 205, height = menu.offsetHeight || 320;
  menu.style.left = `${Math.max(8, Math.min(event.clientX ?? 8, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY ?? 8, innerHeight - height - 8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (!disposed && !document.hidden && !state.busy && !state.loading) void load(); }, 350);
}
function connectWatch() {
  stopWatch?.();
  stopWatch = watch(state.path, queueRefresh, connected => {
    $('connection').textContent = t(connected ? 'live' : 'reconnect');
    $('connection').classList.toggle('offline', !connected);
  });
}

async function load({ path = state.path, append = false, historyIndex } = {}) {
  if (!path || state.busy && append) return;
  listController?.abort(); listController = new AbortController();
  const request = ++state.request, isNew = path !== state.path;
  state.loading = true; state.error = null; renderList();
  try {
    const common = { path, offset: append ? state.entries.length : 0, limit: 200, showHidden: $('hidden-files').checked, sortBy: state.sortBy, sortDir: state.sortDir, probeProjects: !state.query };
    const result = state.query
      ? await call('search', { ...common, query: state.query, content: $('content-search').checked, recursive: true }, { signal: listController.signal })
      : await call('list_dir', common, { signal: listController.signal });
    if (request !== state.request || disposed) return;
    const canonical = result.path ?? path;
    state.path = canonical; state.parent = result.parent ?? parentOf(canonical);
    const focusPath = state.entries[state.focus]?.path, anchorPath = state.entries[state.anchor]?.path;
    state.entries = append ? [...state.entries, ...result.entries] : result.entries;
    state.focus = state.entries.findIndex(entry => entry.path === focusPath); state.anchor = state.entries.findIndex(entry => entry.path === anchorPath);
    state.hasMore = result.hasMore; state.selected = new Set([...state.selected].filter(p => state.entries.some(e => e.path === p)));
    $('path').value = canonical; $('heading').textContent = rootLabel(canonical);
    $('heading').title = canonical; breadcrumb();
    $('search-options').hidden = !state.query;
    if (historyIndex !== undefined) state.historyIndex = historyIndex;
    else if (state.history[state.historyIndex] !== canonical) {
      state.history = state.history.slice(0, state.historyIndex + 1); state.history.push(canonical);
      if (state.history.length > 100) state.history.shift(); state.historyIndex = state.history.length - 1;
    }
    if (isNew || !stopWatch) connectWatch();
    if (result.truncated) notice(t('searchLimited'));
  } catch (error) {
    if (request !== state.request || error.name === 'AbortError') return;
    state.error = error.message; $('path').value = state.path || path; report(error);
  } finally { if (request === state.request && !disposed) { state.loading = false; renderList(); } }
}
async function navigate(path, historyIndex) {
  if (!path || state.busy || !await leaveDraft()) return;
  state.pendingEdit = null; clearPreview(); state.query = ''; $('search').value = ''; $('clear-search').hidden = true;
  state.selected.clear(); state.focus = -1; state.anchor = -1; editPath(false);
  document.body.classList.remove('sidebar-open'); $('more').open = false; $('view-options').open = false;
  sidebarState(); await load({ path, historyIndex });
}

function clearPreview() {
  ++state.previewRequest; previewController?.abort();
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined;
  state.preview = null; renderPreview();
}

/**
 * Markdown images resolve against the document's own folder and stream through
 * the same-origin raw route; remote https images stay untouched.
 */
function markdownImageResolver(entry) {
  const base = entry.dirHint ?? parentOf(entry.path);
  return src => {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    if (!src.trim() || /^file:/i.test(src)) return undefined;
    return rawPreviewUrl(resolveRelativePath(base, src));
  };
}

/** Bounded CSV/TSV parse (quoted cells supported) for the table preview. */
function parseDelimited(text, delimiter, maxRows = 500) {
  const rows = [];
  const source = String(text ?? '').slice(0, 1000000);
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index++; }
        else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, truncated: true };
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return { rows, truncated: false };
}

function buildTablePreview(content, delimiter) {
  const { rows, truncated } = parseDelimited(content, delimiter);
  const table = element('table', undefined, 'csv-table');
  if (rows.length) {
    const head = element('thead'); const headRow = element('tr');
    for (const cell of rows[0]) headRow.append(element('th', cell));
    head.append(headRow); table.append(head);
  }
  const body = element('tbody');
  for (const row of rows.slice(1)) {
    const tr = element('tr');
    for (const cell of row) tr.append(element('td', cell));
    body.append(tr);
  }
  table.append(body);
  const wrapper = element('div', undefined, 'csv-wrap');
  wrapper.append(table);
  if (truncated) wrapper.append(element('p', t('tableTruncated'), 'preview-hint'));
  return wrapper;
}

/** Fanbox-style lightbox: wheel zoom, blank click or Esc closes. */
function openLightbox(src, name) {
  if (!lightbox) {
    lightbox = element('div', undefined, 'lightbox');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-label', t('lightboxHint'));
    const image = element('img');
    image.alt = ''; image.draggable = false;
    const hint = element('p', t('lightboxHint'), 'lightbox-hint');
    lightbox.append(image, hint);
    let scale = 1;
    const apply = () => { image.style.transform = `scale(${scale})`; };
    lightbox.addEventListener('click', event => { if (!event.target.closest('img')) closeLightbox(); });
    lightbox.addEventListener('wheel', event => {
      event.preventDefault();
      scale = Math.min(8, Math.max(0.2, scale - event.deltaY * 0.002));
      apply();
    }, { passive: false });
    lightbox.reset = () => { scale = 1; image.style.transform = ''; };
    lightbox.image = image;
    document.body.append(lightbox);
  }
  lightbox.image.src = src; lightbox.image.alt = name ?? '';
  lightbox.reset();
  lightbox.hidden = false;
}
function closeLightbox() { if (lightbox) { lightbox.hidden = true; lightbox.image.src = ''; } }
const lightboxOpen = () => Boolean(lightbox && !lightbox.hidden);

async function choose(entry) {
  if (!entry || $('dialog').open || state.preview?.entry.path === entry.path) return;
  if (!await leaveDraft()) return;
  clearPreview(); const request = ++state.previewRequest;
  state.preview = { entry, loading: true, editing: false }; renderPreview();
  previewController = new AbortController();
  const signal = previewController.signal;
  const wantsEdit = state.pendingEdit === entry.path;
  try {
    let result, hint;
    if (entry.isDir) result = null;
    else if (isHtmlName(entry.name) && !wantsEdit) result = { kind: 'html', url: rawPreviewUrl(entry.path) };
    else if (entry.kind === 'text') result = await call('read_file', { path: entry.path }, { signal });
    else if (entry.kind === 'archive' && system()) result = await call('archive_list', { path: entry.path }, { signal });
    else if (['image', 'pdf', 'audio', 'video'].includes(entry.kind)) {
      // The page loads the whole file over a same-origin, range-capable URL.
      // Do not gate on entry.size: the bounded base64 commands are a tool
      // contract, not a limit on what the browser can display. If the host
      // lacks that route, renderPreview() falls back to the bounded command.
      result = { kind: 'media', url: rawPreviewUrl(entry.path) };
      // `pdfViewerEnabled` is undefined on several embedded webviews; only an
      // explicit false means the object fallback will be needed.
      if (entry.kind === 'pdf' && navigator.pdfViewerEnabled === false) hint = t('pdfUnavailable');
    } else hint = t('unsupported');
    if (request !== state.previewRequest || disposed) return;
    state.preview = { entry, result, hint, loading: false, editing: false, draft: result?.content };
    if (wantsEdit) state.pendingEdit = null;
    if (wantsEdit && result?.content !== undefined && !result.truncated && writable()) state.preview.editing = true;
  } catch (error) {
    if (request !== state.previewRequest || error.name === 'AbortError') return;
    state.preview = { entry, loading: false, hint: `${t('binaryError')} ${error.message}` };
  }
  renderPreview();
  if (state.preview?.editing) $('preview-content').querySelector('textarea')?.focus();
}

function mediaElement(entry, source) {
  const tag = entry.kind === 'image' ? 'img' : entry.kind === 'pdf' ? 'object' : entry.kind;
  const media = element(tag, undefined, 'media-preview');
  if (tag === 'object') {
    media.data = source; media.type = 'application/pdf'; media.title = entry.name;
    media.append(element('p', t('pdfUnavailable'), 'preview-hint'));
  } else media.src = source;
  if (tag === 'img') {
    media.alt = entry.name;
    media.addEventListener('click', () => { if (media.naturalWidth || media.complete) openLightbox(media.currentSrc || media.src, entry.name); });
  } else if (tag !== 'object') media.controls = true;
  return media;
}

/** Old hosts without the raw route still get the bounded base64 preview. */
async function handleMediaError(entry, media, rawUrl) {
  if (!media.isConnected || state.preview?.entry.path !== entry.path) return;
  if (rawUrl && !media.dataset.fallback) {
    media.dataset.fallback = '1';
    const method = entry.kind === 'image' ? 'image_preview' : entry.kind === 'pdf' ? 'pdf_preview' : 'media_preview';
    try {
      const bounded = await call(method, { path: entry.path }, { signal: previewController?.signal });
      if (!media.isConnected || state.preview?.entry.path !== entry.path) return;
      if (!bounded?.data) throw new Error('empty preview');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(previewBlob(bounded));
      if (media.tagName === 'OBJECT') media.data = objectUrl;
      else { media.src = objectUrl; media.load?.(); }
      return;
    } catch (error) {
      if (error?.name === 'AbortError' || !media.isConnected) return;
    }
  }
  media.replaceWith(element('p', t('binaryError'), 'preview-hint'));
}

function renderPreview() {
  const pane = $('preview-content'), p = state.preview;
  pane.replaceChildren();
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined;
  $('preview').classList.toggle('has-file', Boolean(p));
  if (!p) {
    const empty = element('div', undefined, 'preview-empty'); empty.append(icon('file', 44), element('h2', t('noSelection')), element('p', t('previewHint'))); pane.append(empty); return;
  }
  const { entry, result } = p;
  pane.append(element('h2', entry.name, 'preview-name'));
  const meta = element('dl', undefined, 'metadata');
  for (const [label, value] of [['type', t(entry.kind)], ['size', entry.isDir ? '—' : formatBytes(entry.size)], ['modified', date(result?.mtime ?? entry.mtime)], ['birth', date(entry.btime)], ['pathLabel', entry.path]]) meta.append(element('dt', t(label)), element('dd', value));
  pane.append(meta);
  if (p.loading) { pane.append(element('p', t('loading'), 'muted')); return; }
  if (entry.isDir) { pane.append(button('go', () => void navigate(entry.path))); return; }
  if (p.hint) pane.append(element('p', p.hint, 'preview-hint'));
  const editing = p.editing && (result?.kind === 'text' || result?.kind === 'html');
  if (editing) {
    const toolbar = element('div', undefined, 'editor-toolbar');
    const status = element('span', dirty() ? t('edited') : t('saved'), 'muted'); status.id = 'draft-status';
    const save = button('save', () => void saveText(), 'button primary small'); save.id = 'save-text'; save.disabled = !dirty() || state.busy;
    toolbar.append(status, save); pane.append(toolbar);
    const editor = element('textarea', undefined, 'editor'); editor.value = p.draft; editor.spellcheck = false; editor.setAttribute('aria-label', `${t('edit')} ${entry.name}`);
    editor.addEventListener('input', () => { p.draft = editor.value; $('draft-status').textContent = dirty() ? t('edited') : t('saved'); $('save-text').disabled = !dirty() || state.busy; });
    pane.append(editor, element('small', t('draftHint'), 'muted'));
  } else if (result?.kind === 'text') {
    const toolbar = element('div', undefined, 'editor-toolbar');
    if (writable() && !result.truncated) toolbar.append(button('edit', () => { p.editing = true; renderPreview(); pane.querySelector('textarea')?.focus(); }, 'button small'));
    pane.append(toolbar);
    if (isMarkdownName(entry.name)) {
      const view = element('div', undefined, 'md-view');
      view.append(renderMarkdown(result.content, {
        resolveImage: markdownImageResolver(entry),
        highlight: (code, source, lang) => highlightInto(code, source, lang),
      }));
      pane.append(view);
    } else if (isTableName(entry.name)) {
      pane.append(buildTablePreview(result.content, fileExtension(entry.name) === 'tsv' ? '\t' : ','));
    } else {
      const language = languageForName(entry.name);
      const pre = element('pre', undefined, 'text-preview');
      if (language) {
        pre.classList.add('code-preview');
        const code = element('code');
        highlightInto(code, result.content, language);
        pre.append(code);
      } else pre.textContent = result.content;
      pane.append(pre);
    }
    if (result.truncated) pane.append(element('p', t('truncated'), 'preview-hint'));
  } else if (result?.kind === 'html') {
    const frame = element('iframe', undefined, 'html-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = result.url; frame.title = entry.name;
    pane.append(frame, element('p', t('htmlSandbox'), 'muted'));
  } else if (result?.kind === 'media' || result?.data) {
    let source = result.url;
    if (!source) { objectUrl = URL.createObjectURL(previewBlob(result)); source = objectUrl; }
    const media = mediaElement(entry, source);
    media.addEventListener('error', () => void handleMediaError(entry, media, result.url));
    pane.append(media);
  } else if (entry.kind === 'archive' && result) {
    const list = element('ul', undefined, 'archive-list');
    for (const item of (result.entries ?? []).slice(0, 500)) list.append(element('li', typeof item === 'string' ? item : item.name ?? item.path));
    pane.append(list.childElementCount ? list : element('p', t('archiveEmpty')));
  }
  if (system()) pane.append(button('open', () => void perform(() => call('open', { path: entry.path }), false), 'button small'));
}

async function saveText() {
  const p = state.preview;
  if (!p?.editing || !dirty() || state.busy || !writable() || p.result.truncated) return;
  const content = p.draft;
  state.busy = true; controls(); $('save-text').disabled = true;
  try {
    const result = await call('write_file', { parent: p.entry.dirHint ?? parentOf(p.entry.path), name: p.entry.name, data: toBase64(new TextEncoder().encode(content)), expectedMtime: p.result.mtime });
    if (result.conflict) { notice(t('conflict'), true); return; }
    p.result = { ...p.result, content, mtime: result.mtime }; p.entry.size = new TextEncoder().encode(content).length;
    notice(t('saved')); renderPreview(); await load();
  } catch (error) { report(error); }
  finally { state.busy = false; controls(); if ($('save-text')) $('save-text').disabled = !dirty(); }
}

async function perform(op, refresh = true) {
  if (state.busy) return;
  state.busy = true; controls(); $('more').open = false;
  try {
    const result = await op();
    if (result?.errors?.length) notice(`${t('partial', { count: result.count, failed: result.errors.length })} ${result.errors.map(e => `${e.path}: ${e.error}`).join('\n')}`, true);
    else if (result?.cancelled) notice(t('cancelled'));
    else notice(t('done'));
    if (refresh) await load();
    return result;
  } catch (error) { report(error); }
  finally { state.busy = false; controls(); }
}

async function create(kind) {
  const name = await ask({ title: kind === 'folder' ? 'newFolder' : 'newFile', label: kind === 'folder' ? 'folderName' : 'fileName', value: t(kind === 'folder' ? 'newFolderDefault' : 'newFileDefault') });
  if (name === null) return;
  const result = await perform(() => call(kind === 'folder' ? 'create_folder' : 'create_file', { parent: state.path, name }));
  if (result) await revealEntry(joinPath(state.path, name));
}
async function startUpload(files) {
  if (!files.length || state.busy || !writable()) return;
  const tooLarge = files.find(file => file.size > state.info.limits.maxImportBytes);
  if (tooLarge) return notice(t('uploadLimit', { name: tooLarge.name }), true);
  state.busy = true; controls(); uploadController = new AbortController();
  const parent = state.path; let completed = 0; let lastUploaded;
  $('transfer').hidden = false; $('transfer-cancel').disabled = false;
  try {
    for (const file of files) {
      uploadController.signal.throwIfAborted();
      $('transfer-text').textContent = `${t('uploading')} ${completed + 1}/${files.length} · ${file.name}`;
      $('transfer-progress').value = 0;
      const done = await upload(file, parent, state.info.limits, uploadController.signal, bytes => { $('transfer-progress').value = file.size ? bytes / file.size * 100 : 100; });
      lastUploaded = done?.path ?? lastUploaded;
      completed++;
    }
    notice(t('uploadDone', { count: completed }));
  } catch (error) {
    if (error.name === 'AbortError') notice(t('uploadCancelled'));
    else notice(t('uploadFailed', { count: completed, message: error.message }), true);
  } finally {
    uploadController = undefined; state.busy = false; $('transfer').hidden = true;
    await load();
    if (lastUploaded) await revealEntry(lastUploaded);
    controls();
  }
}

/** Context-menu "edit text": open the preview pane in editing mode. */
async function startEditing(entry = selected()[0]) {
  if (!entry || entry.kind !== 'text' || !writable()) return;
  const current = state.preview;
  state.previewOpen = true; preferences();
  if (current?.entry.path === entry.path && current.editing) {
    $('preview-content').querySelector('textarea')?.focus(); return;
  }
  if (!await leaveDraft()) return;
  if (current?.entry.path === entry.path && current.result?.content !== undefined && !current.result.truncated) {
    current.editing = true; renderPreview(); $('preview-content').querySelector('textarea')?.focus();
  } else {
    state.pendingEdit = entry.path;
    void choose(entry);
  }
}

/** Open one search result: navigate to its folder, then select + preview. */
async function openSearchResult(entry) {
  quickSearch?.hide();
  if (entry.isDir) return navigate(entry.path);
  const parent = entry.dirHint ?? parentOf(entry.path);
  if (parent && parent !== state.path && !state.busy) await navigate(parent);
  const index = state.entries.findIndex(item => item.path === entry.path);
  state.previewOpen = true; preferences();
  if (index >= 0 && !state.busy) await selectEntry(index);
  else { state.selected = new Set([entry.path]); state.focus = index; renderList(); void choose(entry); }
}

function openInEditor(entry = selected()[0]) {
  if (!entry || !system()) return;
  return perform(() => call('editor', { path: entry.path }), false);
}

function toggleSidebarView() {
  const mobile = matchMedia('(max-width: 620px)').matches;
  document.body.classList.toggle(mobile ? 'sidebar-open' : 'sidebar-hidden');
  sidebarState();
}

// ---- disk usage lens (Fanbox du panel) -------------------------------------

let diskRequest = 0;
async function openDiskUsage(path = state.path) {
  if (!path) return;
  $('disk-dialog').showModal();
  await renderDiskUsage(path);
}
async function renderDiskUsage(path) {
  const request = ++diskRequest;
  $('disk-title').textContent = `${t('diskUsage')} · ${rootLabel(path)}`;
  $('disk-path').textContent = path;
  const upTarget = parentOf(path);
  $('disk-up').disabled = !upTarget || upTarget === path;
  $('disk-open').disabled = false;
  $('disk-list').replaceChildren(element('p', t('diskComputing'), 'muted'));
  try {
    const result = await call('disk_usage', { path });
    if (request !== diskRequest || !$('disk-dialog').open) return;
    renderDiskList(result, path);
  } catch (error) {
    if (request === diskRequest && $('disk-dialog').open) $('disk-list').replaceChildren(element('p', error.message, 'muted'));
  }
}
function renderDiskList(result, path) {
  const items = (result.items ?? []).slice(0, 60);
  const peak = items[0]?.size || 1;
  const extras = Math.max(0, (result.items?.length ?? 0) - items.length);
  $('disk-summary').textContent = [
    formatBytes(result.bytes),
    t('diskCounts', { files: result.files ?? 0, directories: result.directories ?? 0 }),
    result.truncated ? t('diskTruncated') : '',
    extras ? t('diskMore', { count: extras }) : '',
  ].filter(Boolean).join(' · ');
  const list = $('disk-list');
  list.replaceChildren();
  for (const item of items) {
    const row = element(item.isDir ? 'button' : 'div', undefined, 'disk-row');
    const bar = element('span', undefined, 'disk-bar');
    bar.style.width = `${Math.max(1, item.size / peak * 100)}%`;
    const name = element('span', item.name, 'disk-name');
    if (item.isDir) name.prepend(icon('folder', 13));
    row.append(bar, name, element('span', formatBytes(item.size), 'disk-size'));
    if (item.isDir) {
      row.type = 'button';
      row.title = t('diskDrill');
      row.addEventListener('click', () => void renderDiskUsage(joinPath(path, item.name)));
    }
    list.append(row);
  }
  if (!items.length) list.append(element('p', t('empty'), 'muted'));
}

function bind() {
  $('back').onclick = () => void navigate(state.history[state.historyIndex - 1], state.historyIndex - 1);
  $('forward').onclick = () => void navigate(state.history[state.historyIndex + 1], state.historyIndex + 1);
  $('up').onclick = () => void navigate(state.parent); $('refresh').onclick = () => void load();
  $('path-form').onsubmit = event => { event.preventDefault(); void navigate(normalizePathInput($('path').value)); };
  $('edit-path').onclick = () => editPath();
  $('breadcrumb').ondblclick = () => editPath();
  $('search-form').onsubmit = event => { event.preventDefault(); state.query = $('search').value.trim(); $('clear-search').hidden = !state.query; void load(); };
  $('clear-search').onclick = () => { state.query = ''; $('search').value = ''; $('clear-search').hidden = true; void load(); };
  $('hidden-files').onchange = () => void load(); $('content-search').onchange = () => { if (state.query) void load(); };
  document.querySelectorAll('[data-sort]').forEach(node => node.onclick = () => {
    if (state.busy || state.loading) return;
    state.sortDir = state.sortBy === node.dataset.sort && state.sortDir === 'asc' ? 'desc' : 'asc'; state.sortBy = node.dataset.sort;
    preferences(); void load();
  });
  $('sort-by').onchange = () => { state.sortBy = $('sort-by').value; preferences(); void load(); };
  $('sort-direction').onchange = () => { state.sortDir = $('sort-direction').value; preferences(); void load(); };
  $('theme').onchange = () => { state.theme = $('theme').value; preferences(); };
  for (const view of ['grid', 'list']) $(`${view}-view`).onclick = () => { state.view = view; preferences(); renderList(); };
  document.querySelectorAll('[data-size]').forEach(node => node.onclick = () => { state.size = node.dataset.size; preferences(); });
  $('toggle-sidebar').onclick = toggleSidebarView; $('sidebar-close').onclick = toggleSidebarView;
  $('toggle-preview').onclick = () => void togglePreview();
  // Actions with no toolbar button are still available from the context menu.
  action('show-preview', () => void togglePreview(true));
  action('edit-text', () => void startEditing());
  action('select-all', async () => {
    if (!await leaveDraft()) return;
    const limit = state.info?.limits.maxPaths ?? 200;
    state.selected = new Set(state.entries.slice(0, limit).map(entry => entry.path));
    clearPreview(); renderList();
    if (state.entries.length > state.selected.size) notice(t('tooMany', { count: limit }));
  });
  action('refresh', () => void load());
  $('favorite').onclick = action('favorite', () => { $('more').open = false; if (selected()[0]?.isDir) sidebar?.edit(selected()[0].path); });
  $('editor-open').onclick = action('editor', () => void openInEditor());
  $('disk-usage').onclick = action('disk-usage', () => { $('more').open = false; void openDiskUsage(); });
  $('open-trash').onclick = action('open-trash', () => { $('more').open = false; void perform(() => call('open_trash'), false); });
  $('load-more').onclick = () => void load({ append: true });
  $('new-folder').onclick = action('new-folder', () => void create('folder'));
  $('new-file').onclick = action('new-file', () => void create('file'));
  $('upload').onclick = action('upload', () => $('upload-input').click());
  $('upload-input').onchange = event => { void startUpload([...event.target.files]); event.target.value = ''; };
  $('transfer-cancel').onclick = () => { uploadController?.abort(); $('transfer-cancel').disabled = true; };
  for (const kind of ['copy', 'cut']) {
    $(kind).onclick = action(kind, () => { state.clipboard = { kind: kind === 'copy' ? 'copy' : 'move', paths: selected().map(e => e.path) }; renderList(); $('more').open = false; });
  }
  $('paste').onclick = action('paste', async () => {
    const clipboard = state.clipboard;
    if (!clipboard || !await leaveDraft()) return;
    const result = await perform(() => call(`${clipboard.kind}_batch`, { paths: clipboard.paths, dest: state.path }));
    if (result?.ok && clipboard.kind === 'move') state.clipboard = null;
    renderList();
  });
  $('rename').onclick = action('rename', async () => {
    const entry = selected()[0]; if (!entry || !await leaveDraft()) return;
    const name = await ask({ title: 'rename', label: 'name', value: entry.name, submit: 'rename' }); if (name === null) return;
    const result = await perform(() => call('rename', { path: entry.path, name })); if (result) clearPreview();
  });
  $('trash').onclick = action('trash', async () => {
    if (!await leaveDraft()) return;
    const paths = selected().map(e => e.path);
    const win = state.platform === 'win32';
    if (!await ask({ title: win ? 'recycleTitle' : 'trashTitle', copy: t(win ? 'recycleHint' : 'trashHint', { count: paths.length }), submit: win ? 'recycle' : 'trash', danger: true })) return;
    const result = await perform(() => call('trash_batch', { paths })); if (result) clearPreview();
  });
  $('duplicate').onclick = action('duplicate', () => void perform(() => call('duplicate_batch', { paths: selected().map(e => e.path) })));
  $('zip').onclick = action('zip', async () => {
    const paths = selected().map(e => e.path);
    const name = await ask({ title: 'zip', label: 'zipName', value: 'Archive.zip', submit: 'zip' });
    if (name !== null) await perform(() => call('create_zip', { paths, dest: state.path, name }));
  });
  $('extract').onclick = action('extract', async () => {
    const entry = selected()[0]; if (!entry) return;
    const dest = await ask({ title: 'extract', label: 'destination', value: state.path, submit: 'extract' });
    if (dest !== null) await perform(() => call('extract_archive', { path: entry.path, dest }));
  });
  $('copy-path').onclick = action('copy-path', async () => { try { await navigator.clipboard.writeText(selected()[0].path); notice(t('copied')); } catch (error) { report(error); } });
  $('open').onclick = action('open', () => void activate());
  $('reveal').onclick = action('reveal', () => void perform(() => call('reveal', { path: selected()[0].path }), false));
  $('disk-up').onclick = () => { const target = parentOf($('disk-path').textContent); if (target && target !== $('disk-path').textContent) void renderDiskUsage(target); };
  $('disk-open').onclick = () => { const target = $('disk-path').textContent; $('disk-dialog').close(); void navigate(target); };
  $('disk-close').onclick = () => $('disk-dialog').close();
  // Host webviews do not always dispatch a synthetic click on this control.
  // Pointer gestures are handled on pointerup; click is kept for keyboard
  // activation only (detail === 0), so each gesture closes the pane once.
  $('close-preview').disabled = false;
  $('close-preview').addEventListener('pointerup', event => { if (!event.button) void closePreview(); });
  $('close-preview').addEventListener('click', event => { if (event.detail === 0) void closePreview(); });
  $('notice-close').onclick = () => { $('notice').hidden = true; };
  // Thumbnail decode failures fall back to the vector icon, once per image.
  $('rows').addEventListener('error', event => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('entry-thumb') || img.dataset.failed) return;
    img.dataset.failed = '1';
    const entry = state.entries.find(item => item.path === img.closest('.entry')?.dataset.path);
    const artwork = img.parentElement;
    img.remove();
    if (artwork && entry) artwork.prepend(fileIcon(entry));
  }, true);
  $('list-scroll').addEventListener('click', async event => {
    if (event.target.closest('button,.entry') || state.busy || !await leaveDraft()) return;
    state.selected.clear(); clearPreview(); renderList(); $('rows').focus();
  });
  $('list-scroll').addEventListener('contextmenu', event => {
    if (event.target.closest('.entry')) return;
    event.preventDefault(); void contextMenu(event);
  });
  // Drag & drop: external files upload into the current folder; internal
  // drags dropped on blank space move (Alt = copy) into the current folder.
  const hasFiles = event => [...event.dataTransfer?.types ?? []].includes('Files');
  const hasInternal = event => [...event.dataTransfer?.types ?? []].includes('application/x-dsh-files');
  $('list-scroll').addEventListener('dragover', event => {
    if (hasInternal(event) && writable() && !state.busy) {
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
      $('list-scroll').classList.add('drop-target');
      return;
    }
    if (!hasFiles(event) || !writable() || state.busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    $('list-scroll').classList.add('drop-target');
  });
  $('list-scroll').addEventListener('dragleave', event => {
    if (!$('list-scroll').contains(event.relatedTarget)) $('list-scroll').classList.remove('drop-target');
  });
  $('list-scroll').addEventListener('drop', event => {
    $('list-scroll').classList.remove('drop-target');
    const raw = event.dataTransfer.getData('application/x-dsh-files');
    if (raw) {
      event.preventDefault();
      void dropInto(state.path, raw, event.altKey ? 'copy' : 'move');
      return;
    }
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    if (!writable()) return notice(t('readOnlyUpload'), true);
    void startUpload(files);
  });
  // Approaching the end of a long listing loads the next page automatically.
  $('list-scroll').addEventListener('scroll', () => {
    const list = $('list-scroll');
    if (!state.hasMore || state.loading || state.busy) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 320) void load({ append: true });
  }, { passive: true });
  document.addEventListener('pointerdown', event => {
    // A right-button press opens a new menu in the same gesture; do not close
    // the freshly built one from a stale pointer event.
    if (event.button !== 2 && !event.target.closest('#context-menu')) hideContextMenu();
    document.querySelectorAll('details[open]').forEach(node => { if (!node.contains(event.target)) node.open = false; });
  });
  document.addEventListener('keydown', async event => {
    // ⌘K works everywhere, including inputs and while the overlay is open.
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
      if ($('dialog').open || $('place-dialog').open) return;
      event.preventDefault();
      quickSearch?.toggle({ dir: state.path, home: state.info?.policy?.home });
      return;
    }
    if ($('dialog').open || $('place-dialog').open || $('disk-dialog').open || !$('place-menu').hidden || document.body.classList.contains('dragging-place')) return;
    const menu = $('context-menu');
    if (!menu.hidden) {
      if (event.key === 'Tab') { hideContextMenu(); return; }
      const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus(); return;
      }
    }
    if (event.key === 'Escape') {
      if (quickSearch?.isOpen) { quickSearch.hide(); return; }
      if (lightboxOpen()) { closeLightbox(); return; }
      hideContextMenu(); document.querySelectorAll('details[open]').forEach(node => { node.open = false; }); document.body.classList.remove('sidebar-open'); sidebarState(); editPath(false); $('rows').focus(); if (state.previewOpen) void closePreview(); return;
    }
    const typing = Boolean(event.target.closest('input,textarea,select,[contenteditable="true"]'));
    const shortcut = shortcutAction(event, state.platform, typing);
    // Space/Enter on a native button must retain its normal activation behavior.
    if (shortcut && (!event.target.closest('button,summary') || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (shortcut === 'save') { void saveText(); return; }
      if (shortcut === 'path') { editPath(); return; }
      if (shortcut === 'search') { $('search').focus(); $('search').select(); return; }
      if (shortcut === 'toggle-sidebar') { toggleSidebarView(); return; }
      if (state.busy || state.loading) return;
      if (shortcut === 'select-all') { await actions['select-all'](); return; }
      if (shortcut === 'activate') { void activate(); return; }
      if (shortcut === 'quick-look') { void togglePreview(); return; }
      if (shortcut === 'editor') { if (!actionDisabled().editor) openInEditor(); return; }
      $(shortcut)?.click(); return;
    }
    if (event.target !== $('rows') || typing || state.busy || state.loading || !state.entries.length) return;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); const rect = $('rows').getBoundingClientRect(); void contextMenu({ clientX: rect.x + 30, clientY: rect.y + 30 }, Math.max(0, state.focus)); return;
    }
    const columns = state.view === 'grid' ? Math.max(1, getComputedStyle($('rows')).gridTemplateColumns.split(' ').length) : 1;
    const movement = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (movement !== undefined || ['Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? state.entries.length - 1 : Math.max(0, Math.min(state.entries.length - 1, state.focus < 0 ? 0 : state.focus + movement));
      if (await selectEntry(index, { shiftKey: event.shiftKey })) $(`entry-${index}`)?.scrollIntoView({ block: 'nearest' });
    }
  });
  window.addEventListener('beforeunload', event => { if (dirty() || state.busy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('resize', sidebarState);
  window.addEventListener('pagehide', () => {
    disposed = true; sidebar?.dispose(); quickSearch?.hide(); stopWatch?.(); clearTimeout(refreshTimer);
    listController?.abort(); previewController?.abort(); uploadController?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopWatch?.(); stopWatch = undefined; clearTimeout(refreshTimer); }
    else if (state.path) { connectWatch(); void load(); }
  });
}

async function boot() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; document.title = `${t('title')} · DSH Files`;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-label]').forEach(node => { const text = t(node.dataset.label); node.setAttribute('aria-label', text); node.title = text; if (node.tagName === 'INPUT') node.placeholder = text; });
  document.querySelectorAll('[data-icon]').forEach(node => node.append(icon(node.dataset.icon)));
  try { const saved = readView(localStorage); Object.assign(state, saved, { previewOpen: saved.preview, preview: null }); } catch { /* Keep session defaults. */ }
  quickSearch = createQuickSearch({
    onOpen: entry => void openSearchResult(entry),
    onEditor: entry => { quickSearch.hide(); if (!system()) return void openSearchResult(entry); openInEditor(entry); },
    notice: report,
  });
  bind(); preferences(); sidebarState(); renderPreview(); controls();
  try {
    const [info, roots] = await Promise.all([describe(), call('roots')]); state.info = info;
    state.platform = info.backendCapabilities.platform ?? (/Win/.test(navigator.platform) ? 'win32' : 'darwin');
    if (state.platform === 'win32') { $('trash').textContent = t('recycle'); $('trash').dataset.i18n = 'recycle'; }
    state.roots = roots.map(root => ({ ...root, label: t(root.id) === root.id ? root.name : t(root.id) }));
    sidebar = createSidebar({ roots: state.roots, platform: state.platform, home: info.policy.home, navigate, call, notice });
    $('version').textContent = `v${info.pluginVersion}`; $('mode').textContent = !writable() ? t('readOnly') : !system() ? t('permission') : t('ready');
    await load({ path: roots.find(root => root.id === 'home')?.path ?? roots[0]?.path ?? '~' });
  } catch (error) { state.error = error.message; notice(`${t('bootError')}：${error.message}`, true); renderList(); }
}
void boot();

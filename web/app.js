import { call, describe, watch, upload, toBase64, previewBlob, rawPreviewUrl, formatBytes, parentOf } from './api.js';
import { t, language } from './locale.js';
import { icon, fileIcon } from './icons.js';
import { readView, writeView, pathSegments, normalizePathInput, selectionFor, shortcutAction } from './view-state.js';
import { createSidebar } from './sidebar.js';

const $ = id => document.getElementById(id);
const state = { path: '', parent: '', entries: [], selected: new Set(), anchor: -1, focus: -1, roots: [], query: '', sortBy: 'name', sortDir: 'asc', view: 'grid', size: 'medium', theme: 'system', previewOpen: false, platform: 'darwin', hasMore: false, loading: false, busy: false, history: [], historyIndex: -1, request: 0, previewRequest: 0, preview: null, info: null, clipboard: null, error: null, pendingEdit: null };
let listController, previewController, stopWatch, refreshTimer, uploadController, objectUrl, sidebar;
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
const system = () => state.info?.backendCapabilities.osIntegration === true;
const dirty = () => state.preview?.editing && state.preview.draft !== state.preview.result.content;
function date(value) { return value ? new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }

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
    back: state.historyIndex <= 0 || busy, forward: state.historyIndex >= state.history.length - 1 || busy,
    up: !state.path || state.path === state.parent || busy, refresh: !state.path || busy,
    'load-more': busy,
    favorite: count !== 1 || !one?.isDir || busy,
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
  $('selection-count').textContent = count ? t('selected', { count }) : '';
  $('path').disabled = state.busy; $('search').disabled = state.busy;
  $('clipboard-status').textContent = state.clipboard ? t('clipboard', { count: state.clipboard.paths.length, action: t(state.clipboard.kind === 'copy' ? 'copyVerb' : 'moveVerb') }) : '';
  sidebar?.update(state.path, state.busy);
}

function renderList() {
  const fragment = document.createDocumentFragment();
  for (const [index, entry] of state.entries.entries()) {
    const row = element('div', undefined, 'entry'); row.dataset.path = entry.path; row.id = `entry-${index}`;
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(state.selected.has(entry.path)));
    row.classList.toggle('selected', state.selected.has(entry.path));
    row.classList.toggle('cut', state.clipboard?.kind === 'move' && state.clipboard.paths.includes(entry.path));
    row.title = entry.path;
    const primary = element('div', undefined, 'entry-primary'), artwork = element('span', undefined, 'icon-wrap');
    const copy = element('div', undefined, 'entry-copy'); copy.append(element('span', entry.name, 'entry-name'));
    if (state.query) copy.append(element('small', entry.dirHint, 'entry-location'));
    artwork.append(fileIcon(entry)); primary.append(artwork, copy);
    row.append(primary, element('span', date(entry.mtime), 'entry-meta entry-date'), element('span', entry.isDir ? state.view === 'grid' ? t('dir') : '—' : formatBytes(entry.size), 'entry-meta entry-size'), element('span', t(entry.kind), 'entry-meta entry-kind'));
    row.addEventListener('click', event => { event.stopPropagation(); void selectEntry(index, event); });
    row.addEventListener('dblclick', () => void activate(entry));
    row.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); void contextMenu(event, index); });
    fragment.append(row);
  }
  $('rows').replaceChildren(fragment);
  $('rows').className = `entries ${state.view}`;
  if (state.entries[state.focus]) $('rows').setAttribute('aria-activedescendant', `entry-${state.focus}`);
  else $('rows').removeAttribute('aria-activedescendant');
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
  open: 'open', favorite: 'favoriteFolder', reveal: 'reveal', 'copy-path': 'copyPath',
  copy: 'copy', cut: 'cut', duplicate: 'duplicate', rename: 'rename', zip: 'zip',
  extract: 'extract', trash: 'trash',
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
    ...(entry.isDir ? [{ id: 'favorite' }] : [{ id: 'reveal' }]),
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
    const common = { path, offset: append ? state.entries.length : 0, limit: 200, showHidden: $('hidden-files').checked, sortBy: state.sortBy, sortDir: state.sortDir };
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
    $('path').value = canonical; $('heading').textContent = state.roots.find(r => r.path === canonical)?.label ?? canonical.split(/[/\\]/).filter(Boolean).at(-1) ?? t('title');
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
async function choose(entry) {
  if (!entry || $('dialog').open || state.preview?.entry.path === entry.path) return;
  if (!await leaveDraft()) return;
  clearPreview(); const request = ++state.previewRequest;
  state.preview = { entry, loading: true, editing: false }; renderPreview();
  previewController = new AbortController();
  const signal = previewController.signal;
  try {
    let result, hint;
    if (entry.isDir) result = null;
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
    const pendingEdit = state.pendingEdit === entry.path;
    if (pendingEdit) state.pendingEdit = null;
    if (pendingEdit && result?.kind === 'text' && !result.truncated && writable()) state.preview.editing = true;
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
  if (tag === 'img') media.alt = entry.name;
  else if (tag !== 'object') media.controls = true;
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
  for (const [label, value] of [['type', t(entry.kind)], ['size', entry.isDir ? '—' : formatBytes(entry.size)], ['modified', date(result?.mtime ?? entry.mtime)], ['pathLabel', entry.path]]) meta.append(element('dt', t(label)), element('dd', value));
  pane.append(meta);
  if (p.loading) { pane.append(element('p', t('loading'), 'muted')); return; }
  if (entry.isDir) { pane.append(button('go', () => void navigate(entry.path))); return; }
  if (p.hint) pane.append(element('p', p.hint, 'preview-hint'));
  if (result?.kind === 'text') {
    const toolbar = element('div', undefined, 'editor-toolbar');
    if (p.editing) {
      const status = element('span', dirty() ? t('edited') : t('saved'), 'muted'); status.id = 'draft-status';
      const save = button('save', () => void saveText(), 'button primary small'); save.id = 'save-text'; save.disabled = !dirty() || state.busy;
      toolbar.append(status, save); pane.append(toolbar);
      const editor = element('textarea', undefined, 'editor'); editor.value = p.draft; editor.spellcheck = false; editor.setAttribute('aria-label', `${t('edit')} ${entry.name}`);
      editor.addEventListener('input', () => { p.draft = editor.value; $('draft-status').textContent = dirty() ? t('edited') : t('saved'); $('save-text').disabled = !dirty() || state.busy; });
      pane.append(editor, element('small', t('draftHint'), 'muted'));
    } else {
      if (writable() && !result.truncated) toolbar.append(button('edit', () => { p.editing = true; renderPreview(); pane.querySelector('textarea')?.focus(); }, 'button small'));
      pane.append(toolbar, element('pre', result.content, 'text-preview'));
    }
    if (result.truncated) pane.append(element('p', t('truncated'), 'preview-hint'));
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
  await perform(() => call(kind === 'folder' ? 'create_folder' : 'create_file', { parent: state.path, name }));
}
async function startUpload(files) {
  if (!files.length || state.busy || !writable()) return;
  const tooLarge = files.find(file => file.size > state.info.limits.maxImportBytes);
  if (tooLarge) return notice(t('uploadLimit', { name: tooLarge.name }), true);
  state.busy = true; controls(); uploadController = new AbortController();
  const parent = state.path; let completed = 0;
  $('transfer').hidden = false; $('transfer-cancel').disabled = false;
  try {
    for (const file of files) {
      uploadController.signal.throwIfAborted();
      $('transfer-text').textContent = `${t('uploading')} ${completed + 1}/${files.length} · ${file.name}`;
      $('transfer-progress').value = 0;
      await upload(file, parent, state.info.limits, uploadController.signal, bytes => { $('transfer-progress').value = file.size ? bytes / file.size * 100 : 100; });
      completed++;
    }
    notice(t('uploadDone', { count: completed }));
  } catch (error) {
    if (error.name === 'AbortError') notice(t('uploadCancelled'));
    else notice(t('uploadFailed', { count: completed, message: error.message }), true);
  } finally { uploadController = undefined; state.busy = false; $('transfer').hidden = true; await load(); controls(); }
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
  if (current?.entry.path === entry.path && current.result?.kind === 'text' && !current.result.truncated) {
    current.editing = true; renderPreview(); $('preview-content').querySelector('textarea')?.focus();
  } else {
    state.pendingEdit = entry.path;
    void choose(entry);
  }
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
  const toggleSidebar = () => {
    const mobile = matchMedia('(max-width: 620px)').matches;
    document.body.classList.toggle(mobile ? 'sidebar-open' : 'sidebar-hidden');
    sidebarState();
  };
  $('toggle-sidebar').onclick = toggleSidebar; $('sidebar-close').onclick = toggleSidebar;
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
  // Host webviews do not always dispatch a synthetic click on this control.
  // Pointer gestures are handled on pointerup; click is kept for keyboard
  // activation only (detail === 0), so each gesture closes the pane once.
  $('close-preview').disabled = false;
  $('close-preview').addEventListener('pointerup', event => { if (!event.button) void closePreview(); });
  $('close-preview').addEventListener('click', event => { if (event.detail === 0) void closePreview(); });
  $('notice-close').onclick = () => { $('notice').hidden = true; };
  $('list-scroll').addEventListener('click', async event => {
    if (event.target.closest('button,.entry') || state.busy || !await leaveDraft()) return;
    state.selected.clear(); clearPreview(); renderList(); $('rows').focus();
  });
  $('list-scroll').addEventListener('contextmenu', event => {
    if (event.target.closest('.entry')) return;
    event.preventDefault(); void contextMenu(event);
  });
  document.addEventListener('pointerdown', event => {
    // A right-button press opens a new menu in the same gesture; do not close
    // the freshly built one from a stale pointer event.
    if (event.button !== 2 && !event.target.closest('#context-menu')) hideContextMenu();
    document.querySelectorAll('details[open]').forEach(node => { if (!node.contains(event.target)) node.open = false; });
  });
  document.addEventListener('keydown', async event => {
    if ($('dialog').open || $('place-dialog').open || !$('place-menu').hidden || document.body.classList.contains('dragging-place')) return;
    const menu = $('context-menu');
    if (!menu.hidden) {
      if (event.key === 'Tab') { hideContextMenu(); return; }
      const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus(); return;
      }
    }
    if (event.key === 'Escape') { hideContextMenu(); document.querySelectorAll('details[open]').forEach(node => { node.open = false; }); document.body.classList.remove('sidebar-open'); sidebarState(); editPath(false); $('rows').focus(); if (state.previewOpen) void closePreview(); return; }
    const typing = Boolean(event.target.closest('input,textarea,select,[contenteditable="true"]'));
    const shortcut = shortcutAction(event, state.platform, typing);
    // Space/Enter on a native button must retain its normal activation behavior.
    if (shortcut && (!event.target.closest('button,summary') || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (shortcut === 'save') { void saveText(); return; }
      if (shortcut === 'path') { editPath(); return; }
      if (shortcut === 'search') { $('search').focus(); $('search').select(); return; }
      if (state.busy || state.loading) return;
      if (shortcut === 'select-all') { await actions['select-all'](); return; }
      if (shortcut === 'activate') { void activate(); return; }
      if (shortcut === 'quick-look') { void togglePreview(); return; }
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
  window.addEventListener('pagehide', () => { disposed = true; sidebar?.dispose(); stopWatch?.(); clearTimeout(refreshTimer); listController?.abort(); previewController?.abort(); uploadController?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); });
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

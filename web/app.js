import { call, describe, watch, upload, toBase64, previewBlob, formatBytes, parentOf } from './api.js';
import { t, language } from './locale.js';

const $ = id => document.getElementById(id);
const state = { path: '', parent: '', entries: [], selected: new Set(), roots: [], query: '', sortBy: 'name', sortDir: 'asc', hasMore: false, loading: false, busy: false, history: [], historyIndex: -1, request: 0, previewRequest: 0, preview: null, info: null, clipboard: null, error: null };
let listController, previewController, stopWatch, refreshTimer, uploadController, objectUrl;
let disposed = false;
const paths = {
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  image: 'M3 4h18v16H3ZM3 17l6-6 4 4 3-3 5 5M16 8h.01',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  back: 'm14 5-7 7 7 7', forward: 'm10 5 7 7-7 7', up: 'm5 14 7-7 7 7',
  refresh: 'M20 7V3l-4 4M20 7a9 9 0 1 0 1 9M20 7h-5',
  close: 'm6 6 12 12M6 18 18 6', go: 'M4 12h16m-6-6 6 6-6 6',
};
function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', paths[name] ?? paths.file); svg.append(p); return svg;
}
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

function controls() {
  const count = state.selected.size, one = selected()[0], busy = state.busy || state.loading;
  const disabled = {
    'new-folder': !writable() || busy, 'new-file': !writable() || busy, upload: !writable() || busy,
    copy: !count || busy, cut: !count || !writable() || busy, paste: !state.clipboard || !writable() || busy,
    rename: count !== 1 || !writable() || busy, trash: !count || !writable() || !system() || busy,
    duplicate: !count || !writable() || busy, zip: !count || !writable() || !system() || busy,
    extract: count !== 1 || one?.kind !== 'archive' || !writable() || !system() || busy,
    open: count !== 1 || !system() || busy, reveal: count !== 1 || !system() || busy, 'copy-path': count !== 1 || busy,
    back: state.historyIndex <= 0 || busy, forward: state.historyIndex >= state.history.length - 1 || busy,
    up: !state.path || state.path === state.parent || busy, refresh: !state.path || busy,
    'load-more': busy, 'select-all': !state.entries.length || busy,
  };
  for (const [id, value] of Object.entries(disabled)) $(id).disabled = value;
  document.querySelectorAll('#rows input[type="checkbox"]').forEach(node => { node.disabled = busy; });
  $('close-preview').disabled = state.busy;
  $('selection-count').textContent = count ? t('selected', { count }) : t('items', { count: state.entries.length });
  $('select-all').checked = Boolean(state.entries.length && count === state.entries.length);
  $('select-all').indeterminate = count > 0 && count < state.entries.length;
  $('path').disabled = state.busy; $('search').disabled = state.busy;
  $('selection-count').title = state.clipboard ? t('clipboard', { count: state.clipboard.paths.length, action: t(state.clipboard.kind === 'copy' ? 'copyVerb' : 'moveVerb') }) : '';
  document.querySelectorAll('#roots button').forEach(node => { node.disabled = state.busy; node.classList.toggle('active', node.dataset.path === state.path); });
}

function renderList() {
  const fragment = document.createDocumentFragment();
  for (const entry of state.entries) {
    const row = element('tr'); row.dataset.path = entry.path; row.classList.toggle('selected', state.selected.has(entry.path));
    const cell = element('td', undefined, 'select-cell');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(entry.path);
    checkbox.setAttribute('aria-label', `${t('select')} ${entry.name}`); checkbox.disabled = state.busy;
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && state.selected.size >= state.info.limits.maxPaths) { checkbox.checked = false; notice(t('tooMany', { count: state.info.limits.maxPaths }), true); return; }
      if (checkbox.checked) state.selected.add(entry.path); else state.selected.delete(entry.path);
      row.classList.toggle('selected', checkbox.checked); controls();
    });
    cell.append(checkbox); row.append(cell);
    const nameCell = element('td', undefined, 'name-cell');
    const open = element('button', undefined, 'entry-button'); open.type = 'button';
    open.append(icon(entry.isDir ? 'folder' : entry.kind === 'image' ? 'image' : 'file'));
    const nameText = element('span', entry.name); nameText.title = entry.path; open.append(nameText);
    open.addEventListener('click', () => void choose(entry));
    open.addEventListener('dblclick', () => { if (entry.isDir) void navigate(entry.path); });
    open.addEventListener('keydown', event => { if (event.key === 'Enter' && entry.isDir) { event.preventDefault(); void navigate(entry.path); } });
    nameCell.append(open);
    if (state.query) nameCell.append(element('small', entry.dirHint, 'entry-location'));
    row.append(nameCell, element('td', entry.isDir ? '—' : formatBytes(entry.size), 'size-cell'), element('td', date(entry.mtime), 'date-cell'));
    fragment.append(row);
  }
  $('rows').replaceChildren(fragment);
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
    const common = { path, offset: append ? state.entries.length : 0, limit: 200, showHidden: $('hidden-files').checked };
    const result = state.query
      ? await call('search', { ...common, query: state.query, content: $('content-search').checked, recursive: true }, { signal: listController.signal })
      : await call('list_dir', { ...common, sortBy: state.sortBy, sortDir: state.sortDir }, { signal: listController.signal });
    if (request !== state.request || disposed) return;
    const canonical = result.path ?? path;
    state.path = canonical; state.parent = result.parent ?? parentOf(canonical);
    state.entries = append ? [...state.entries, ...result.entries] : result.entries;
    state.hasMore = result.hasMore; state.selected = new Set([...state.selected].filter(p => state.entries.some(e => e.path === p)));
    $('path').value = canonical; $('heading').textContent = state.roots.find(r => r.path === canonical)?.label ?? canonical.split(/[/\\]/).filter(Boolean).at(-1) ?? t('title');
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
  if (state.busy || !await leaveDraft()) return;
  clearPreview(); state.query = ''; $('search').value = ''; $('clear-search').hidden = true;
  state.selected.clear(); await load({ path, historyIndex });
}

function clearPreview() {
  ++state.previewRequest; previewController?.abort();
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined;
  state.preview = null; renderPreview();
}
async function choose(entry) {
  if (state.busy || $('dialog').open || state.preview?.entry.path === entry.path) return;
  if (!await leaveDraft()) return;
  clearPreview(); const request = ++state.previewRequest;
  state.selected = new Set([entry.path]); renderList();
  state.preview = { entry, loading: true, editing: false }; renderPreview();
  previewController = new AbortController();
  try {
    let result, hint;
    if (entry.isDir) result = null;
    else if (entry.kind === 'text') result = await call('read_file', { path: entry.path }, { signal: previewController.signal });
    else if (entry.kind === 'archive' && system()) result = await call('archive_list', { path: entry.path }, { signal: previewController.signal });
    else if (['image', 'pdf', 'audio', 'video'].includes(entry.kind)) {
      if (entry.kind === 'pdf' && !navigator.pdfViewerEnabled) hint = t('pdfUnavailable');
      else if (entry.size > state.info.limits.maxPreviewBytes) hint = t('previewLimit');
      else {
        const method = entry.kind === 'image' ? 'image_preview' : entry.kind === 'pdf' ? 'pdf_preview' : 'media_preview';
        result = await call(method, { path: entry.path }, { signal: previewController.signal });
        if (atob(result.data).length < result.size) { result = undefined; hint = t('previewLimit'); }
      }
    } else hint = t('unsupported');
    if (request !== state.previewRequest || disposed) return;
    state.preview = { entry, result, hint, loading: false, editing: false, draft: result?.content };
  } catch (error) {
    if (request !== state.previewRequest || error.name === 'AbortError') return;
    state.preview = { entry, loading: false, hint: `${t('binaryError')} ${error.message}` };
  }
  renderPreview();
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
  } else if (result?.data) {
    objectUrl = URL.createObjectURL(previewBlob(result));
    const tag = entry.kind === 'image' ? 'img' : entry.kind === 'pdf' ? 'object' : entry.kind;
    const media = element(tag, undefined, 'media-preview');
    if (tag === 'object') { media.data = objectUrl; media.type = 'application/pdf'; }
    else media.src = objectUrl;
    if (tag === 'img') media.alt = entry.name;
    else if (tag === 'object') { media.title = entry.name; media.append(element('p', t('pdfUnavailable'), 'preview-hint')); }
    else media.controls = true;
    media.addEventListener('error', () => { media.replaceWith(element('p', t('binaryError'), 'preview-hint')); }, { once: true });
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

async function perform(action, refresh = true) {
  if (state.busy) return;
  state.busy = true; controls(); $('more').open = false;
  try {
    const result = await action();
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

function bind() {
  $('back').onclick = () => void navigate(state.history[state.historyIndex - 1], state.historyIndex - 1);
  $('forward').onclick = () => void navigate(state.history[state.historyIndex + 1], state.historyIndex + 1);
  $('up').onclick = () => void navigate(state.parent); $('refresh').onclick = () => void load();
  $('path-form').onsubmit = event => { event.preventDefault(); void navigate($('path').value.trim()); };
  $('search-form').onsubmit = event => { event.preventDefault(); state.query = $('search').value.trim(); $('clear-search').hidden = !state.query; void load(); };
  $('clear-search').onclick = () => { state.query = ''; $('search').value = ''; $('clear-search').hidden = true; void load(); };
  $('hidden-files').onchange = () => void load(); $('content-search').onchange = () => { if (state.query) void load(); };
  document.querySelectorAll('[data-sort]').forEach(node => node.onclick = () => {
    if (state.busy || state.loading) return;
    state.sortDir = state.sortBy === node.dataset.sort && state.sortDir === 'asc' ? 'desc' : 'asc'; state.sortBy = node.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach(item => item.parentElement.removeAttribute('aria-sort'));
    node.parentElement.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending'); void load();
  });
  $('load-more').onclick = () => void load({ append: true });
  $('select-all').onchange = () => { state.selected = new Set($('select-all').checked ? state.entries.slice(0, state.info.limits.maxPaths).map(e => e.path) : []); renderList(); };
  $('new-folder').onclick = () => void create('folder'); $('new-file').onclick = () => void create('file');
  $('upload').onclick = () => $('upload-input').click(); $('upload-input').onchange = event => { void startUpload([...event.target.files]); event.target.value = ''; };
  $('transfer-cancel').onclick = () => { uploadController?.abort(); $('transfer-cancel').disabled = true; };
  for (const kind of ['copy', 'cut']) $(kind).onclick = () => { state.clipboard = { kind: kind === 'copy' ? 'copy' : 'move', paths: selected().map(e => e.path) }; controls(); notice(t('clipboard', { count: state.clipboard.paths.length, action: t(kind === 'copy' ? 'copyVerb' : 'moveVerb') })); };
  $('paste').onclick = async () => {
    const clipboard = state.clipboard;
    if (!clipboard || !await leaveDraft()) return;
    const result = await perform(() => call(`${clipboard.kind}_batch`, { paths: clipboard.paths, dest: state.path }));
    if (result?.ok && clipboard.kind === 'move') state.clipboard = null;
    controls();
  };
  $('rename').onclick = async () => {
    const entry = selected()[0]; if (!entry || !await leaveDraft()) return;
    const name = await ask({ title: 'rename', label: 'name', value: entry.name, submit: 'rename' }); if (name === null) return;
    const result = await perform(() => call('rename', { path: entry.path, name })); if (result) clearPreview();
  };
  $('trash').onclick = async () => {
    if (!await leaveDraft()) return;
    const paths = selected().map(e => e.path);
    if (!await ask({ title: 'trashTitle', copy: t('trashHint', { count: paths.length }), submit: 'trash', danger: true })) return;
    const result = await perform(() => call('trash_batch', { paths })); if (result) clearPreview();
  };
  $('duplicate').onclick = () => void perform(() => call('duplicate_batch', { paths: selected().map(e => e.path) }));
  $('zip').onclick = async () => {
    const paths = selected().map(e => e.path);
    const name = await ask({ title: 'zip', label: 'zipName', value: 'Archive.zip', submit: 'zip' });
    if (name !== null) await perform(() => call('create_zip', { paths, dest: state.path, name }));
  };
  $('extract').onclick = async () => {
    const entry = selected()[0]; if (!entry) return;
    const dest = await ask({ title: 'extract', label: 'destination', value: state.path, submit: 'extract' });
    if (dest !== null) await perform(() => call('extract_archive', { path: entry.path, dest }));
  };
  $('copy-path').onclick = async () => { try { await navigator.clipboard.writeText(selected()[0].path); notice(t('copied')); } catch (error) { report(error); } };
  for (const method of ['open', 'reveal']) $(method).onclick = () => void perform(() => call(method, { path: selected()[0].path }), false);
  $('close-preview').onclick = async () => { if (await leaveDraft()) { clearPreview(); state.selected.clear(); renderList(); } };
  $('notice-close').onclick = () => { $('notice').hidden = true; };
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.preview?.editing) { event.preventDefault(); void saveText(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); $('path').focus(); $('path').select(); }
  });
  window.addEventListener('beforeunload', event => { if (dirty() || state.busy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { disposed = true; stopWatch?.(); clearTimeout(refreshTimer); listController?.abort(); previewController?.abort(); uploadController?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopWatch?.(); stopWatch = undefined; clearTimeout(refreshTimer); }
    else if (state.path) { connectWatch(); void load(); }
  });
}

async function boot() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; document.title = `${t('title')} · DSH Files`;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-label]').forEach(node => { const text = t(node.dataset.label); node.setAttribute('aria-label', text); node.title = text; if (node.tagName === 'INPUT') node.placeholder = text; });
  for (const id of ['back', 'forward', 'up', 'refresh']) $(id).append(icon(id));
  for (const id of ['clear-search', 'notice-close', 'close-preview']) $(id).append(icon('close', 16));
  $('path-form').querySelector('button').append(icon('go', 16)); $('search-icon').append(icon('search', 17));
  bind(); renderPreview(); controls();
  try {
    const [info, roots] = await Promise.all([describe(), call('roots')]); state.info = info;
    state.roots = roots.map(root => ({ ...root, label: t(root.id) === root.id ? root.name : t(root.id) }));
    for (const root of state.roots) {
      const item = element('button', undefined, 'place'); item.type = 'button'; item.dataset.path = root.path;
      item.append(icon('folder', 17), element('span', root.label)); item.onclick = () => void navigate(root.path); $('roots').append(item);
    }
    $('version').textContent = `v${info.pluginVersion}`; $('mode').textContent = !writable() ? t('readOnly') : !system() ? t('permission') : t('ready');
    await load({ path: roots.find(root => root.id === 'home')?.path ?? roots[0]?.path ?? '~' });
  } catch (error) { state.error = error.message; notice(`${t('bootError')}：${error.message}`, true); renderList(); }
}
void boot();

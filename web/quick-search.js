import { call, formatBytes } from './api.js';
import { t } from './locale.js';
import { fileIcon } from './icons.js';

/**
 * ⌘K global search overlay, modelled on the Fanbox command palette.
 *
 * Two switches, both keyboard first:
 * - scope (Tab): all configured roots (`locate`) ↔ the current folder
 *   (`search` with recursion);
 * - mode (button or a `内容:` / `content:` prefix, any colon width):
 *   filename fuzzy ↔ bounded full-text.
 *
 * Results stay bounded and cancellable: every keystroke aborts the previous
 * request (the transport maps aborts to the wire cancel commands), and only
 * the first page is shown. Selection is wrapped with ↑/↓, confirmed with
 * Enter (open) or ⌘/Ctrl+Enter (editor), dismissed with Esc or a backdrop
 * click. The module owns no file logic — outcomes are handed to callbacks.
 */

const MAX_RESULTS = 60;
const DEBOUNCE_MS = 150;

export const CONTENT_PREFIX = /^(?:内容|content)\s*[:：]/i;

/** Split a raw query into mode + terms without mutating the input box. */
export function parseQuery(raw) {
  const text = String(raw ?? '');
  const match = CONTENT_PREFIX.exec(text.trim());
  return match ? { content: true, query: text.trim().slice(match[0].length).trim() } : { content: false, query: text.trim() };
}

/** `~/a/b` form for result paths, keeping the home prefix compact. */
export function tildePath(path, home) {
  if (!home) return path;
  const clean = /[\\/]$/.test(home) ? home : `${home}/`;
  return path === home || path.startsWith(clean) ? `~${path.slice(home.length)}` : path;
}

/** Greedy subsequence highlight ranges so DOM text nodes never hold markup. */
export function matchRanges(name, query) {
  if (!query) return [];
  const haystack = name.toLowerCase(), needle = query.toLowerCase();
  const ranges = [];
  let cursor = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return [];
    if (ranges.length && ranges.at(-1)[1] === found) ranges.at(-1)[1] = found + 1;
    else ranges.push([found, found + 1]);
    cursor = found + 1;
  }
  return ranges;
}

export function createQuickSearch({ onOpen, onEditor, notice }) {
  let root, input, list, scopeButton, modeButton, pendingController, debounce;
  let scope = 'all'; // 'all' | 'here'
  let entries = [];
  let active = 0;
  let contextDir = '';
  let homePath = '';
  let contentMode = false;
  let visible = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function ensureDom() {
    if (root) return;
    root = element('div', undefined, 'quick-search');
    root.hidden = true;
    const panel = element('div', undefined, 'quick-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', t('quickSearch'));
    input = element('input', undefined, 'quick-input');
    input.type = 'text';
    input.placeholder = t('quickPlaceholder');
    input.setAttribute('aria-label', t('quickSearch'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    const switches = element('div', undefined, 'quick-switches');
    scopeButton = element('button', undefined, 'chip');
    scopeButton.type = 'button';
    scopeButton.addEventListener('click', () => { scope = scope === 'all' ? 'here' : 'all'; paintSwitches(); void run(true); input.focus(); });
    modeButton = element('button', undefined, 'chip');
    modeButton.type = 'button';
    modeButton.addEventListener('click', () => {
      const parsed = parseQuery(input.value);
      input.value = parsed.content ? parsed.query : `${t('contentPrefix')}${parsed.query}`.trim();
      void run(true);
      input.focus();
    });
    switches.append(scopeButton, modeButton);
    list = element('div', undefined, 'quick-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('quickResults'));
    const hint = element('p', t('quickHint'), 'quick-hint');
    panel.append(input, switches, list, hint);
    root.append(panel);
    document.body.append(root);
    input.addEventListener('input', () => void run());
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault();
        scope = event.shiftKey ? (scope === 'all' ? 'here' : 'all') : scope === 'all' ? 'here' : 'all';
        paintSwitches();
        void run(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (entries.length) {
          active = (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
          paintActive();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const entry = entries[active];
        if (entry) (event.metaKey || event.ctrlKey ? onEditor : onOpen)(entry);
      }
    });
    root.addEventListener('pointerdown', event => { if (!event.target.closest('.quick-panel')) hide(); });
  }

  function paintSwitches() {
    scopeButton.textContent = scope === 'all' ? t('quickScopeAll') : t('quickScopeHere');
    modeButton.textContent = contentMode ? t('quickModeContent') : t('quickModeName');
    modeButton.setAttribute('aria-pressed', String(contentMode));
  }

  function item(entry, index) {
    const row = element('button', undefined, 'quick-item');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.dataset.index = index;
    const artwork = element('span', undefined, 'quick-icon');
    artwork.append(fileIcon(entry));
    const copy = element('span', undefined, 'quick-copy');
    const name = element('span', undefined, 'quick-name');
    const parsed = parseQuery(input.value);
    const ranges = entry.contentHit ? [] : matchRanges(entry.name, parsed.query);
    if (!ranges.length) name.textContent = entry.name;
    else {
      let cursor = 0;
      for (const [start, end] of ranges) {
        if (start > cursor) name.append(entry.name.slice(cursor, start));
        name.append(element('mark', entry.name.slice(start, end)));
        cursor = end;
      }
      if (cursor < entry.name.length) name.append(entry.name.slice(cursor));
    }
    copy.append(name);
    if (entry.contentHit) for (const line of (entry.matchLines ?? []).slice(0, 3)) copy.append(element('span', line, 'quick-line'));
    const meta = element('span', `${tildePath(entry.dirHint ?? entry.path, homePath)} · ${t(entry.kind)}${entry.isDir ? '' : ` · ${formatBytes(entry.size)}`}`, 'quick-meta');
    row.append(artwork, copy, meta);
    row.addEventListener('click', () => onOpen(entry));
    row.addEventListener('mousemove', () => { if (active !== index) { active = index; paintActive(); } });
    return row;
  }

  function paintActive() {
    for (const row of list.querySelectorAll('.quick-item')) {
      const isActive = Number(row.dataset.index) === active;
      row.classList.toggle('active', isActive);
      row.setAttribute('aria-selected', String(isActive));
      if (isActive) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function paint(message) {
    list.replaceChildren();
    for (const [index, entry] of entries.entries()) list.append(item(entry, index));
    active = Math.min(active, Math.max(0, entries.length - 1));
    paintActive();
    const parsed = parseQuery(input.value);
    const note = message ?? (parsed.query ? (entries.length ? '' : t('quickNoResults')) : t('quickIdle'));
    if (note) list.append(element('p', note, 'quick-note'));
    paintSwitches();
  }

  async function run(immediate = false) {
    clearTimeout(debounce);
    const parsed = parseQuery(input.value);
    contentMode = parsed.content;
    if (!parsed.query) { entries = []; paint(); return; }
    // Scope decides the command: the current folder uses `search`; all
    // locations use `locate`, which covers the configured roots for both
    // filename and full-text queries.
    const here = scope === 'here' && contextDir;
    const params = here
      ? { path: contextDir, query: parsed.query, recursive: true, content: parsed.content, limit: MAX_RESULTS }
      : { query: parsed.query, content: parsed.content, limit: MAX_RESULTS };
    const execute = async () => {
      pendingController?.abort();
      pendingController = new AbortController();
      const signal = pendingController.signal;
      try {
        const result = await call(here ? 'search' : 'locate', params, { signal });
        if (signal.aborted) return;
        entries = (result.entries ?? []).map(entry => parsed.content ? { ...entry, contentHit: true } : entry);
        active = 0;
        paint(result.truncated ? t('quickTruncated') : undefined);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        entries = [];
        paint(error.message);
        notice?.(error);
      }
    };
    if (immediate) return execute();
    debounce = setTimeout(() => void execute(), DEBOUNCE_MS);
  }

  return {
    show({ dir = '', home = '' } = {}) {
      ensureDom();
      contextDir = dir;
      homePath = home;
      visible = true;
      root.hidden = false;
      input.value = '';
      entries = [];
      active = 0;
      paint();
      input.focus();
    },
    hide() {
      if (!visible) return;
      visible = false;
      if (root) root.hidden = true;
      pendingController?.abort();
      pendingController = undefined;
      clearTimeout(debounce);
    },
    toggle(options) { visible ? this.hide() : this.show(options); },
    get isOpen() { return visible; },
  };
}

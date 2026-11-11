/** Browser-only presentation state. No paths or file contents are persisted. */
export const VIEW_DEFAULTS = Object.freeze({ view: 'grid', size: 'medium', sortBy: 'name', sortDir: 'asc', preview: false, theme: 'system' });
export function sanitizeView(value = {}) {
  const options = { view: ['grid', 'list'], size: ['small', 'medium', 'large'], sortBy: ['name', 'mtime', 'size', 'kind'], sortDir: ['asc', 'desc'], theme: ['system', 'light', 'dark'] };
  const result = { ...VIEW_DEFAULTS };
  for (const [key, allowed] of Object.entries(options)) if (allowed.includes(value?.[key])) result[key] = value[key];
  if (typeof value?.preview === 'boolean') result.preview = value.preview;
  return result;
}
export function readView(storage) {
  try { return sanitizeView(JSON.parse(storage.getItem('dsh-files:view') ?? '{}')); }
  catch { return { ...VIEW_DEFAULTS }; }
}
export function writeView(storage, value) {
  try { storage.setItem('dsh-files:view', JSON.stringify(sanitizeView(value))); } catch { /* Session preferences still work when storage is blocked. */ }
}

export function pathSegments(value) {
  if (!value) return [];
  const windows = /^[a-z]:[/\\]/i.test(value) || /^\\\\/.test(value);
  const sep = windows && value.includes('\\') ? '\\' : '/';
  const normalized = value.replaceAll('\\', '/');
  let root = '/', rest = normalized.replace(/^\/+/, '');
  const drive = normalized.match(/^([a-z]:)\//i);
  const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (drive) { root = drive[1] + sep; rest = normalized.slice(3); }
  else if (unc) { root = `${sep}${sep}${unc[1]}${sep}${unc[2]}${sep}`; rest = normalized.slice(unc[0].length); }
  else if (!normalized.startsWith('/')) { root = ''; rest = normalized; }
  const parts = root ? [{ name: root, path: root }] : [];
  let current = root;
  for (const name of rest.split('/').filter(Boolean)) {
    current = current && !current.endsWith(sep) ? current + sep + name : current + name;
    parts.push({ name, path: current });
  }
  return parts;
}
export function parentPath(value) {
  const parts = pathSegments(value);
  return parts.at(-2)?.path ?? parts[0]?.path ?? value;
}
export function normalizePathInput(value) {
  const text = value.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!/^file:\/\//i.test(text)) return text;
  try {
    const url = new URL(text), pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') return `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}`;
    return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1).replaceAll('/', '\\') : pathname;
  } catch { return text; }
}

export function selectionFor(entries, previous, index, anchor, event, platform, limit) {
  const toggle = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  let next = new Set(toggle ? previous : []);
  if (event.shiftKey && anchor >= 0) {
    for (let i = Math.min(index, anchor); i <= Math.max(index, anchor); i++) next.add(entries[i].path);
  } else if (toggle && next.has(entries[index].path)) next.delete(entries[index].path);
  else next.add(entries[index].path);
  if (next.size > limit) return null;
  return { selected: next, anchor: event.shiftKey && anchor >= 0 ? anchor : index };
}

/** Map OS conventions without intercepting typing in editors or form controls. */
export function shortcutAction(event, platform, editing = false) {
  const mac = platform === 'darwin', mod = mac ? event.metaKey : event.ctrlKey, key = event.key.toLowerCase();
  if (mod && key === 's') return 'save';
  if (mod && key === 'l') return 'path';
  if (mod && key === 'f') return 'search';
  if (editing) return null;
  if (mod && event.shiftKey && key === 'n') return 'new-folder';
  if (mod && ['1', '2'].includes(key)) return key === '1' ? 'grid-view' : 'list-view';
  if (mod && ['a', 'c', 'x', 'v'].includes(key)) return ({ a: 'select-all', c: 'copy', x: 'cut', v: 'paste' })[key];
  if (mac && mod && key === 'backspace' || !mac && key === 'delete' && !event.shiftKey) return 'trash';
  if (mac && mod && key === 'arrowup' || !mac && event.altKey && key === 'arrowup') return 'up';
  if (mac && mod && key === '[' || !mac && event.altKey && key === 'arrowleft') return 'back';
  if (mac && mod && key === ']' || !mac && event.altKey && key === 'arrowright') return 'forward';
  if (!mac && key === 'f2' || mac && key === 'enter' && !mod) return 'rename';
  if (!mac && key === 'enter' || mac && mod && key === 'arrowdown') return 'activate';
  if (key === ' ') return 'quick-look';
  return null;
}

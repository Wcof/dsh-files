/** Explicit user bookmarks; separate from view preferences and navigation history. */
export const MAX_PLACES = 64;
export function placesKey(platform, home) { return `dsh-files:places:${JSON.stringify([platform, home])}`; }
export function placeIdentity(value, platform) {
  return platform === 'win32'
    ? value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : value.replace(/\/+$/, '') || '/';
}
export function resolvePlace(item, roots) {
  const root = item.root ? roots.find(root => root.id === item.root) : undefined;
  return { path: root?.path ?? item.path, label: item.label || root?.label, icon: root?.id ?? 'folder' };
}
export function normalizePlaces(items, roots, platform) {
  const seen = new Set(), result = [];
  for (const input of items.slice(0, MAX_PLACES)) {
    if (!input || typeof input !== 'object') continue;
    const item = {};
    if (typeof input.root === 'string' && roots.some(root => root.id === input.root)) item.root = input.root;
    else if (typeof input.path === 'string' && input.path.length <= 4096 && /^(\/|[a-z]:[\\/]|\\\\)/i.test(input.path) && !/[\x00-\x1f]/.test(input.path)) item.path = input.path;
    else continue;
    if (typeof input.label === 'string' && input.label.trim() && !/[\x00-\x1f]/.test(input.label)) item.label = input.label.trim().slice(0, 80);
    if (!item.root && !item.label) continue;
    const identity = placeIdentity(resolvePlace(item, roots).path, platform);
    if (seen.has(identity)) continue;
    seen.add(identity); result.push(item);
  }
  return result;
}
export function readPlaces(storage, key, roots, platform) {
  const defaults = () => roots.slice(0, MAX_PLACES).map(root => ({ root: root.id }));
  try {
    const raw = storage.getItem(key);
    if (raw === null) return defaults();
    const saved = JSON.parse(raw);
    return saved?.version === 1 && Array.isArray(saved.items) ? normalizePlaces(saved.items, roots, platform) : defaults();
  } catch { return defaults(); }
}
export function writePlaces(storage, key, items) {
  try { storage.setItem(key, JSON.stringify({ version: 1, items })); return true; }
  catch { return false; }
}
export function movePlace(items, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const result = [...items], [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
}

/** Convert a gap in the original list to an index after removing the dragged item. */
export function dropPosition(from, gap, count) { return Math.max(0, Math.min(count - 1, gap > from ? gap - 1 : gap)); }

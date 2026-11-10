const API = '/agent/files';
const cancellation = { search: 'search_cancel', locate: 'locate_cancel', read_file: 'preview_cancel', image_preview: 'preview_cancel', pdf_preview: 'preview_cancel', media_preview: 'preview_cancel', copy_batch: 'batch_cancel', move_batch: 'batch_cancel', trash_batch: 'batch_cancel', duplicate_batch: 'batch_cancel' };

export async function call(method, params = {}, options = {}) {
  const id = crypto.randomUUID();
  const cancel = () => {
    if (cancellation[method]) void fetch(`${API}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true,
      body: JSON.stringify({ id: crypto.randomUUID(), method: cancellation[method], params: { requestId: id } }),
    }).catch(() => {});
  };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(`${API}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ id, method, params }), signal: options.signal, keepalive: options.keepalive,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Request failed');
    return body.result;
  } finally { options.signal?.removeEventListener('abort', cancel); }
}

export async function describe() {
  const response = await fetch(`${API}/describe`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function watch(path, onChange, onState) {
  const events = new EventSource(`${API}/events?path=${encodeURIComponent(path)}`);
  events.onopen = () => { onState(true); onChange(); };
  events.onerror = () => onState(false);
  for (const event of ['changed', 'fs_changed']) events.addEventListener(event, onChange);
  return () => events.close();
}

export function toBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

export function previewBlob(result) {
  const raw = atob(result.data);
  return new Blob([Uint8Array.from(raw, char => char.charCodeAt(0))], { type: result.mimeType });
}

export async function upload(file, parent, limits, signal, progress) {
  if (file.size > limits.maxImportBytes) throw new Error('File exceeds the upload limit');
  const uploadId = `upload-${crypto.randomUUID()}`;
  let begun = false;
  let committed = false;
  try {
    signal.throwIfAborted();
    // Do not abort begin/end mid-flight: wait for their outcome before cleanup.
    const session = await call('import_begin', { uploadId, parent, name: file.name, size: file.size, conflict: 'rename' });
    begun = true;
    const chunkSize = Math.min(256 * 1024, Math.floor(limits.maxImportChunkBase64 / 4) * 3);
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      await call('import_chunk', { uploadId, offset, data: toBase64(bytes) });
      progress(Math.min(offset + bytes.length, file.size));
    }
    signal.throwIfAborted();
    const result = await call('import_end', { uploadId });
    committed = true;
    return { ...result, name: session.name, renamed: session.renamed };
  } finally {
    if (begun && !committed) await call('import_cancel', { uploadId }, { keepalive: true });
  }
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function parentOf(value) {
  const trimmed = value.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return value;
  return trimmed.slice(0, index) || '/';
}

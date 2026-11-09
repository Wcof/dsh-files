/**
 * Type / project / metadata helpers.
 * Port of `file-manager-core/src/file_manager/detect.rs`.
 */

import path from 'node:path';

const EXTENSIONLESS_TEXT = new Set([
  'Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'CHANGELOG', 'README',
  'LICENSE', 'VERSION', 'Procfile', '.env', '.gitignore', '.dockerignore', '.editorconfig',
]);

const TEXT_EXT = new Set([
  'txt', 'md', 'mdx', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml',
  'csv', 'log', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerignore',
  'editorconfig', 'graphql', 'gql', 'sql', 'vue', 'svelte', 'astro',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyw', 'rb', 'rs', 'go',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'kts', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'bat', 'cmd', 'php', 'scala',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
]);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'wma']);
const ARCHIVE_EXT = new Set(['zip', 'jar', 'tar', 'gz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tgz', 'tbz2', 'tzst']);

export function detectFileKind(name, isDir = false) {
  if (isDir) return 'dir';
  const base = path.basename(name);
  if (EXTENSIONLESS_TEXT.has(base)) return 'text';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  return 'other';
}

export function detectProjectBadge(names) {
  const lower = new Set(names.map((name) => name.toLowerCase()));
  if (lower.has('package.json')) return 'node';
  if (lower.has('index.html')) return 'web';
  if (lower.has('requirements.txt') || lower.has('setup.py') || lower.has('pyproject.toml')) return 'python';
  if (lower.has('cargo.toml')) return 'rust';
  if (lower.has('go.mod')) return 'go';
  if (lower.has('.git')) return 'git';
  return undefined;
}

/** Rust `natural_cmp`: case-insensitive text, numeric-aware digit runs. */
export function naturalCompare(a, b) {
  const left = String(a);
  const right = String(b);
  let i = 0;
  let j = 0;
  for (;;) {
    if (i >= left.length && j >= right.length) return 0;
    if (i >= left.length) return -1;
    if (j >= right.length) return 1;
    const ac = left[i];
    const bc = right[j];
    const ad = ac >= '0' && ac <= '9';
    const bd = bc >= '0' && bc <= '9';
    if (ad && bd) {
      let an = 0n;
      let bn = 0n;
      while (i < left.length && left[i] >= '0' && left[i] <= '9') {
        an = an * 10n + BigInt(left[i++] - '0');
      }
      while (j < right.length && right[j] >= '0' && right[j] <= '9') {
        bn = bn * 10n + BigInt(right[j++] - '0');
      }
      if (an !== bn) return an < bn ? -1 : 1;
    } else {
      const al = ac.toLowerCase();
      const bl = bc.toLowerCase();
      if (al !== bl) return al < bl ? -1 : 1;
      i += 1;
      j += 1;
    }
  }
}

export function mtimeMs(stats) {
  return stats?.mtimeMs ?? 0;
}

export function btimeMs(stats) {
  return stats?.birthtimeMs ?? 0;
}

export function mimeTypeFor(kind, name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (kind === 'image') {
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
      tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
    };
    return map[ext] ?? 'application/octet-stream';
  }
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'audio' || kind === 'video') {
    return `${kind}/${ext === 'mp3' ? 'mpeg' : ext}`;
  }
  return 'application/octet-stream';
}

const MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46], mime: 'image/gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
];

/** Basic magic-byte guard used by binary previews (see preview.rs). */
export function hasRecognizedHeader(buffer) {
  if (buffer.length < 4) return false;
  return MAGIC.some((entry) => entry.bytes.every((byte, index) => buffer[index] === byte));
}

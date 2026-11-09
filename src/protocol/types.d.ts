/**
 * Public wire contract of @dsh/files.
 *
 * These shapes are a hand-maintained mirror of the original AiNative Rust
 * structs (`crates/file-manager-core/src/file_manager/mod.rs:48-161`) and are
 * checked against COMMANDS by `npm run check`. The old
 * `AiNative/src/types/generated/*.ts` files are stale ts-rs leftovers and are
 * deliberately NOT reused.
 */

export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'dir' | 'other';
export type ProjectBadge = 'node' | 'web' | 'python' | 'rust' | 'go' | 'git';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  kind: FileKind;
  hidden: boolean;
  size: number;
  /** milliseconds since epoch */
  mtime: number;
  /** milliseconds since epoch (birth time) */
  btime: number;
  symlink?: string;
  projectBadge?: ProjectBadge;
  dirHint?: string;
}

export interface ListDirOptions {
  sortBy?: 'name' | 'size' | 'mtime';
  sortDir?: 'asc' | 'desc';
  showHidden?: boolean;
  probeProjects?: boolean;
}

export interface ListDirResult {
  path: string;
  parent: string;
  entries: FileEntry[];
  project?: string;
  hasMore?: boolean;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
  kind: string;
  encoding: string;
}

export interface WriteResult {
  path?: string;
  mtime: number;
  conflict: boolean;
}

export interface StatResult {
  found: boolean;
  path: string;
  name?: string;
  isDir?: boolean;
  kind?: FileKind;
  size?: number;
  mtime?: number;
  btime?: number;
  symlink?: string;
  dirHint?: string;
}

export interface PreviewResult {
  /** base64 encoded bytes */
  data: string;
  mimeType: string;
  size: number;
  mtime: number;
}

export interface DiskUsageItem {
  name: string;
  size: number;
  isDir: boolean;
}

export interface DiskUsageResult {
  path: string;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
  errors: number;
  items: DiskUsageItem[];
}

export interface SearchEntry extends FileEntry {
  match?: string;
  matchCount?: number;
  matchLines?: string[];
  searchScore?: number;
}

export interface SearchResult {
  entries: SearchEntry[];
  hasMore: boolean;
  truncated: boolean;
  contentUnavailable: boolean;
}

export interface BatchResult {
  ok: boolean;
  copied?: string[];
  moved?: string[];
  duplicated?: string[];
  trashed?: string[];
  skipped?: string[];
  errors: Array<{ path: string; error: string }>;
  count: number;
  cancelled?: boolean;
}

/** The one request/response envelope shared by every adapter. */
export interface FileRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface FileResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  /** plain string, masked by safeMessage when the error is internal */
  error?: string;
}

export interface PluginInfo {
  pluginVersion: string;
  protocolVersion: number;
  backend: string;
  methods: string[];
  capabilities: {
    os: boolean;
    write: boolean;
    systemCommands: boolean;
  };
}

/** Minimal structural view of FileService for adapter authors (no JS import). */
export interface FileServiceLike {
  call(method: string, params?: Record<string, unknown>, options?: object): Promise<unknown>;
  handle(request: FileRequest): Promise<FileResponse>;
  tools(): unknown[];
  describe(): Record<string, unknown>;
  on(type: string, listener: (payload: unknown) => void): () => void;
}

/** Unified host adapter contract. See docs/AGENT_ADAPTERS.md. */
export interface HostAdapter {
  name: string;
  start(context: {
    service: FileServiceLike;
    config: unknown;
    log: (...args: unknown[]) => void;
  }): Promise<unknown>;
  stop(): Promise<void>;
  describe(): Record<string, unknown>;
}

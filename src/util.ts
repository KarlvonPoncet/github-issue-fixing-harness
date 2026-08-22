import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export class HarnessError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = 'error', exitCode = 1) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class SchemaError extends HarnessError {
  constructor(message: string) {
    super(message, 'invalid_schema', 2);
    this.name = 'SchemaError';
  }
}

export const nowIso = (): string => new Date().toISOString();

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function ensureRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function ensureString(
  value: unknown,
  path: string,
  options: { max?: number; nonEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string' || (options.nonEmpty && value.trim() === '')) {
    throw new SchemaError(`${path} must be a ${options.nonEmpty ? 'non-empty ' : ''}string`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new SchemaError(`${path} exceeds ${options.max} characters`);
  }
  return value;
}

export function ensureNumber(
  value: unknown,
  path: string,
  options: { integer?: boolean; min?: number } = {},
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options.integer && !Number.isInteger(value))
  ) {
    throw new SchemaError(`${path} must be a finite${options.integer ? ' integer' : ''} number`);
  }
  if (options.min !== undefined && value < options.min)
    throw new SchemaError(`${path} is too small`);
  return value;
}

export function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SchemaError(`${path} must be a boolean`);
  return value;
}

export function ensureArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(`${path} must be an array`);
  return value;
}

export function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new SchemaError(`${path}.${key} is not a recognized field`);
  }
}

export function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new SchemaError(`${path} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function recoverAtomicJson<T>(path: string): Promise<T | undefined> {
  const value = await readJson<T>(path);
  if (value !== undefined) return value;
  return undefined;
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export function safeRelativePath(root: string, requested: string): string {
  if (requested.includes('\0') || isAbsolute(requested)) {
    throw new HarnessError('path must be relative to the workspace', 'unsafe_path', 2);
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, requested);
  const rel = relative(rootResolved, target);
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new HarnessError('path escapes the workspace', 'unsafe_path', 2);
  }
  return target;
}

export async function assertPrivateFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0)
      throw new HarnessError(`credential file is not private: ${path}`, 'insecure_credentials');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

function toonScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_./:@+\-]+$/.test(value) && value !== 'null') return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Small deterministic TOON encoder for the CLI boundary. */
export function toToon(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (value === null || typeof value !== 'object') return toonScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return `[${value.map(toonScalar).join(',')}]`;
    }
    return value
      .map((item) => {
        const lines = toToon(item, indent + 2).split('\n');
        const first = lines.shift()?.trimStart() ?? '';
        return [`${pad}- ${first}`, ...lines].join('\n');
      })
      .join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries
    .map(([key, item]) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        return `${pad}${key}:\n${toToon(item, indent + 2)}`;
      }
      if (
        Array.isArray(item) &&
        item.length > 0 &&
        item.some((entry) => entry !== null && typeof entry === 'object')
      ) {
        return `${pad}${key}[${item.length}]:\n${toToon(item, indent + 2)}`;
      }
      return `${pad}${key}: ${toToon(item, indent + 2)}`;
    })
    .join('\n');
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_API_KEY]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{16,})\b/g,
      '[REDACTED_GITHUB_TOKEN]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token|cookie|session[_-]?token|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token)\s*=\s*["']?)([^\s"',;}{]{8,})/gi,
      '$1[REDACTED_SECRET]',
    )
    .replace(
      /(["'](?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token|cookie|session[_-]?token|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token)["']\s*:\s*["'])([^"']{8,})(["'])/gi,
      '$1[REDACTED_SECRET]$3',
    );
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isInteger(ms) || ms < 1)
    return Promise.reject(
      new HarnessError(`${label} timeout must be positive`, 'invalid_timeout', 2),
    );
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new HarnessError(`${label} timed out after ${ms}ms`, 'timeout'));
      }
    }, ms);
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new HarnessError(`${label} was cancelled`, 'cancelled'));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

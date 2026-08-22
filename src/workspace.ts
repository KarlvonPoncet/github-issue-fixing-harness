import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, relative, resolve, sep } from 'node:path';
import { HarnessError, redactSecrets, safeRelativePath, sha256, withTimeout } from './util.js';

const execFileAsync = promisify(execFile);

export interface CommandSpec {
  name: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  maxOutputChars: number;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class Workspace {
  readonly root: string;
  private readonly allowedCommands: Set<string>;
  private readonly allowedPaths: string[];
  private readonly commandInputPaths: string[];
  private readonly forbiddenPaths: string[];
  private readonly maxOutputChars: number;
  private readonly maxPatchBytes: number;

  constructor(options: {
    root: string;
    allowedCommands: string[];
    allowedPaths: string[];
    commandInputPaths?: string[];
    forbiddenPaths: string[];
    maxOutputChars?: number;
    maxPatchBytes?: number;
  }) {
    this.root = resolve(options.root);
    this.allowedCommands = new Set(options.allowedCommands);
    this.allowedPaths = options.allowedPaths;
    this.commandInputPaths = options.commandInputPaths ?? [];
    this.forbiddenPaths = options.forbiddenPaths;
    this.maxOutputChars = options.maxOutputChars ?? 50_000;
    this.maxPatchBytes = options.maxPatchBytes ?? 1_000_000;
  }

  private async assertAllowed(requested: string): Promise<string> {
    return this.assertPathAllowed(requested, this.allowedPaths);
  }

  private async assertCommandInputAllowed(requested: string): Promise<string> {
    return this.assertPathAllowed(requested, [...this.allowedPaths, ...this.commandInputPaths]);
  }

  private async assertPathAllowed(requested: string, allowedPaths: string[]): Promise<string> {
    const absolute = safeRelativePath(this.root, requested);
    const rel = relative(this.root, absolute).split(sep).join('/');
    if (this.forbiddenPaths.some((pattern) => matchesPath(rel, pattern)))
      throw new HarnessError(`forbidden path: ${requested}`, 'forbidden_path', 2);
    if (
      allowedPaths.length > 0 &&
      !allowedPaths.some((pattern) => matchesPath(rel, pattern))
    )
      throw new HarnessError(`path is outside the allowlist: ${requested}`, 'path_not_allowed', 2);
    const rootReal = await realpath(this.root);
    const targetReal = await realpath(absolute);
    const realRelative = relative(rootReal, targetReal);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${sep}`) ||
      realRelative.startsWith(sep)
    )
      throw new HarnessError('path escapes the workspace through a symlink', 'unsafe_path', 2);
    return absolute;
  }

  async inspect(
    requested: string,
    maxBytes = 50_000,
  ): Promise<{ path: string; content: string; sha256: string; truncated: boolean }> {
    const absolute = await this.assertAllowed(requested);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxOutputChars)
      throw new HarnessError('inspect maxBytes is outside the bound', 'invalid_bound', 2);
    const data = await readFile(absolute);
    const content = data.subarray(0, maxBytes).toString('utf8');
    return {
      path: requested,
      content: redactSecrets(content),
      sha256: sha256(data),
      truncated: data.byteLength > maxBytes,
    };
  }

  async list(requested = '.', maxEntries = 200): Promise<string[]> {
    const absolute = await this.assertAllowed(requested);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries
      .slice(0, maxEntries)
      .map(
        (entry) =>
          `${requested === '.' ? '' : `${requested}/`}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      )
      .sort();
  }

  async exactEdit(
    requested: string,
    expectedSha256: string,
    replacement: string,
  ): Promise<{ path: string; sha256: string; bytes: number }> {
    const absolute = await this.assertAllowed(requested);
    if (Buffer.byteLength(replacement) > this.maxPatchBytes)
      throw new HarnessError('edit exceeds patch byte budget', 'patch_too_large', 2);
    if (redactSecrets(replacement) !== replacement)
      throw new HarnessError('edit contains secret-like material', 'secret_rejected', 2);
    const original = await readFile(absolute);
    if (sha256(original) !== expectedSha256)
      throw new HarnessError(`edit precondition failed for ${requested}`, 'edit_conflict', 1);
    if (replacement.includes('\0'))
      throw new HarnessError('NUL bytes are not allowed in text edits', 'invalid_edit', 2);
    await writeFile(absolute, replacement, {
      encoding: 'utf8',
      mode: (await stat(absolute)).mode & 0o777,
    });
    return { path: requested, sha256: sha256(replacement), bytes: Buffer.byteLength(replacement) };
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    if (!this.allowedCommands.has(spec.name))
      throw new HarnessError(`command is not allowlisted: ${spec.name}`, 'command_not_allowed', 2);
    const rule = commandRule(spec.name);
    if (!rule)
      throw new HarnessError(
        `command has no safe allowlisted form: ${spec.name}`,
        'command_not_allowed',
        2,
      );
    if (
      spec.executable !== rule.executable ||
      !rule.args.every((arg, index) => spec.args[index] === arg)
    )
      throw new HarnessError(
        `command does not match the allowlisted form: ${spec.name}`,
        'command_not_allowed',
        2,
      );
    if (spec.name === 'git-diff') {
      const expected = ['git', 'diff', '--no-ext-diff', '--binary', '--', ...this.allowedPaths];
      if (JSON.stringify([spec.executable, ...spec.args]) !== JSON.stringify(expected))
        throw new HarnessError(
          'git-diff may only inspect the configured workspace paths',
          'command_not_allowed',
          2,
        );
    } else {
      for (const path of spec.args.slice(rule.args.length))
        await this.assertCommandInputAllowed(path);
    }
    if (spec.args.some((arg) => arg.includes('\0')))
      throw new HarnessError('command argument contains NUL', 'invalid_command', 2);
    if ([spec.executable, ...spec.args].some((part) => redactSecrets(part) !== part))
      throw new HarnessError('command contains secret-like material', 'secret_rejected', 2);
    const started = Date.now();
    const child = execFileAsync(spec.executable, spec.args, {
      cwd: this.root,
      env: safeEnvironment(this.root),
      timeout: spec.timeoutMs,
      maxBuffer: Math.max(1, Math.min(spec.maxOutputChars, this.maxOutputChars)) * 2,
      windowsHide: true,
    });
    try {
      const result = await withTimeout(child, spec.timeoutMs + 250, `command ${spec.name}`);
      return {
        command: [spec.executable, ...spec.args].join(' '),
        exitCode: 0,
        stdout: redactSecrets(truncate(result.stdout, spec.maxOutputChars)),
        stderr: redactSecrets(truncate(result.stderr, spec.maxOutputChars)),
        durationMs: Date.now() - started,
        timedOut: false,
      };
    } catch (error) {
      const e = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
        message?: string;
      };
      const timedOut =
        e.code === 'ETIMEDOUT' ||
        e.signal === 'SIGTERM' ||
        e.message?.includes('timed out') === true;
      return {
        command: [spec.executable, ...spec.args].join(' '),
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: redactSecrets(truncate(e.stdout ?? '', spec.maxOutputChars)),
        stderr: redactSecrets(truncate(e.stderr ?? e.message ?? '', spec.maxOutputChars)),
        durationMs: Date.now() - started,
        timedOut,
      };
    }
  }

  async diff(): Promise<string> {
    const result = await this.run({
      name: 'git-diff',
      executable: 'git',
      args: ['diff', '--no-ext-diff', '--binary', '--', ...this.allowedPaths],
      timeoutMs: 10_000,
      maxOutputChars: this.maxPatchBytes,
    });
    if (result.exitCode !== 0)
      throw new HarnessError('could not collect workspace patch', 'diff_failed');
    if (Buffer.byteLength(result.stdout) > this.maxPatchBytes)
      throw new HarnessError('workspace patch exceeds the configured limit', 'patch_too_large');
    return result.stdout;
  }
}

function commandRule(name: string): { executable: string; args: string[] } | undefined {
  if (name === 'public-test' || name === 'node-test')
    return { executable: 'node', args: ['--test'] };
  if (name === 'python-test') return { executable: 'python3', args: ['-m', 'unittest'] };
  if (name === 'git-diff') return { executable: 'git', args: ['diff'] };
  return undefined;
}

function matchesPath(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.endsWith('/**'))
    return path === normalized.slice(0, -3) || path.startsWith(`${normalized.slice(0, -3)}/`);
  if (normalized.includes('*')) {
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(path);
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}

function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n... (truncated, ${value.length} chars total)`;
}

function safeEnvironment(root: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL'])
    if (process.env[key]) result[key] = process.env[key];
  result.HOME = join(root, '.harness-home');
  result.TMPDIR = join(root, '.harness-tmp');
  result.HARNESS = '1';
  return result;
}

export async function makeWorkspace(
  root: string,
  policy: {
    allowedCommands: string[];
    allowedPaths: string[];
    commandInputPaths?: string[];
    forbiddenPaths: string[];
    maxOutputChars?: number;
    maxPatchBytes?: number;
  },
): Promise<Workspace> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, '.harness-home'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, '.harness-tmp'), { recursive: true, mode: 0o700 });
  return new Workspace({ root, ...policy });
}

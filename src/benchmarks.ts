import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, relative } from 'node:path';
import { SCHEMA_VERSION } from './schema.js';
import type { CheckOutcome, GradingEvidence, ProviderModelProfile } from './schema.js';
import {
  aggregateUsage,
  notApplicableUsage,
  parseUsageSummary,
  type UsageSummary,
} from './usage.js';
import { HarnessError, atomicWrite, nowIso, redactSecrets, sha256, withTimeout } from './util.js';

const execFileAsync = promisify(execFile);

export interface BenchmarkTaskView {
  id: string;
  language: 'typescript' | 'python';
  title: string;
  issue: string;
  baseState: string;
  publicCommands: string[];
  allowedPaths: string[];
}

interface BenchmarkTask extends BenchmarkTaskView {
  baseFiles: Record<string, string>;
  solutionFiles: Record<string, string>;
  hiddenFiles: Record<string, string>;
  hiddenCommands: string[];
}

const tasks: BenchmarkTask[] = [
  {
    id: 'ts-addition',
    language: 'typescript',
    title: 'Correct addition',
    issue: 'The add helper returns the wrong result for ordinary integer inputs.',
    baseState: 'frozen-ts-addition-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { add } from "./math.ts";\n',
      'src/math.ts': 'export function add(a: number, b: number): number { return a - b; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "../src/index.ts";\ntest("adds", () => assert.equal(add(4, 2), 6));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { add } from "./math.ts";\n',
      'src/math.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "../src/index.ts";\ntest("adds", () => assert.equal(add(4, 2), 6));\n',
    },
    hiddenFiles: {
      'test/hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { add } from "../src/index.ts"; test("negative",()=>assert.equal(add(-3,2),-1));\n',
    },
    hiddenCommands: ['node --test test/hidden.mjs'],
  },
  {
    id: 'ts-positive',
    language: 'typescript',
    title: 'Reject negative values',
    issue: 'parsePositive must reject zero and negative values instead of returning them.',
    baseState: 'frozen-ts-positive-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { parsePositive } from "./parse.ts";\n',
      'src/parse.ts':
        'export function parsePositive(value: string): number { return Number(value); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parsePositive } from "../src/index.ts"; test("rejects zero",()=>assert.throws(()=>parsePositive("0")));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { parsePositive } from "./parse.ts";\n',
      'src/parse.ts':
        'export function parsePositive(value: string): number { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error("positive value required"); return n; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parsePositive } from "../src/index.ts"; test("rejects zero",()=>assert.throws(()=>parsePositive("0")));\n',
    },
    hiddenFiles: {
      'test/hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parsePositive } from "../src/index.ts"; test("rejects negative and NaN",()=>{assert.throws(()=>parsePositive("-1")); assert.throws(()=>parsePositive("nope"));});\n',
    },
    hiddenCommands: ['node --test test/hidden.mjs'],
  },
  {
    id: 'ts-format-email',
    language: 'typescript',
    title: 'Format contact',
    issue: 'formatContact should include the email in angle brackets when one is present.',
    baseState: 'frozen-ts-format-email-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { formatContact } from "./contact.ts";\n',
      'src/contact.ts':
        'export function formatContact(name: string, email?: string): string { return name; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { formatContact } from "../src/index.ts"; test("formats email",()=>assert.equal(formatContact("Ada", "ada@example.test"), "Ada <ada@example.test>"));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { formatContact } from "./contact.ts";\n',
      'src/contact.ts':
        'export function formatContact(name: string, email?: string): string { return email ? `${name} <${email}>` : name; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { formatContact } from "../src/index.ts"; test("formats email",()=>assert.equal(formatContact("Ada", "ada@example.test"), "Ada <ada@example.test>"));\n',
    },
    hiddenFiles: {
      'test/hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { formatContact } from "../src/contact.ts"; test("omits missing email",()=>assert.equal(formatContact("Ada"), "Ada"));\n',
    },
    hiddenCommands: ['node --test test/hidden.mjs'],
  },
  {
    id: 'ts-unique',
    language: 'typescript',
    title: 'Stable unique values',
    issue: 'uniqueValues should remove duplicates while preserving the first-seen order.',
    baseState: 'frozen-ts-unique-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { uniqueValues } from "./unique.ts";\n',
      'src/unique.ts':
        'export function uniqueValues(values: string[]): string[] { return [...values].sort(); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { uniqueValues } from "../src/index.ts"; test("keeps order",()=>assert.deepEqual(uniqueValues(["b","a","b"]), ["b","a"]));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { uniqueValues } from "./unique.ts";\n',
      'src/unique.ts':
        'export function uniqueValues(values: string[]): string[] { return [...new Set(values)]; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { uniqueValues } from "../src/index.ts"; test("keeps order",()=>assert.deepEqual(uniqueValues(["b","a","b"]), ["b","a"]));\n',
    },
    hiddenFiles: {
      'test/hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { uniqueValues } from "../src/index.ts"; test("empty and triples",()=>assert.deepEqual(uniqueValues(["x","x","x"]), ["x"]));\n',
    },
    hiddenCommands: ['node --test test/hidden.mjs'],
  },
  {
    id: 'ts-config-zero',
    language: 'typescript',
    title: 'Preserve zero configuration',
    issue:
      'readLimit must preserve an explicitly configured zero and only use the default when the value is absent.',
    baseState: 'frozen-ts-config-zero-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { readLimit } from "./config.ts";\n',
      'src/config.ts':
        'export function readLimit(value?: number): number { return value || 100; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { readLimit } from "../src/index.ts"; test("keeps zero",()=>assert.equal(readLimit(0),0));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { readLimit } from "./config.ts";\n',
      'src/config.ts':
        'export function readLimit(value?: number): number { return value ?? 100; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { readLimit } from "../src/index.ts"; test("keeps zero",()=>assert.equal(readLimit(0),0));\n',
    },
    hiddenFiles: {
      'test/hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { readLimit } from "../src/index.ts"; test("default absent",()=>assert.equal(readLimit(),100));\n',
    },
    hiddenCommands: ['node --test test/hidden.mjs'],
  },
  {
    id: 'py-addition',
    language: 'python',
    title: 'Correct Python addition',
    issue: 'The Python add helper subtracts instead of adding.',
    baseState: 'frozen-py-addition-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def add(a, b):\n    return a - b\n',
      'test_public.py':
        'import unittest\nfrom src.app import add\nclass Public(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(4, 2), 6)\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def add(a, b):\n    return a + b\n',
      'test_public.py':
        'import unittest\nfrom src.app import add\nclass Public(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(4, 2), 6)\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import add\nclass Hidden(unittest.TestCase):\n    def test_negative(self): self.assertEqual(add(-3, 2), -1)\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-positive',
    language: 'python',
    title: 'Validate positive Python input',
    issue: 'parse_positive must reject zero and negative integers.',
    baseState: 'frozen-py-positive-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def parse_positive(value):\n    return int(value)\n',
      'test_public.py':
        'import unittest\nfrom src.app import parse_positive\nclass Public(unittest.TestCase):\n    def test_zero(self):\n        with self.assertRaises(ValueError): parse_positive("0")\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def parse_positive(value):\n    number = int(value)\n    if number <= 0: raise ValueError("positive value required")\n    return number\n',
      'test_public.py':
        'import unittest\nfrom src.app import parse_positive\nclass Public(unittest.TestCase):\n    def test_zero(self):\n        with self.assertRaises(ValueError): parse_positive("0")\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import parse_positive\nclass Hidden(unittest.TestCase):\n    def test_negative(self):\n        with self.assertRaises(ValueError): parse_positive("-2")\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-format-email',
    language: 'python',
    title: 'Format Python contact',
    issue: 'format_contact should include an optional email address.',
    baseState: 'frozen-py-format-email-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def format_contact(name, email=None):\n    return name\n',
      'test_public.py':
        'import unittest\nfrom src.app import format_contact\nclass Public(unittest.TestCase):\n    def test_email(self): self.assertEqual(format_contact("Ada", "ada@example.test"), "Ada <ada@example.test>")\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def format_contact(name, email=None):\n    return f"{name} <{email}>" if email else name\n',
      'test_public.py':
        'import unittest\nfrom src.app import format_contact\nclass Public(unittest.TestCase):\n    def test_email(self): self.assertEqual(format_contact("Ada", "ada@example.test"), "Ada <ada@example.test>")\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import format_contact\nclass Hidden(unittest.TestCase):\n    def test_no_email(self): self.assertEqual(format_contact("Ada"), "Ada")\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-unique',
    language: 'python',
    title: 'Stable Python uniqueness',
    issue: 'unique_values should remove duplicate entries without sorting them.',
    baseState: 'frozen-py-unique-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def unique_values(values):\n    return sorted(set(values))\n',
      'test_public.py':
        'import unittest\nfrom src.app import unique_values\nclass Public(unittest.TestCase):\n    def test_order(self): self.assertEqual(unique_values(["b", "a", "b"]), ["b", "a"])\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def unique_values(values):\n    return list(dict.fromkeys(values))\n',
      'test_public.py':
        'import unittest\nfrom src.app import unique_values\nclass Public(unittest.TestCase):\n    def test_order(self): self.assertEqual(unique_values(["b", "a", "b"]), ["b", "a"])\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import unique_values\nclass Hidden(unittest.TestCase):\n    def test_empty(self): self.assertEqual(unique_values([]), [])\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-config-zero',
    language: 'python',
    title: 'Preserve Python zero configuration',
    issue: 'read_limit must preserve zero rather than treating it as missing.',
    baseState: 'frozen-py-config-zero-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def read_limit(value=None):\n    return value or 100\n',
      'test_public.py':
        'import unittest\nfrom src.app import read_limit\nclass Public(unittest.TestCase):\n    def test_zero(self): self.assertEqual(read_limit(0), 0)\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def read_limit(value=None):\n    return 100 if value is None else value\n',
      'test_public.py':
        'import unittest\nfrom src.app import read_limit\nclass Public(unittest.TestCase):\n    def test_zero(self): self.assertEqual(read_limit(0), 0)\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import read_limit\nclass Hidden(unittest.TestCase):\n    def test_default(self): self.assertEqual(read_limit(), 100)\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
];

export function listBenchmarkTasks(): BenchmarkTaskView[] {
  return tasks.map(({ id, language, title, issue, baseState, publicCommands, allowedPaths }) => ({
    id,
    language,
    title,
    issue,
    baseState,
    publicCommands,
    allowedPaths,
  }));
}

export function getBenchmarkTask(id: string): BenchmarkTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new HarnessError(`unknown benchmark task: ${id}`, 'not_found', 2);
  return task;
}

export function describeBenchmarkTask(id: string): BenchmarkTaskView {
  const {
    id: taskId,
    language,
    title,
    issue,
    baseState,
    publicCommands,
    allowedPaths,
  } = getBenchmarkTask(id);
  return { id: taskId, language, title, issue, baseState, publicCommands, allowedPaths };
}

export async function materializeBenchmarkTask(
  id: string,
  destination: string,
  variant: 'base' | 'solution' = 'base',
  includeHidden = false,
): Promise<void> {
  const task = getBenchmarkTask(id);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const files = variant === 'base' ? task.baseFiles : task.solutionFiles;
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(destination, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, content, 'utf8');
  }
  if (includeHidden) {
    for (const [path, content] of Object.entries(task.hiddenFiles)) {
      const absolute = join(destination, path);
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
      await writeFile(absolute, content, 'utf8');
    }
  }
}

export const BENCHMARK_VERSION = 'frozen-v1';

export interface GradeOptions {
  taskId: string;
  attempt?: string;
  patch?: string;
  runId?: string;
  maxCommandMs?: number;
  usage?: UsageSummary;
  provider?: ProviderModelProfile;
  seed?: string;
}

export interface BenchmarkCaseReport {
  caseId: string;
  baseState: string;
  language: BenchmarkTaskView['language'];
  outcome: 'resolved' | 'failed';
  resolvedAt1: boolean;
  regressionFree: boolean;
  elapsedMs: number;
  checkCount: number;
  failureCategory?: string;
  usage: UsageSummary;
}

export interface BenchmarkRunReport {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  benchmarkVersion: typeof BENCHMARK_VERSION;
  mode: 'grader' | 'reference_sanity';
  startedAt: string;
  completedAt: string;
  configuration: {
    timeoutMs: number;
    attemptPolicy: 'directory' | 'patch';
    provider: ProviderModelProfile | null;
    seed: string | null;
  };
  cases: BenchmarkCaseReport[];
  aggregate: {
    caseCount: number;
    resolvedAt1: number;
    regressionFree: number;
    elapsedMs: number;
    usage: UsageSummary;
  };
}

export interface GradeResult {
  evidence: GradingEvidence;
  summary: {
    taskId: string;
    resolvedAt1: boolean;
    regressionFree: boolean;
    elapsedMs: number;
    failureCategory?: string;
  };
  report: BenchmarkRunReport;
}

export function createBenchmarkRunReport(options: {
  runId: string;
  mode: BenchmarkRunReport['mode'];
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  attemptPolicy: BenchmarkRunReport['configuration']['attemptPolicy'];
  provider?: ProviderModelProfile;
  seed?: string;
  cases: BenchmarkCaseReport[];
}): BenchmarkRunReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: options.runId,
    benchmarkVersion: BENCHMARK_VERSION,
    mode: options.mode,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    configuration: {
      timeoutMs: options.timeoutMs,
      attemptPolicy: options.attemptPolicy,
      provider: options.provider ?? null,
      seed: options.seed ?? null,
    },
    cases: options.cases,
    aggregate: {
      caseCount: options.cases.length,
      resolvedAt1: options.cases.filter((item) => item.resolvedAt1).length,
      regressionFree: options.cases.filter((item) => item.regressionFree).length,
      elapsedMs: options.cases.reduce((total, item) => total + item.elapsedMs, 0),
      usage: aggregateUsage(options.cases.map((item) => item.usage)),
    },
  };
}

export async function writeBenchmarkReport(
  path: string,
  report: BenchmarkRunReport,
): Promise<void> {
  await atomicWrite(path, `${redactSecrets(JSON.stringify(report, null, 2))}\n`);
}

export async function gradeBenchmark(options: GradeOptions): Promise<GradeResult> {
  if (Boolean(options.attempt) === Boolean(options.patch))
    throw new HarnessError(
      'exactly one of attempt or patch is required',
      'invalid_attempt',
      2,
    );
  const task = getBenchmarkTask(options.taskId);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runId = options.runId ?? `grade-${sha256(task.id + started).slice(0, 12)}`;
  const usage = options.usage
    ? parseUsageSummary(options.usage, 'benchmark.usage')
    : notApplicableUsage();
  const timeoutMs = options.maxCommandMs ?? 10_000;
  const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'issue-harness-grade-'));
  const baseline = join(root, 'baseline');
  const candidate = join(root, 'candidate');
  const hidden = join(root, 'hidden');
  await materializeBenchmarkTask(task.id, baseline, 'base');
  await materializeBenchmarkTask(task.id, candidate, 'base');
  if (options.attempt) await copyAttempt(options.attempt, candidate);
  if (options.patch) await applyPatch(options.patch, candidate);
  const checks: CheckOutcome[] = [];
  try {
    for (const command of task.publicCommands)
      checks.push(await runCheck('baseline', command, baseline, timeoutMs));
    const baselineFailed = checks.some(
      (check) => check.phase === 'baseline' && check.status === 'failed',
    );
    if (!baselineFailed)
      for (const check of checks)
        if (check.phase === 'baseline' && check.status === 'passed')
          check.status = 'pre_existing_failure';
    for (const command of task.publicCommands)
      checks.push(await runCheck('candidate', command, candidate, timeoutMs));
    await cp(candidate, hidden, { recursive: true, force: true });
    for (const [path, content] of Object.entries(task.hiddenFiles)) {
      await mkdir(dirname(join(hidden, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(hidden, path), content, 'utf8');
    }
    for (const command of task.hiddenCommands)
      checks.push(await runCheck('hidden', command, hidden, timeoutMs));
    const touched = await changedFiles(baseline, candidate);
    const forbiddenPathsTouched = touched.filter(
      (path) => !task.allowedPaths.some((pattern) => pathMatches(path, pattern)),
    );
    const candidateChecks = checks.filter((check) => check.phase !== 'baseline');
    const candidatePass = candidateChecks.every((check) => check.status === 'passed');
    const regressionFree =
      candidatePass &&
      checks
        .filter((check) => check.phase === 'candidate')
        .every((check) => check.status === 'passed');
    const baselineKnownFailure = checks
      .filter((check) => check.phase === 'baseline')
      .every((check) => check.status === 'failed' || check.status === 'pre_existing_failure');
    const resolvedAt1 = baselineKnownFailure && candidatePass && forbiddenPathsTouched.length === 0;
    const evidence: GradingEvidence = {
      schemaVersion: SCHEMA_VERSION,
      taskId: task.id,
      runId,
      resolvedAt1,
      regressionFree,
      patchScopeValid: forbiddenPathsTouched.length === 0,
      forbiddenPathsTouched,
      checks,
      elapsedMs: Date.now() - started,
      usage,
      failureCategory: resolvedAt1
        ? undefined
        : failureCategory(checks, forbiddenPathsTouched, baselineKnownFailure),
      residualRisks: forbiddenPathsTouched.length
        ? ['attempt changed files outside the benchmark allowlist']
        : [],
    };
    const report = createBenchmarkRunReport({
      runId,
      mode: 'grader',
      startedAt,
      completedAt: nowIso(),
      timeoutMs,
      attemptPolicy: options.patch ? 'patch' : 'directory',
      provider: options.provider,
      seed: options.seed,
      cases: [
        {
          caseId: task.id,
          baseState: task.baseState,
          language: task.language,
          outcome: resolvedAt1 ? 'resolved' : 'failed',
          resolvedAt1,
          regressionFree,
          elapsedMs: evidence.elapsedMs,
          checkCount: checks.length,
          failureCategory: evidence.failureCategory,
          usage,
        },
      ],
    });
    return {
      evidence,
      summary: {
        taskId: task.id,
        resolvedAt1,
        regressionFree,
        elapsedMs: evidence.elapsedMs,
        failureCategory: evidence.failureCategory,
      },
      report,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function copyAttempt(source: string, destination: string): Promise<void> {
  const info = await (await import('node:fs/promises')).stat(source);
  if (info.isDirectory()) {
    await cp(source, destination, {
      recursive: true,
      force: true,
      filter: (path) =>
        !path.includes(`${basename(source)}${process.platform === 'win32' ? '\\' : '/'}.git`),
    });
    return;
  }
  throw new HarnessError(
    'attempt must be a fixture directory; use --patch for a unified diff',
    'invalid_attempt',
    2,
  );
}

async function applyPatch(patchPath: string, cwd: string): Promise<void> {
  const patch = await readFile(patchPath, 'utf8');
  if (Buffer.byteLength(patch) > 1_000_000)
    throw new HarnessError('patch exceeds 1MB', 'patch_too_large', 2);
  const result = await execFileAsync('git', ['init', '-q'], { cwd });
  void result;
  await execFileAsync('git', ['add', '.'], { cwd });
  try {
    await execFileAsync('git', ['apply', '--whitespace=nowarn', '--', patchPath], { cwd });
  } catch {
    // A patch path outside cwd is not accepted by git. Retry with the content on stdin is avoided intentionally:
    // only a path-limited, git-validated patch is allowed in this local evaluator.
    throw new HarnessError('could not apply supplied patch', 'invalid_patch', 2);
  }
}

async function runCheck(
  phase: CheckOutcome['phase'],
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CheckOutcome> {
  await mkdir(join(cwd, '.harness-home'), { recursive: true, mode: 0o700 });
  await mkdir(join(cwd, '.harness-tmp'), { recursive: true, mode: 0o700 });
  const parts = command.split(' ');
  const started = Date.now();
  try {
    const result = await withTimeout(
      execFileAsync(parts[0] ?? '', parts.slice(1), {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: join(cwd, '.harness-home'),
          TMPDIR: join(cwd, '.harness-tmp'),
          HARNESS: '1',
        },
        maxBuffer: 200_000,
      }),
      timeoutMs,
      `${phase} check`,
    );
    return {
      name: `${phase}:${command}`,
      command,
      phase,
      status: 'passed',
      exitCode: 0,
      durationMs: Date.now() - started,
      output: redactSecrets(`${result.stdout}${result.stderr}`),
    };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      name: `${phase}:${command}`,
      command,
      phase,
      status: 'failed',
      exitCode: typeof e.code === 'number' ? e.code : 1,
      durationMs: Date.now() - started,
      output: redactSecrets(`${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`).slice(0, 100_000),
    };
  }
}

async function changedFiles(base: string, candidate: string): Promise<string[]> {
  const paths = new Set<string>();
  async function walk(root: string, current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === '.hidden' ||
        entry.name === '__pycache__' ||
        entry.name.startsWith('.harness-')
      )
        continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(root, full);
      else
        paths.add(
          relative(root, full)
            .split(process.platform === 'win32' ? '\\' : '/')
            .join('/'),
        );
    }
  }
  await walk(base, base);
  await walk(candidate, candidate);
  const changed: string[] = [];
  for (const path of paths) {
    const before = await readFile(join(base, path)).catch(() => undefined);
    const after = await readFile(join(candidate, path)).catch(() => undefined);
    if (!before || !after || !before.equals(after)) changed.push(path);
  }
  return changed;
}

function pathMatches(path: string, pattern: string): boolean {
  const prefix = pattern.replace('/**', '');
  return pattern.endsWith('/**') ? path.startsWith(`${prefix}/`) : path === pattern;
}
function failureCategory(
  checks: CheckOutcome[],
  forbidden: string[],
  baselineKnownFailure: boolean,
): string {
  if (!baselineKnownFailure) return 'pre_existing_failure';
  if (forbidden.length) return 'patch_scope';
  if (checks.some((check) => check.status === 'failed' && check.phase === 'candidate'))
    return 'candidate_check_failed';
  return 'hidden_check_failed';
}

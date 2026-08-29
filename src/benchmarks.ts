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

export const EVALUATOR_VERSION = 'local-deterministic-v2' as const;

export interface BenchmarkTaskView {
  id: string;
  language: 'typescript' | 'python';
  title: string;
  issue: string;
  baseState: string;
  seed: string;
  publicCommands: string[];
  allowedPaths: string[];
}

interface BenchmarkTask extends Omit<BenchmarkTaskView, 'seed'> {
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
  {
    id: 'ts-csv-quoted',
    language: 'typescript',
    title: 'Parse quoted CSV fields',
    issue: 'parseCsvLine must keep commas inside quoted fields and decode escaped quotes.',
    baseState: 'frozen-ts-csv-quoted-1',
    publicCommands: ['node --test test/public.mjs', 'node --test test/regression.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { parseCsvLine } from "./csv.ts";\n',
      'src/csv.ts':
        'export function parseCsvLine(line: string): string[] { return line.split(","); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parseCsvLine } from "../src/index.ts"; test("quoted comma",()=>assert.deepEqual(parseCsvLine("\\"Ada,42\\",active"), ["Ada,42","active"]));\n',
      'test/regression.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parseCsvLine } from "../src/index.ts"; test("empty unquoted field",()=>assert.deepEqual(parseCsvLine("Ada,,active"), ["Ada","","active"]));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { parseCsvLine } from "./csv.ts";\n',
      'src/csv.ts':
        'export function parseCsvLine(line: string): string[] { const values: string[] = []; let current = ""; let quoted = false; for (let i = 0; i < line.length; i += 1) { const char = line[i]; if (char === "\\\"") { if (quoted && line[i + 1] === "\\\"") { current += "\\\""; i += 1; } else quoted = !quoted; } else if (char === "," && !quoted) { values.push(current); current = ""; } else current += char; } values.push(current); return values; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parseCsvLine } from "../src/index.ts"; test("quoted comma",()=>assert.deepEqual(parseCsvLine("\\"Ada,42\\",active"), ["Ada,42","active"]));\n',
      'test/regression.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parseCsvLine } from "../src/index.ts"; test("empty unquoted field",()=>assert.deepEqual(parseCsvLine("Ada,,active"), ["Ada","","active"]));\n',
    },
    hiddenFiles: {
      'test_hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { parseCsvLine } from "./src/index.ts"; test("escaped quote",()=>assert.deepEqual(parseCsvLine("\\"say \\\"\\\"hi\\\"\\\"\\",ok"), ["say \\\"hi\\\"", "ok"]));\n',
    },
    hiddenCommands: ['node --test test_hidden.mjs'],
  },
  {
    id: 'ts-retry',
    language: 'typescript',
    title: 'Retry a failing operation',
    issue: 'retry must make at most the requested attempts and reject invalid attempt counts.',
    baseState: 'frozen-ts-retry-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { retry } from "./retry.ts";\n',
      'src/retry.ts':
        'export function retry<T>(operation: () => T, attempts: number): T { return operation(); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { retry } from "../src/index.ts"; test("retries then succeeds",()=>{let calls=0; assert.equal(retry(()=>{calls+=1; if(calls<3) throw new Error("try again"); return "ok";},3), "ok"); assert.equal(calls,3);});\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { retry } from "./retry.ts";\n',
      'src/retry.ts':
        'export function retry<T>(operation: () => T, attempts: number): T { if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be positive"); let last: unknown; for (let i = 0; i < attempts; i += 1) { try { return operation(); } catch (error) { last = error; } } throw last instanceof Error ? last : new Error("operation failed"); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { retry } from "../src/index.ts"; test("retries then succeeds",()=>{let calls=0; assert.equal(retry(()=>{calls+=1; if(calls<3) throw new Error("try again"); return "ok";},3), "ok"); assert.equal(calls,3);});\n',
    },
    hiddenFiles: {
      'test_hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { retry } from "./src/index.ts"; test("rejects zero without invoking",()=>{let calls=0; assert.throws(()=>retry(()=>{calls+=1; return "bad";},0), RangeError); assert.equal(calls,0);});\n',
    },
    hiddenCommands: ['node --test test_hidden.mjs'],
  },
  {
    id: 'ts-summarize-sales',
    language: 'typescript',
    title: 'Summarize valid sales',
    issue: 'summarizeSales must ignore records whose amount is not a finite number.',
    baseState: 'frozen-ts-summarize-sales-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { summarizeSales } from "./sales.ts";\n',
      'src/sales.ts':
        'export function summarizeSales(records: Array<{ amount: number }>): { count: number; total: number } { return { count: records.length, total: records.reduce((sum, record) => sum + record.amount, 0) }; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { summarizeSales } from "../src/index.ts"; test("skips malformed amounts",()=>assert.deepEqual(summarizeSales([{amount:2},{amount:"bad"},{amount:5},{amount:NaN}]), {count:2,total:7}));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { summarizeSales } from "./sales.ts";\n',
      'src/sales.ts':
        'export function summarizeSales(records: Array<{ amount: number }>): { count: number; total: number } { const valid = records.filter((record) => typeof record.amount === "number" && Number.isFinite(record.amount)); return { count: valid.length, total: valid.reduce((sum, record) => sum + record.amount, 0) }; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { summarizeSales } from "../src/index.ts"; test("skips malformed amounts",()=>assert.deepEqual(summarizeSales([{amount:2},{amount:"bad"},{amount:5},{amount:NaN}]), {count:2,total:7}));\n',
    },
    hiddenFiles: {
      'test_hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { summarizeSales } from "./src/index.ts"; test("keeps negative finite amounts and does not mutate",()=>{const rows=[{amount:-2},{amount:3}]; assert.deepEqual(summarizeSales(rows), {count:2,total:1}); assert.deepEqual(rows,[{amount:-2},{amount:3}]);});\n',
    },
    hiddenCommands: ['node --test test_hidden.mjs'],
  },
  {
    id: 'ts-slugify',
    language: 'typescript',
    title: 'Normalize URL slugs',
    issue: 'slugify must normalize punctuation and repeated separators while trimming the result.',
    baseState: 'frozen-ts-slugify-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { slugify } from "./slug.ts";\n',
      'src/slug.ts':
        'export function slugify(value: string): string { return value.toLowerCase().replaceAll(" ", "-"); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { slugify } from "../src/index.ts"; test("normalizes punctuation",()=>assert.equal(slugify(" Hello, World! "), "hello-world"));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { slugify } from "./slug.ts";\n',
      'src/slug.ts':
        'export function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { slugify } from "../src/index.ts"; test("normalizes punctuation",()=>assert.equal(slugify(" Hello, World! "), "hello-world"));\n',
    },
    hiddenFiles: {
      'test_hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { slugify } from "./src/index.ts"; test("collapses separators",()=>assert.equal(slugify("API___v2 / beta"), "api-v2-beta"));\n',
    },
    hiddenCommands: ['node --test test_hidden.mjs'],
  },
  {
    id: 'ts-window-average',
    language: 'typescript',
    title: 'Average a trailing window',
    issue: 'windowAverage must average only the requested trailing values and reject empty input.',
    baseState: 'frozen-ts-window-average-1',
    publicCommands: ['node --test test/public.mjs'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/index.ts': 'export { windowAverage } from "./average.ts";\n',
      'src/average.ts':
        'export function windowAverage(values: number[], window: number): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { windowAverage } from "../src/index.ts"; test("uses trailing values",()=>assert.equal(windowAverage([1,3,5],2),4));\n',
    },
    solutionFiles: {
      'src/index.ts': 'export { windowAverage } from "./average.ts";\n',
      'src/average.ts':
        'export function windowAverage(values: number[], window: number): number { if (!values.length || !Number.isInteger(window) || window < 1) throw new RangeError("positive window and values required"); const selected = values.slice(-window); return selected.reduce((sum, value) => sum + value, 0) / selected.length; }\n',
      'test/public.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { windowAverage } from "../src/index.ts"; test("uses trailing values",()=>assert.equal(windowAverage([1,3,5],2),4));\n',
    },
    hiddenFiles: {
      'test_hidden.mjs':
        'import assert from "node:assert/strict"; import test from "node:test"; import { windowAverage } from "./src/index.ts"; test("handles oversized window and empty input",()=>{assert.equal(windowAverage([1,2],5),1.5); assert.throws(()=>windowAverage([],2), RangeError);});\n',
    },
    hiddenCommands: ['node --test test_hidden.mjs'],
  },
  {
    id: 'py-median',
    language: 'python',
    title: 'Calculate an even median',
    issue: 'median_value must average the two middle values for an even-sized input.',
    baseState: 'frozen-py-median-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def median_value(values):\n    ordered = sorted(values)\n    return ordered[len(ordered) // 2]\n',
      'test_public.py':
        'import unittest\nfrom src.app import median_value\nclass Public(unittest.TestCase):\n    def test_even(self): self.assertEqual(median_value([1, 4, 2, 8]), 3.0)\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'from statistics import median\n\ndef median_value(values):\n    if not values: raise ValueError("values required")\n    return median(values)\n',
      'test_public.py':
        'import unittest\nfrom src.app import median_value\nclass Public(unittest.TestCase):\n    def test_even(self): self.assertEqual(median_value([1, 4, 2, 8]), 3.0)\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import median_value\nclass Hidden(unittest.TestCase):\n    def test_odd_and_empty(self):\n        self.assertEqual(median_value([9, 1, 5]), 5)\n        with self.assertRaises(ValueError): median_value([])\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-word-count',
    language: 'python',
    title: 'Count normalized words',
    issue: 'word_counts must normalize case and ignore punctuation around words.',
    baseState: 'frozen-py-word-count-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def word_counts(text):\n    words = text.split()\n    return {word: words.count(word) for word in words}\n',
      'test_public.py':
        'import unittest\nfrom src.app import word_counts\nclass Public(unittest.TestCase):\n    def test_normalizes(self): self.assertEqual(word_counts("Hello, hello! world."), {"hello": 2, "world": 1})\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'import re\nfrom collections import Counter\n\ndef word_counts(text):\n    return dict(Counter(re.findall(r"[a-z0-9]+(?:\\\'[a-z0-9]+)?", text.lower())))\n',
      'test_public.py':
        'import unittest\nfrom src.app import word_counts\nclass Public(unittest.TestCase):\n    def test_normalizes(self): self.assertEqual(word_counts("Hello, hello! world."), {"hello": 2, "world": 1})\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import word_counts\nclass Hidden(unittest.TestCase):\n    def test_apostrophe_and_empty(self):\n        self.assertEqual(word_counts("Rock’n’roll rock-n-roll"), {"rock": 2, "n": 2, "roll": 2})\n        self.assertEqual(word_counts(""), {})\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-schedule',
    language: 'python',
    title: 'Check working-day availability',
    issue: 'is_available must reject weekends and compare blocked day names case-insensitively.',
    baseState: 'frozen-py-schedule-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py': 'def is_available(day, blocked):\n    return day not in blocked\n',
      'test_public.py':
        'import unittest\nfrom src.app import is_available\nclass Public(unittest.TestCase):\n    def test_weekend(self): self.assertFalse(is_available("Saturday", []))\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def is_available(day, blocked):\n    normalized = day.strip().lower()\n    if normalized in {"saturday", "sunday"}: return False\n    return normalized not in {item.strip().lower() for item in blocked}\n',
      'test_public.py':
        'import unittest\nfrom src.app import is_available\nclass Public(unittest.TestCase):\n    def test_weekend(self): self.assertFalse(is_available("Saturday", []))\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import is_available\nclass Hidden(unittest.TestCase):\n    def test_blocked_case(self):\n        self.assertFalse(is_available(" monday ", ["MONDAY"]))\n        self.assertTrue(is_available("Tuesday", ["monday"]))\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-merge-settings',
    language: 'python',
    title: 'Merge nested settings',
    issue:
      'merge_settings must preserve unspecified nested defaults without mutating either input.',
    baseState: 'frozen-py-merge-settings-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def merge_settings(defaults, overrides):\n    result = dict(defaults)\n    result.update(overrides)\n    return result\n',
      'test_public.py':
        'import unittest\nfrom src.app import merge_settings\nclass Public(unittest.TestCase):\n    def test_nested(self): self.assertEqual(merge_settings({"retry":{"count":2,"delay":1},"region":"us"}, {"retry":{"count":0}}), {"retry":{"count":0,"delay":1},"region":"us"})\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'from copy import deepcopy\n\ndef merge_settings(defaults, overrides):\n    result = deepcopy(defaults)\n    for key, value in overrides.items():\n        if isinstance(value, dict) and isinstance(result.get(key), dict): result[key] = merge_settings(result[key], value)\n        else: result[key] = deepcopy(value)\n    return result\n',
      'test_public.py':
        'import unittest\nfrom src.app import merge_settings\nclass Public(unittest.TestCase):\n    def test_nested(self): self.assertEqual(merge_settings({"retry":{"count":2,"delay":1},"region":"us"}, {"retry":{"count":0}}), {"retry":{"count":0,"delay":1},"region":"us"})\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import merge_settings\nclass Hidden(unittest.TestCase):\n    def test_inputs_unchanged_and_new_value(self):\n        defaults={"nested":{"keep":True}}; overrides={"nested":{"add":1}}; merged=merge_settings(defaults, overrides)\n        self.assertEqual(merged, {"nested":{"keep":True,"add":1}})\n        self.assertEqual(defaults, {"nested":{"keep":True}}); self.assertEqual(overrides, {"nested":{"add":1}})\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenCommands: ['python3 -m unittest test_hidden.py'],
  },
  {
    id: 'py-log-summary',
    language: 'python',
    title: 'Summarize log levels',
    issue:
      'summarize_log must count recognized levels case-insensitively and ignore malformed lines.',
    baseState: 'frozen-py-log-summary-1',
    publicCommands: ['python3 -m unittest test_public.py'],
    allowedPaths: ['src/**'],
    baseFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'def summarize_log(lines):\n    counts = {}\n    for line in lines:\n        level = line.split(" ", 1)[0]\n        counts[level] = counts.get(level, 0) + 1\n    return counts\n',
      'test_public.py':
        'import unittest\nfrom src.app import summarize_log\nclass Public(unittest.TestCase):\n    def test_levels(self): self.assertEqual(summarize_log(["INFO started", "error failed", "INFO done", "malformed"]), {"info":2,"error":1})\nif __name__ == "__main__": unittest.main()\n',
    },
    solutionFiles: {
      'src/__init__.py': '',
      'src/app.py':
        'import re\n\ndef summarize_log(lines):\n    counts = {}\n    for line in lines:\n        match = re.match(r"^(debug|info|warn|error)\\b", line.strip(), re.IGNORECASE)\n        if match:\n            level = match.group(1).lower()\n            counts[level] = counts.get(level, 0) + 1\n    return counts\n',
      'test_public.py':
        'import unittest\nfrom src.app import summarize_log\nclass Public(unittest.TestCase):\n    def test_levels(self): self.assertEqual(summarize_log(["INFO started", "error failed", "INFO done", "malformed"]), {"info":2,"error":1})\nif __name__ == "__main__": unittest.main()\n',
    },
    hiddenFiles: {
      'test_hidden.py':
        'import unittest\nfrom src.app import summarize_log\nclass Hidden(unittest.TestCase):\n    def test_whitespace_and_unknown(self): self.assertEqual(summarize_log([" WARN delayed", "TRACE ignored", "DEBUG detail", "ERROR boom"]), {"warn":1,"debug":1,"error":1})\nif __name__ == "__main__": unittest.main()\n',
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
    seed: baseState,
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
  return {
    id: taskId,
    language,
    title,
    issue,
    baseState,
    seed: baseState,
    publicCommands,
    allowedPaths,
  };
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

export const BENCHMARK_VERSION = 'frozen-v2';

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
  evaluatorVersion: typeof EVALUATOR_VERSION;
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
    evaluatorVersion: EVALUATOR_VERSION,
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
    throw new HarnessError('exactly one of attempt or patch is required', 'invalid_attempt', 2);
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
  const checks: CheckOutcome[] = [];
  try {
    await materializeBenchmarkTask(task.id, baseline, 'base');
    await materializeBenchmarkTask(task.id, candidate, 'base');
    if (options.attempt) await copyAttempt(options.attempt, candidate);
    if (options.patch) await applyPatch(options.patch, candidate);
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
    const regressionFree = checks
      .filter((check) => check.phase === 'candidate')
      .every((check) => check.status === 'passed');
    const baselineKnownFailure = baselineFailed;
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
      seed: options.seed ?? task.baseState,
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
  if (patch.trim() === '') return;
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

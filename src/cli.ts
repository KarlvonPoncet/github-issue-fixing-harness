#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './storage.js';
import { DurableQueue } from './queue.js';
import { authStatus, credentialStorePathFromEnv, loginCodex, logout } from './auth.js';
import { GitHubWebhookAdapter } from './github.js';
import {
  gradeBenchmark,
  describeBenchmarkTask,
  getBenchmarkTask,
  listBenchmarkTasks,
  materializeBenchmarkTask,
} from './benchmarks.js';
import { AgentRunner } from './agent.js';
import { FakeTransport, parseReplayResponses, PiModelTransport, ReplayTransport } from './model.js';
import { parseBudget, parseNormalizedTask, SCHEMA_VERSION } from './schema.js';
import { makeWorkspace } from './workspace.js';
import { HarnessError, nowIso, sha256, toToon } from './util.js';

const DESCRIPTION =
  'Own-agent GitHub issue harness with bounded tools, durable queueing, and deterministic grading.';
const VERSION = '0.1.0';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    const e =
      error instanceof HarnessError
        ? error
        : new HarnessError(error instanceof Error ? error.message : String(error));
    emit({
      error: e.message,
      code: e.code,
      help: 'Run `issue-harness --help` for valid commands.',
    });
    return e.exitCode;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0) return home();
  if (argv.includes('--help')) return help(argv.filter((arg) => arg !== '--help'));
  if (argv[0] === '--version') {
    emit({ version: VERSION });
    return 0;
  }
  const [noun, verb, ...rest] = argv;
  if (noun === 'task') return taskCommand(verb, rest);
  if (noun === 'bench') return benchmarkCommand(verb, rest);
  if (noun === 'webhook') return webhookCommand(verb, rest);
  if (noun === 'auth') return authCommand(verb, rest);
  if (noun === 'providers') return providersCommand(verb, rest);
  if (noun === 'demo') return demoCommand(rest);
  throw usage(`unknown command: ${noun}`, 'issue-harness task|bench|webhook|auth|providers|demo');
}

async function home(): Promise<number> {
  const queue = new DurableQueue();
  await queue.init();
  const items = await queue.list();
  emit({
    bin: collapseHome(process.argv[1] ?? 'issue-harness'),
    description: DESCRIPTION,
    queued: items.filter((item) => ['queued', 'claimed', 'running'].includes(item.entry.state))
      .length,
    tasks: items
      .slice(0, 20)
      .map(({ task, entry }) => ({ id: task.id, title: task.title, status: entry.state })),
  });
  return 0;
}

async function taskCommand(verb: string | undefined, argv: string[]): Promise<number> {
  const queue = new DurableQueue();
  await queue.init();
  if (verb === 'list') {
    const flags = flagsFor(argv, new Set(['--state', '--limit']));
    const entries = await queue.list();
    const filtered = flags.state
      ? entries.filter((item) => item.entry.state === flags.state)
      : entries;
    const limit = flags.limit ? positiveInt(flags.limit, '--limit') : 100;
    emit({
      count: `${Math.min(limit, filtered.length)} of ${filtered.length}`,
      tasks: filtered.slice(0, limit).map(({ task, entry }) => ({
        id: task.id,
        number: task.number,
        title: task.title,
        status: entry.state,
      })),
    });
    return 0;
  }
  if (verb === 'view') {
    const flags = flagsFor(argv, new Set(['--id']));
    const id = flags.id ?? argv.find((value) => !value.startsWith('--'));
    if (!id) throw usage('--id is required', 'issue-harness task view --id <task-id>');
    const item = await queue.get(id);
    if (!item) throw new HarnessError(`task not found: ${id}`, 'not_found', 2);
    emit({ task: item.task, queue: item.entry });
    return 0;
  }
  if (verb === 'run') return runTaskCommand(queue, argv);
  if (verb === 'cancel') {
    const flags = flagsFor(argv, new Set(['--id', '--reason']));
    if (!flags.id) throw usage('--id is required', 'issue-harness task cancel --id <task-id>');
    const entry = await queue.cancel(flags.id, flags.reason ?? 'cancelled by operator');
    emit({ task: flags.id, status: entry.state, reason: entry.terminalReason });
    return 0;
  }
  throw usage(
    `unknown task command: ${verb ?? '(missing)'}`,
    'issue-harness task list|view|run|cancel',
  );
}

async function runTaskCommand(queue: DurableQueue, argv: string[]): Promise<number> {
  const flags = flagsFor(
    argv,
    new Set(['--id', '--workspace', '--transport', '--replay', '--provider', '--model']),
  );
  if (!flags.id || !flags.workspace)
    throw usage(
      '--id and --workspace are required',
      'issue-harness task run --id <task-id> --workspace <isolated-dir> --transport replay --replay <file>',
    );
  const item = await queue.get(flags.id);
  if (!item) throw new HarnessError(`task not found: ${flags.id}`, 'not_found', 2);
  if (item.entry.state !== 'queued')
    throw new HarnessError(
      `task is not runnable from ${item.entry.state}`,
      'invalid_transition',
      2,
    );
  const transportName = flags.transport ?? 'pi';
  let transport;
  if (transportName === 'replay') {
    if (!flags.replay)
      throw usage(
        '--replay is required with --transport replay',
        'issue-harness task run --transport replay --replay <file>',
      );
    const replay = parseReplayResponses(
      JSON.parse(await readFile(flags.replay, 'utf8')) as unknown,
    );
    transport = new ReplayTransport(replay);
  } else if (transportName === 'fake') {
    transport = new FakeTransport(() => ({
      text: 'No-op fake response.',
      toolCalls: [{ id: 'finish', name: 'finish', arguments: { reason: 'fake transport' } }],
    }));
  } else if (transportName === 'pi') {
    transport = new PiModelTransport(credentialStorePathFromEnv());
  } else {
    throw usage(`unknown transport: ${transportName}`, 'valid transports: pi, replay, fake');
  }
  const provider = flags.provider ?? 'openai';
  if (provider !== 'openai' && provider !== 'openai-codex')
    throw usage(`unknown provider: ${provider}`, 'valid providers: openai, openai-codex');
  const workspace = await makeWorkspace(flags.workspace, item.task.policy);
  const profile = {
    provider: provider as 'openai' | 'openai-codex',
    model: flags.model ?? 'gpt-5-mini',
    auth: (provider === 'openai-codex' ? 'oauth' : 'api_key') as 'oauth' | 'api_key',
    runtime: transportName,
  };
  const budget = parseBudget({
    schemaVersion: SCHEMA_VERSION,
    maxSteps: 20,
    maxModelCalls: 20,
    maxRetriesPerState: 1,
    timeoutMs: item.task.policy.maxCommandMs,
    maxOutputChars: 50_000,
    maxPatchBytes: item.task.policy.maxPatchBytes,
    maxInputChars: 50_000,
  });
  await queue.markRunning(item.task.id);
  const started = Date.now();
  const runner = new AgentRunner({ task: item.task, workspace, transport, profile, budget });
  const result = await runner.run();
  const store = new ArtifactStore();
  await store.init();
  const records = await Promise.all([
    store.put('issue', JSON.stringify(item.task), `${result.manifest.runId}-issue`),
    store.put('patch', result.patch, `${result.manifest.runId}-patch`),
    store.put('event_log', JSON.stringify(result.events), `${result.manifest.runId}-events`),
    store.put(
      'evidence',
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        taskId: item.task.id,
        runId: result.manifest.runId,
        resolvedAt1: result.terminal.outcome === 'resolved',
        regressionFree: result.terminal.outcome === 'resolved',
        patchScopeValid: true,
        forbiddenPathsTouched: [],
        checks: [],
        elapsedMs: Date.now() - started,
        failureCategory: result.terminal.failureCategory,
        residualRisks: result.terminal.residualRisks,
      }),
      `${result.manifest.runId}-evidence`,
    ),
  ]);
  result.manifest.artifactIds = records.map((record) => record.id);
  const manifestRecord = await store.put(
    'manifest',
    JSON.stringify(result.manifest),
    `${result.manifest.runId}-manifest`,
  );
  result.manifest.artifactIds.push(manifestRecord.id);
  await store.index.upsertRun(result.manifest);
  const nextState =
    result.terminal.outcome === 'resolved'
      ? 'succeeded'
      : result.terminal.outcome === 'human_review'
        ? 'review'
        : result.terminal.outcome === 'cancelled'
          ? 'cancelled'
          : 'failed';
  await queue.transition(item.task.id, nextState, result.terminal.reason);
  emit({
    runId: result.manifest.runId,
    taskId: item.task.id,
    status: result.manifest.status,
    terminal: result.terminal,
    artifactIds: result.manifest.artifactIds,
    usage: result.usage,
  });
  return result.terminal.outcome === 'resolved' ? 0 : 1;
}

async function benchmarkCommand(verb: string | undefined, argv: string[]): Promise<number> {
  if (verb === 'list') {
    flagsFor(argv, new Set());
    emit({
      count: listBenchmarkTasks().length,
      tasks: listBenchmarkTasks().map(({ id, language, title }) => ({ id, language, title })),
    });
    return 0;
  }
  if (verb === 'view') {
    const flags = flagsFor(argv, new Set(['--task', '--full']));
    const id = flags.task ?? argv.find((value) => !value.startsWith('--'));
    if (!id) throw usage('--task is required', 'issue-harness bench view --task <id>');
    const task = describeBenchmarkTask(id);
    emit({
      task: flags.full ? { ...task, files: Object.keys(getBenchmarkTask(id).baseFiles) } : task,
    });
    return 0;
  }
  if (verb === 'run' || verb === 'replay' || verb === 'grade') {
    const flags = flagsFor(argv, new Set(['--task', '--attempt', '--patch', '--run-id']));
    if (!flags.task)
      throw usage(
        '--task is required',
        `issue-harness bench ${verb} --task <id> --attempt <dir>|--patch <file>`,
      );
    if (!flags.attempt && !flags.patch)
      throw usage(
        'one of --attempt or --patch is required',
        `issue-harness bench ${verb} --task ${flags.task} --attempt <dir>`,
      );
    const result = await gradeBenchmark({
      taskId: flags.task,
      attempt: flags.attempt,
      patch: flags.patch,
      runId: flags['run-id'],
    });
    emit({ summary: result.summary, evidence: result.evidence });
    return result.summary.resolvedAt1 ? 0 : 1;
  }
  if (verb === 'summary') {
    const flags = flagsFor(argv, new Set(['--attempt-root', '--solutions']));
    if (!flags['attempt-root'] && !flags.solutions)
      throw usage(
        '--attempt-root or --solutions is required',
        'issue-harness bench summary --solutions',
      );
    const temporary = flags.solutions
      ? await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'issue-harness-summary-'))
      : undefined;
    const attemptRoot = flags['attempt-root'] ?? temporary;
    try {
      const results = [];
      for (const task of listBenchmarkTasks()) {
        const attempt = join(attemptRoot ?? '', task.id);
        if (flags.solutions) await materializeBenchmarkTask(task.id, attempt, 'solution');
        const result = await gradeBenchmark({ taskId: task.id, attempt });
        results.push({
          id: task.id,
          language: task.language,
          resolvedAt1: result.summary.resolvedAt1,
          regressionFree: result.summary.regressionFree,
          elapsedMs: result.summary.elapsedMs,
          failureCategory: result.summary.failureCategory,
        });
      }
      emit({
        count: results.length,
        resolvedAt1: results.filter((result) => result.resolvedAt1).length,
        regressionFree: results.filter((result) => result.regressionFree).length,
        tasks: results,
      });
      return results.every((result) => result.resolvedAt1) ? 0 : 1;
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  throw usage(
    `unknown benchmark command: ${verb ?? '(missing)'}`,
    'issue-harness bench list|view|run|replay|grade|summary --solutions',
  );
}

async function webhookCommand(verb: string | undefined, argv: string[]): Promise<number> {
  if (verb !== 'ingest')
    throw usage(
      `unknown webhook command: ${verb ?? '(missing)'}`,
      'issue-harness webhook ingest --file <json> --signature <sha256=...> --secret <secret>',
    );
  const flags = flagsFor(
    argv,
    new Set(['--file', '--signature', '--secret', '--repository', '--base-commit']),
  );
  if (!flags.file || !flags.signature || !flags.secret)
    throw usage(
      '--file, --signature, and --secret are required',
      'issue-harness webhook ingest --file <json> --signature <sha256=...> --secret <secret>',
    );
  const body = await readFile(flags.file, 'utf8');
  const queue = new DurableQueue();
  await queue.init();
  const repository = flags.repository ?? 'fixture/repository';
  const policy = defaultPolicy(repository);
  const adapter = new GitHubWebhookAdapter({
    secret: flags.secret,
    queue,
    policyFor: (candidate) => (candidate === repository ? policy : undefined),
  });
  const result = await adapter.ingest({
    body,
    signature: flags.signature,
    event: 'issues',
    delivery: `cli:${Date.now()}`,
  });
  emit({ accepted: result.accepted, taskId: result.task?.id, reason: result.reason });
  return result.accepted ? 0 : 1;
}

async function authCommand(verb: string | undefined, argv: string[]): Promise<number> {
  const store = credentialStorePathFromEnv();
  if (verb === 'status') {
    flagsFor(argv, new Set());
    emit(await authStatus(store));
    return 0;
  }
  if (verb === 'logout') {
    const flags = flagsFor(argv, new Set(['--provider']));
    const provider = flags.provider;
    if (provider !== 'openai' && provider !== 'openai-codex')
      throw usage(
        '--provider must be openai or openai-codex',
        'issue-harness auth logout --provider openai-codex',
      );
    await logout(store, provider);
    emit({ provider, status: 'logged_out' });
    return 0;
  }
  if (verb === 'login') {
    const flags = flagsFor(argv, new Set(['--provider', '--manual-code']));
    if (flags.provider !== 'openai-codex')
      throw usage(
        'only Codex OAuth login is interactive',
        'issue-harness auth login --provider openai-codex',
      );
    await loginCodex(store, {
      open: async (url) =>
        emit({
          auth_url: url,
          next: 'Complete login in the browser, then return to this command.',
        }),
      promptManualCode: async () =>
        flags['manual-code'] ??
        (() => {
          throw new HarnessError(
            'OAuth needs --manual-code after browser authorization',
            'oauth_code',
            2,
          );
        })(),
      notify: (message) => emit({ status: message }),
    });
    emit({ provider: 'openai-codex', status: 'logged_in' });
    return 0;
  }
  throw usage(
    `unknown auth command: ${verb ?? '(missing)'}`,
    'issue-harness auth login|status|logout',
  );
}

async function providersCommand(verb: string | undefined, argv: string[]): Promise<number> {
  const pi = await import('@earendil-works/pi-ai');
  const openai = await import('@earendil-works/pi-ai/providers/openai');
  const codex = await import('@earendil-works/pi-ai/providers/openai-codex');
  const models = pi.createModels();
  models.setProvider(openai.openaiProvider());
  models.setProvider(codex.openaiCodexProvider());
  if (verb === 'list') {
    flagsFor(argv, new Set());
    emit({
      providers: [
        {
          id: 'openai',
          auth: 'api_key',
          modelCount: models.getModels('openai').length,
          setup: 'OPENAI_API_KEY or secret-manager injection',
        },
        {
          id: 'openai-codex',
          auth: 'oauth',
          modelCount: models.getModels('openai-codex').length,
          setup: 'issue-harness auth login --provider openai-codex',
        },
      ],
    });
    return 0;
  }
  if (verb === 'models') {
    const flags = flagsFor(argv, new Set(['--provider']));
    if (flags.provider !== 'openai' && flags.provider !== 'openai-codex')
      throw usage(
        '--provider must be openai or openai-codex',
        'issue-harness providers models --provider openai',
      );
    const available = models.getModels(flags.provider);
    emit({
      provider: flags.provider,
      models: available
        .map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning }))
        .slice(0, 100),
      count: available.length,
    });
    return 0;
  }
  throw usage(
    `unknown providers command: ${verb ?? '(missing)'}`,
    'issue-harness providers list|models --provider <id>',
  );
}

async function demoCommand(argv: string[]): Promise<number> {
  flagsFor(argv, new Set());
  const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'issue-harness-demo-'));
  const task = getBenchmarkTask('ts-addition');
  const workspaceRoot = join(root, 'workspace');
  await materializeBenchmarkTask(task.id, workspaceRoot, 'base');
  const policy = defaultPolicy('fixture/repository');
  const normalized = parseNormalizedTask({
    schemaVersion: SCHEMA_VERSION,
    id: 'demo-ts-addition',
    deliveryKey: 'demo:ts-addition',
    repository: 'fixture/repository',
    number: 1,
    title: task.title,
    body: task.issue,
    comments: [],
    links: [],
    state: 'open',
    labels: ['agent-opt-in'],
    author: 'fixture',
    baseCommit: task.baseState,
    policy,
    risk: 'normal',
    receivedAt: nowIso(),
    source: 'fixture',
  });
  const demoQueue = new DurableQueue(join(root, 'queue'));
  await demoQueue.init();
  await demoQueue.enqueue(normalized);
  const claimed = await demoQueue.claimNext();
  if (!claimed)
    throw new HarnessError('offline demo could not claim its fixture task', 'demo_queue');
  await demoQueue.markRunning(normalized.id);
  const workspace = await makeWorkspace(workspaceRoot, policy);
  const original = await readFile(join(workspaceRoot, 'src/math.ts'), 'utf8');
  const originalHash = sha256(original);
  const transport = new FakeTransport((_request, call) => {
    if (call === 1)
      return {
        text: 'Inspecting source.',
        toolCalls: [{ id: '1', name: 'list_files', arguments: { path: 'src' } }],
      };
    if (call === 2)
      return {
        text: 'Reproducing baseline.',
        toolCalls: [
          {
            id: '2',
            name: 'run_command',
            arguments: { name: 'public-test', command: ['node', '--test', 'test/public.mjs'] },
          },
        ],
      };
    if (call === 3) return { text: 'Planning a one-line correction.', toolCalls: [] };
    if (call === 4)
      return {
        text: 'Editing exact file.',
        toolCalls: [
          {
            id: '4',
            name: 'exact_edit',
            arguments: {
              path: 'src/math.ts',
              expectedSha256: originalHash,
              replacement: 'export function add(a: number, b: number): number { return a + b; }\n',
            },
          },
        ],
      };
    if (call === 5)
      return {
        text: 'Testing candidate.',
        toolCalls: [
          {
            id: '5',
            name: 'run_command',
            arguments: { name: 'public-test', command: ['node', '--test', 'test/public.mjs'] },
          },
        ],
      };
    return {
      text: 'Review complete.',
      toolCalls: [{ id: '6', name: 'finish', arguments: { reason: 'tests pass' } }],
    };
  });
  const runner = new AgentRunner({
    task: claimed.task,
    workspace,
    transport,
    profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'fake' },
    budget: parseBudget({
      schemaVersion: SCHEMA_VERSION,
      maxSteps: 10,
      maxModelCalls: 8,
      maxRetriesPerState: 0,
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      maxPatchBytes: 100_000,
      maxInputChars: 20_000,
    }),
  });
  const run = await runner.run();
  await demoQueue.transition(
    normalized.id,
    run.terminal.outcome === 'resolved' ? 'succeeded' : 'failed',
    run.terminal.reason,
  );
  const grade = await gradeBenchmark({
    taskId: task.id,
    attempt: workspaceRoot,
    runId: run.manifest.runId,
  });
  const store = new ArtifactStore(join(root, 'artifacts'));
  await store.init();
  await store.put('issue', JSON.stringify(normalized));
  await store.put('patch', run.patch);
  await store.put('event_log', JSON.stringify(run.events));
  await store.put('evidence', JSON.stringify(grade.evidence));
  emit({
    demo: 'offline',
    queue: 'fixture → worker → edit → grade',
    terminal: run.terminal,
    grading: grade.summary,
  });
  await rm(root, { recursive: true, force: true });
  return grade.summary.resolvedAt1 ? 0 : 1;
}

function flagsFor(argv: string[], allowed: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--'))
      throw usage(`unknown argument: ${token ?? ''}`, 'use --help for valid flags');
    const key = token.split('=', 1)[0] ?? '';
    if (!allowed.has(key))
      throw usage(
        `unknown flag ${key}; valid flags: ${[...allowed].join(', ') || '(none)'}`,
        'run the command with --help',
      );
    const name = key.slice(2);
    const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
    if (key === '--full' || key === '--solutions') {
      result[name] = inline ?? 'true';
      continue;
    }
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--'))
      throw usage(`${key} requires a value`, 'run the command with --help');
    result[name] = value;
  }
  return result;
}

function positiveInt(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw usage(`${flag} must be a positive integer`, 'run the command with --help');
  return number;
}
function usage(message: string, help: string): HarnessError {
  return new HarnessError(`${message}. ${help}`, 'usage', 2);
}
function emit(value: unknown): void {
  process.stdout.write(`${toToon(value)}\n`);
}
function collapseHome(path: string): string {
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}
function defaultPolicy(repository: string) {
  return {
    schemaVersion: SCHEMA_VERSION as 'v1',
    repository,
    allowedStates: ['open'] as ('open' | 'closed')[],
    optInLabels: [],
    forbiddenPaths: ['.git/**', '.env', 'credentials/**'],
    allowedPaths: ['src/**', 'test/**'],
    allowedCommands: ['public-test', 'git-diff'],
    maxIssueChars: 20_000,
    maxPatchBytes: 100_000,
    maxCommandMs: 10_000,
    requireHumanReviewFor: ['security_sensitive', 'destructive', 'oversized', 'ambiguous'] as (
      'security_sensitive' | 'destructive' | 'oversized' | 'ambiguous'
    )[],
  };
}
function help(args: string[]): number {
  const key = args.join(' ');
  const blocks: Record<string, string> = {
    '': `${DESCRIPTION}\nCommands: task list|view|run|cancel; bench list|view|grade|replay|summary; webhook ingest; auth login|status|logout; providers list|models; demo.\nExamples: issue-harness task list; issue-harness bench summary --solutions; issue-harness demo`,
    'task list':
      'List durable tasks. Flags: --state <queued|claimed|running|succeeded|failed|review|cancelled>, --limit <n>. Example: issue-harness task list --state queued',
    'task view':
      'Inspect one task. Required: --id <task-id>. Example: issue-harness task view --id <id>',
    'task run':
      'Run a queued task in an isolated workspace. Required: --id <id> --workspace <dir>. Flags: --transport <pi|replay|fake>, --replay <json>, --provider <openai|openai-codex>, --model <id>.',
    'task cancel':
      'Cancel a queued or review task. Required: --id <task-id>. Optional: --reason <text>.',
    'bench list': 'List the 10 frozen TypeScript/Python tasks. No flags.',
    'bench view': 'Inspect solver-facing task metadata. Required: --task <id>. Optional: --full.',
    'bench grade':
      'Grade a candidate without model self-judgment. Required: --task <id> and one of --attempt <dir> or --patch <file>.',
    'bench run':
      'Alias for bench grade. Required: --task <id> and --attempt <dir> or --patch <file>.',
    'bench replay':
      'Alias for bench grade. Required: --task <id> and --attempt <dir> or --patch <file>.',
    'bench summary':
      'Grade all frozen solutions for a compact effectiveness baseline. Required: --solutions or --attempt-root <dir>.',
    'webhook ingest':
      'Verify and enqueue a fixture webhook. Required: --file <json> --signature <sha256=...> --secret <secret>. Optional: --repository <owner/name> --base-commit <sha>.',
    'auth login':
      'Explicit browser OAuth flow. Required: --provider openai-codex. Optional: --manual-code <code>.',
    'auth status':
      'Show configured provider types and private credential path. No secrets are printed.',
    'auth logout': 'Remove one credential. Required: --provider <openai|openai-codex>.',
    'providers list':
      'List supported provider profiles, model counts, and non-secret setup paths. No flags.',
    'providers models':
      'Discover provider models. Required: --provider <openai|openai-codex>. Output is capped at 100 models.',
    demo: 'Run the fully offline signed-fixture/fake-model queue-to-grade demonstration. No flags.',
  };
  emit({
    help:
      blocks[key] ??
      `unknown help topic: ${key}; valid topics: ${Object.keys(blocks).filter(Boolean).join(', ')}`,
  });
  return blocks[key] ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();

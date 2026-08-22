import {
  ensureArray,
  ensureBoolean,
  ensureNumber,
  ensureRecord,
  ensureString,
  enumValue,
  rejectUnknown,
  SchemaError,
} from './util.js';

export const SCHEMA_VERSION = 'v1';
export type IssueState = 'open' | 'closed';
export type TaskRisk = 'normal' | 'security_sensitive' | 'destructive' | 'oversized' | 'ambiguous';
export type QueueState =
  'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'review' | 'cancelled';
export type AgentState =
  'inspect' | 'reproduce' | 'plan' | 'edit' | 'test' | 'self_review' | 'terminal';
export type TerminalOutcome =
  | 'resolved'
  | 'regression'
  | 'pre_existing_failure'
  | 'policy_rejected'
  | 'human_review'
  | 'budget_exhausted'
  | 'timed_out'
  | 'cancelled'
  | 'failed';

export interface RepositoryPolicy {
  schemaVersion: typeof SCHEMA_VERSION;
  repository: string;
  allowedStates: IssueState[];
  optInLabels: string[];
  forbiddenPaths: string[];
  allowedPaths: string[];
  allowedCommands: string[];
  maxIssueChars: number;
  maxPatchBytes: number;
  maxCommandMs: number;
  requireHumanReviewFor: TaskRisk[];
}

export interface NormalizedIssueTask {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  deliveryKey: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  comments: string[];
  links: string[];
  state: IssueState;
  labels: string[];
  author: string;
  baseCommit: string;
  policy: RepositoryPolicy;
  risk: TaskRisk;
  receivedAt: string;
  source: 'webhook' | 'poll' | 'fixture' | 'replay';
}

export interface ProviderModelProfile {
  provider: 'openai' | 'openai-codex';
  model: string;
  auth: 'api_key' | 'oauth';
  runtime: string;
}

export interface Budget {
  schemaVersion: typeof SCHEMA_VERSION;
  maxSteps: number;
  maxModelCalls: number;
  maxRetriesPerState: number;
  timeoutMs: number;
  maxOutputChars: number;
  maxPatchBytes: number;
  maxInputChars: number;
}

export interface RunEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  sequence: number;
  at: string;
  type:
    | 'state_entered'
    | 'state_exited'
    | 'tool_call'
    | 'tool_result'
    | 'check'
    | 'warning'
    | 'terminal';
  state: AgentState;
  data: Record<string, string | number | boolean | null>;
}

export interface RunManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  status: QueueState;
  agentState: AgentState;
  repository: string;
  baseCommit: string;
  provider: ProviderModelProfile;
  harnessVersion: string;
  budget: Budget;
  artifactIds: string[];
  terminal?: TerminalOutcome;
  failureCategory?: string;
}

export interface CheckOutcome {
  name: string;
  command: string;
  phase: 'baseline' | 'candidate' | 'hidden';
  status: 'passed' | 'failed' | 'skipped' | 'pre_existing_failure';
  exitCode?: number;
  durationMs: number;
  output: string;
}

export interface GradingEvidence {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  runId: string;
  resolvedAt1: boolean;
  regressionFree: boolean;
  patchScopeValid: boolean;
  forbiddenPathsTouched: string[];
  checks: CheckOutcome[];
  elapsedMs: number;
  failureCategory?: string;
  residualRisks: string[];
}

export interface ArtifactRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind:
    | 'issue'
    | 'patch'
    | 'event_log'
    | 'check_output'
    | 'evidence'
    | 'manifest'
    | 'workspace_snapshot';
  sha256: string;
  bytes: number;
  createdAt: string;
  relativePath: string;
}

export interface TerminalRecord {
  outcome: TerminalOutcome;
  reason: string;
  at: string;
  failureCategory?: string;
  residualRisks: string[];
}

export interface GitHubIssueInput {
  action: string;
  deliveryId: string;
  repository: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: Array<{ name: string }>;
    user: { login: string } | null;
    pull_request?: unknown;
  };
  comments?: Array<{ body: string | null; user: { login: string } | null; html_url?: string }>;
  issueUrl?: string;
  baseCommit: string;
}

function required<T>(
  record: Record<string, unknown>,
  key: string,
  fn: (v: unknown, path: string) => T,
  path: string,
): T {
  if (!(key in record)) throw new SchemaError(`${path}.${key} is required`);
  return fn(record[key], `${path}.${key}`);
}

function optional<T>(
  record: Record<string, unknown>,
  key: string,
  fn: (v: unknown, path: string) => T,
  path: string,
): T | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  return fn(record[key], `${path}.${key}`);
}

function stringArray(value: unknown, path: string, max = 1000): string[] {
  return ensureArray(value, path).map((item, i) =>
    ensureString(item, `${path}[${i}]`, { max, nonEmpty: true }),
  );
}

export function parseRepositoryPolicy(input: unknown): RepositoryPolicy {
  const r = ensureRecord(input, 'policy');
  rejectUnknown(
    r,
    [
      'schemaVersion',
      'repository',
      'allowedStates',
      'optInLabels',
      'forbiddenPaths',
      'allowedPaths',
      'allowedCommands',
      'maxIssueChars',
      'maxPatchBytes',
      'maxCommandMs',
      'requireHumanReviewFor',
    ],
    'policy',
  );
  const version = required(r, 'schemaVersion', (v, p) => ensureString(v, p), 'policy');
  if (version !== SCHEMA_VERSION) throw new SchemaError('policy.schemaVersion is unsupported');
  return {
    schemaVersion: SCHEMA_VERSION,
    repository: required(
      r,
      'repository',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'policy',
    ),
    allowedStates: stringArray(r.allowedStates, 'policy.allowedStates').map((v) =>
      enumValue(v, ['open', 'closed'] as const, 'policy.allowedStates'),
    ),
    optInLabels: stringArray(r.optInLabels, 'policy.optInLabels'),
    forbiddenPaths: stringArray(r.forbiddenPaths, 'policy.forbiddenPaths'),
    allowedPaths: stringArray(r.allowedPaths, 'policy.allowedPaths'),
    allowedCommands: stringArray(r.allowedCommands, 'policy.allowedCommands'),
    maxIssueChars: required(
      r,
      'maxIssueChars',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'policy',
    ),
    maxPatchBytes: required(
      r,
      'maxPatchBytes',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'policy',
    ),
    maxCommandMs: required(
      r,
      'maxCommandMs',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'policy',
    ),
    requireHumanReviewFor: stringArray(r.requireHumanReviewFor, 'policy.requireHumanReviewFor').map(
      (v) =>
        enumValue(
          v,
          ['security_sensitive', 'destructive', 'oversized', 'ambiguous'] as const,
          'policy.requireHumanReviewFor',
        ),
    ),
  };
}

export function parseNormalizedTask(input: unknown): NormalizedIssueTask {
  const r = ensureRecord(input, 'task');
  rejectUnknown(
    r,
    [
      'schemaVersion',
      'id',
      'deliveryKey',
      'repository',
      'number',
      'title',
      'body',
      'comments',
      'links',
      'state',
      'labels',
      'author',
      'baseCommit',
      'policy',
      'risk',
      'receivedAt',
      'source',
    ],
    'task',
  );
  const version = required(r, 'schemaVersion', (v, p) => ensureString(v, p), 'task');
  if (version !== SCHEMA_VERSION) throw new SchemaError('task.schemaVersion is unsupported');
  return {
    schemaVersion: SCHEMA_VERSION,
    id: required(r, 'id', (v, p) => ensureString(v, p, { nonEmpty: true, max: 300 }), 'task'),
    deliveryKey: required(
      r,
      'deliveryKey',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 500 }),
      'task',
    ),
    repository: required(r, 'repository', (v, p) => ensureString(v, p, { nonEmpty: true }), 'task'),
    number: required(r, 'number', (v, p) => ensureNumber(v, p, { integer: true, min: 1 }), 'task'),
    title: required(r, 'title', (v, p) => ensureString(v, p, { nonEmpty: true, max: 500 }), 'task'),
    body: required(r, 'body', (v, p) => ensureString(v, p, { max: 100_000 }), 'task'),
    comments: stringArray(r.comments, 'task.comments', 20_000),
    links: stringArray(r.links, 'task.links', 2_000),
    state: required(r, 'state', (v, p) => enumValue(v, ['open', 'closed'] as const, p), 'task'),
    labels: stringArray(r.labels, 'task.labels', 200),
    author: required(
      r,
      'author',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 200 }),
      'task',
    ),
    baseCommit: required(
      r,
      'baseCommit',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 200 }),
      'task',
    ),
    policy: parseRepositoryPolicy(r.policy),
    risk: required(
      r,
      'risk',
      (v, p) =>
        enumValue(
          v,
          ['normal', 'security_sensitive', 'destructive', 'oversized', 'ambiguous'] as const,
          p,
        ),
      'task',
    ),
    receivedAt: required(r, 'receivedAt', (v, p) => ensureString(v, p, { nonEmpty: true }), 'task'),
    source: required(
      r,
      'source',
      (v, p) => enumValue(v, ['webhook', 'poll', 'fixture', 'replay'] as const, p),
      'task',
    ),
  };
}

export function parseProviderProfile(input: unknown): ProviderModelProfile {
  const r = ensureRecord(input, 'provider');
  rejectUnknown(r, ['provider', 'model', 'auth', 'runtime'], 'provider');
  return {
    provider: required(
      r,
      'provider',
      (v, p) => enumValue(v, ['openai', 'openai-codex'] as const, p),
      'provider',
    ),
    model: required(
      r,
      'model',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 200 }),
      'provider',
    ),
    auth: required(r, 'auth', (v, p) => enumValue(v, ['api_key', 'oauth'] as const, p), 'provider'),
    runtime: required(
      r,
      'runtime',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 200 }),
      'provider',
    ),
  };
}

export function parseBudget(input: unknown): Budget {
  const r = ensureRecord(input, 'budget');
  rejectUnknown(
    r,
    [
      'schemaVersion',
      'maxSteps',
      'maxModelCalls',
      'maxRetriesPerState',
      'timeoutMs',
      'maxOutputChars',
      'maxPatchBytes',
      'maxInputChars',
    ],
    'budget',
  );
  return {
    schemaVersion: required(
      r,
      'schemaVersion',
      (v, p) => enumValue(v, [SCHEMA_VERSION] as const, p),
      'budget',
    ),
    maxSteps: required(
      r,
      'maxSteps',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
    maxModelCalls: required(
      r,
      'maxModelCalls',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
    maxRetriesPerState: required(
      r,
      'maxRetriesPerState',
      (v, p) => ensureNumber(v, p, { integer: true, min: 0 }),
      'budget',
    ),
    timeoutMs: required(
      r,
      'timeoutMs',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
    maxOutputChars: required(
      r,
      'maxOutputChars',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
    maxPatchBytes: required(
      r,
      'maxPatchBytes',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
    maxInputChars: required(
      r,
      'maxInputChars',
      (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
      'budget',
    ),
  };
}

export function parseRunEvent(input: unknown): RunEvent {
  const r = ensureRecord(input, 'event');
  rejectUnknown(r, ['schemaVersion', 'runId', 'sequence', 'at', 'type', 'state', 'data'], 'event');
  const dataRecord = ensureRecord(
    required(r, 'data', (v) => v, 'event'),
    'event.data',
  );
  for (const [key, value] of Object.entries(dataRecord)) {
    if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null)
      throw new SchemaError(`event.data.${key} must be scalar`);
  }
  return {
    schemaVersion: required(
      r,
      'schemaVersion',
      (v, p) => enumValue(v, [SCHEMA_VERSION] as const, p),
      'event',
    ),
    runId: required(r, 'runId', (v, p) => ensureString(v, p, { nonEmpty: true }), 'event'),
    sequence: required(
      r,
      'sequence',
      (v, p) => ensureNumber(v, p, { integer: true, min: 0 }),
      'event',
    ),
    at: required(r, 'at', (v, p) => ensureString(v, p, { nonEmpty: true }), 'event'),
    type: required(
      r,
      'type',
      (v, p) =>
        enumValue(
          v,
          [
            'state_entered',
            'state_exited',
            'tool_call',
            'tool_result',
            'check',
            'warning',
            'terminal',
          ] as const,
          p,
        ),
      'event',
    ),
    state: required(
      r,
      'state',
      (v, p) =>
        enumValue(
          v,
          ['inspect', 'reproduce', 'plan', 'edit', 'test', 'self_review', 'terminal'] as const,
          p,
        ),
      'event',
    ),
    data: dataRecord as RunEvent['data'],
  };
}

export function parseRunManifest(input: unknown): RunManifest {
  const r = ensureRecord(input, 'manifest');
  rejectUnknown(
    r,
    [
      'schemaVersion',
      'runId',
      'taskId',
      'createdAt',
      'updatedAt',
      'status',
      'agentState',
      'repository',
      'baseCommit',
      'provider',
      'harnessVersion',
      'budget',
      'artifactIds',
      'terminal',
      'failureCategory',
    ],
    'manifest',
  );
  return {
    schemaVersion: required(
      r,
      'schemaVersion',
      (v, p) => enumValue(v, [SCHEMA_VERSION] as const, p),
      'manifest',
    ),
    runId: required(r, 'runId', (v, p) => ensureString(v, p, { nonEmpty: true }), 'manifest'),
    taskId: required(r, 'taskId', (v, p) => ensureString(v, p, { nonEmpty: true }), 'manifest'),
    createdAt: required(
      r,
      'createdAt',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'manifest',
    ),
    updatedAt: required(
      r,
      'updatedAt',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'manifest',
    ),
    status: required(
      r,
      'status',
      (v, p) =>
        enumValue(
          v,
          ['queued', 'claimed', 'running', 'succeeded', 'failed', 'review', 'cancelled'] as const,
          p,
        ),
      'manifest',
    ),
    agentState: required(
      r,
      'agentState',
      (v, p) =>
        enumValue(
          v,
          ['inspect', 'reproduce', 'plan', 'edit', 'test', 'self_review', 'terminal'] as const,
          p,
        ),
      'manifest',
    ),
    repository: required(
      r,
      'repository',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'manifest',
    ),
    baseCommit: required(
      r,
      'baseCommit',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'manifest',
    ),
    provider: parseProviderProfile(required(r, 'provider', (v) => v, 'manifest')),
    harnessVersion: required(
      r,
      'harnessVersion',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'manifest',
    ),
    budget: parseBudget(required(r, 'budget', (v) => v, 'manifest')),
    artifactIds: stringArray(r.artifactIds, 'manifest.artifactIds', 500),
    terminal: optional(
      r,
      'terminal',
      (v, p) =>
        enumValue(
          v,
          [
            'resolved',
            'regression',
            'pre_existing_failure',
            'policy_rejected',
            'human_review',
            'budget_exhausted',
            'timed_out',
            'cancelled',
            'failed',
          ] as const,
          p,
        ),
      'manifest',
    ),
    failureCategory: optional(
      r,
      'failureCategory',
      (v, p) => ensureString(v, p, { max: 200 }),
      'manifest',
    ),
  };
}

export function parseGradingEvidence(input: unknown): GradingEvidence {
  const r = ensureRecord(input, 'evidence');
  rejectUnknown(
    r,
    [
      'schemaVersion',
      'taskId',
      'runId',
      'resolvedAt1',
      'regressionFree',
      'patchScopeValid',
      'forbiddenPathsTouched',
      'checks',
      'elapsedMs',
      'failureCategory',
      'residualRisks',
    ],
    'evidence',
  );
  const checks = ensureArray(r.checks, 'evidence.checks').map((value, i) => {
    const c = ensureRecord(value, `evidence.checks[${i}]`);
    rejectUnknown(
      c,
      ['name', 'command', 'phase', 'status', 'exitCode', 'durationMs', 'output'],
      `evidence.checks[${i}]`,
    );
    return {
      name: required(
        c,
        'name',
        (v, p) => ensureString(v, p, { nonEmpty: true }),
        `evidence.checks[${i}]`,
      ),
      command: required(
        c,
        'command',
        (v, p) => ensureString(v, p, { nonEmpty: true }),
        `evidence.checks[${i}]`,
      ),
      phase: required(
        c,
        'phase',
        (v, p) => enumValue(v, ['baseline', 'candidate', 'hidden'] as const, p),
        `evidence.checks[${i}]`,
      ),
      status: required(
        c,
        'status',
        (v, p) => enumValue(v, ['passed', 'failed', 'skipped', 'pre_existing_failure'] as const, p),
        `evidence.checks[${i}]`,
      ),
      exitCode: optional(
        c,
        'exitCode',
        (v, p) => ensureNumber(v, p, { integer: true }),
        `evidence.checks[${i}]`,
      ),
      durationMs: required(
        c,
        'durationMs',
        (v, p) => ensureNumber(v, p, { integer: true, min: 0 }),
        `evidence.checks[${i}]`,
      ),
      output: required(
        c,
        'output',
        (v, p) => ensureString(v, p, { max: 100_000 }),
        `evidence.checks[${i}]`,
      ),
    } satisfies CheckOutcome;
  });
  return {
    schemaVersion: required(
      r,
      'schemaVersion',
      (v, p) => enumValue(v, [SCHEMA_VERSION] as const, p),
      'evidence',
    ),
    taskId: required(r, 'taskId', (v, p) => ensureString(v, p, { nonEmpty: true }), 'evidence'),
    runId: required(r, 'runId', (v, p) => ensureString(v, p, { nonEmpty: true }), 'evidence'),
    resolvedAt1: required(r, 'resolvedAt1', ensureBoolean, 'evidence'),
    regressionFree: required(r, 'regressionFree', ensureBoolean, 'evidence'),
    patchScopeValid: required(r, 'patchScopeValid', ensureBoolean, 'evidence'),
    forbiddenPathsTouched: stringArray(r.forbiddenPathsTouched, 'evidence.forbiddenPathsTouched'),
    checks,
    elapsedMs: required(
      r,
      'elapsedMs',
      (v, p) => ensureNumber(v, p, { integer: true, min: 0 }),
      'evidence',
    ),
    failureCategory: optional(
      r,
      'failureCategory',
      (v, p) => ensureString(v, p, { max: 200 }),
      'evidence',
    ),
    residualRisks: stringArray(r.residualRisks, 'evidence.residualRisks'),
  };
}

export function parseTerminalRecord(input: unknown): TerminalRecord {
  const r = ensureRecord(input, 'terminal');
  rejectUnknown(r, ['outcome', 'reason', 'at', 'failureCategory', 'residualRisks'], 'terminal');
  return {
    outcome: required(
      r,
      'outcome',
      (v, p) =>
        enumValue(
          v,
          [
            'resolved',
            'regression',
            'pre_existing_failure',
            'policy_rejected',
            'human_review',
            'budget_exhausted',
            'timed_out',
            'cancelled',
            'failed',
          ] as const,
          p,
        ),
      'terminal',
    ),
    reason: required(
      r,
      'reason',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 10_000 }),
      'terminal',
    ),
    at: required(r, 'at', (v, p) => ensureString(v, p, { nonEmpty: true }), 'terminal'),
    failureCategory: optional(
      r,
      'failureCategory',
      (v, p) => ensureString(v, p, { max: 200 }),
      'terminal',
    ),
    residualRisks: stringArray(r.residualRisks, 'terminal.residualRisks', 10_000),
  };
}

export function parseArtifactRecord(input: unknown): ArtifactRecord {
  const r = ensureRecord(input, 'artifact');
  rejectUnknown(
    r,
    ['schemaVersion', 'id', 'kind', 'sha256', 'bytes', 'createdAt', 'relativePath'],
    'artifact',
  );
  return {
    schemaVersion: required(
      r,
      'schemaVersion',
      (v, p) => enumValue(v, [SCHEMA_VERSION] as const, p),
      'artifact',
    ),
    id: required(r, 'id', (v, p) => ensureString(v, p, { nonEmpty: true }), 'artifact'),
    kind: required(
      r,
      'kind',
      (v, p) =>
        enumValue(
          v,
          [
            'issue',
            'patch',
            'event_log',
            'check_output',
            'evidence',
            'manifest',
            'workspace_snapshot',
          ] as const,
          p,
        ),
      'artifact',
    ),
    sha256: required(
      r,
      'sha256',
      (v, p) => ensureString(v, p, { nonEmpty: true, max: 64 }),
      'artifact',
    ),
    bytes: required(
      r,
      'bytes',
      (v, p) => ensureNumber(v, p, { integer: true, min: 0 }),
      'artifact',
    ),
    createdAt: required(
      r,
      'createdAt',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'artifact',
    ),
    relativePath: required(
      r,
      'relativePath',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'artifact',
    ),
  };
}

export function parseGitHubIssueInput(input: unknown): GitHubIssueInput {
  const r = ensureRecord(input, 'github');
  rejectUnknown(
    r,
    ['action', 'deliveryId', 'repository', 'issue', 'comments', 'issueUrl', 'baseCommit'],
    'github',
  );
  const issue = ensureRecord(
    required(r, 'issue', (v) => v, 'github'),
    'github.issue',
  );
  rejectUnknown(
    issue,
    ['number', 'title', 'body', 'state', 'labels', 'user', 'pull_request'],
    'github.issue',
  );
  const labels = ensureArray(issue.labels, 'github.issue.labels').map((value, i) => {
    const label = ensureRecord(value, `github.issue.labels[${i}]`);
    rejectUnknown(label, ['name'], `github.issue.labels[${i}]`);
    return {
      name: required(
        label,
        'name',
        (v, p) => ensureString(v, p, { nonEmpty: true, max: 200 }),
        `github.issue.labels[${i}]`,
      ),
    };
  });
  const user = issue.user === null ? null : ensureRecord(issue.user, 'github.issue.user');
  return {
    action: required(r, 'action', (v, p) => ensureString(v, p, { nonEmpty: true }), 'github'),
    deliveryId: required(
      r,
      'deliveryId',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'github',
    ),
    repository: required(
      r,
      'repository',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'github',
    ),
    issue: {
      number: required(
        issue,
        'number',
        (v, p) => ensureNumber(v, p, { integer: true, min: 1 }),
        'github.issue',
      ),
      title: required(
        issue,
        'title',
        (v, p) => ensureString(v, p, { nonEmpty: true, max: 500 }),
        'github.issue',
      ),
      body:
        issue.body === null
          ? null
          : ensureString(issue.body, 'github.issue.body', { max: 100_000 }),
      state: required(
        issue,
        'state',
        (v, p) => ensureString(v, p, { nonEmpty: true }),
        'github.issue',
      ),
      labels,
      user:
        user === null
          ? null
          : {
              login: required(
                user,
                'login',
                (v, p) => ensureString(v, p, { nonEmpty: true }),
                'github.issue.user',
              ),
            },
      pull_request: issue.pull_request,
    },
    comments: optional(
      r,
      'comments',
      (v, p) =>
        ensureArray(v, p).map((item, i) => {
          const comment = ensureRecord(item, `${p}[${i}]`);
          rejectUnknown(comment, ['body', 'user', 'html_url'], `${p}[${i}]`);
          const commentUser =
            comment.user === null ? null : ensureRecord(comment.user, `${p}[${i}].user`);
          return {
            body:
              comment.body === null
                ? null
                : ensureString(comment.body, `${p}[${i}].body`, { max: 20_000 }),
            user:
              commentUser === null
                ? null
                : {
                    login: required(
                      commentUser,
                      'login',
                      (v2, p2) => ensureString(v2, p2, { nonEmpty: true }),
                      `${p}[${i}].user`,
                    ),
                  },
            html_url: optional(
              comment,
              'html_url',
              (v2, p2) => ensureString(v2, p2, { max: 2_000 }),
              `${p}[${i}]`,
            ),
          };
        }),
      'github',
    ),
    issueUrl: optional(r, 'issueUrl', (v, p) => ensureString(v, p, { max: 2_000 }), 'github'),
    baseCommit: required(
      r,
      'baseCommit',
      (v, p) => ensureString(v, p, { nonEmpty: true }),
      'github',
    ),
  };
}

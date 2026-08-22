import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRunner } from '../src/agent.js';
import { FileCredentialStore, authStatus } from '../src/auth.js';
import { FakeTransport, ReplayTransport, taskPrompt } from '../src/model.js';
import { gradeBenchmark, listBenchmarkTasks, materializeBenchmarkTask } from '../src/benchmarks.js';
import { GitHubPollingAdapter, GitHubWebhookAdapter } from '../src/github.js';
import { DurableQueue } from '../src/queue.js';
import { ArtifactStore } from '../src/storage.js';
import { parseNormalizedTask, SCHEMA_VERSION } from '../src/schema.js';
import { makeWorkspace } from '../src/workspace.js';
import { nowIso, redactSecrets, sha256 } from '../src/util.js';

function policy(repository: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    repository,
    allowedStates: ['open'] as const,
    optInLabels: [],
    forbiddenPaths: ['.env', '.git/**'],
    allowedPaths: ['src/**', 'test/**'],
    allowedCommands: ['node-test'],
    maxIssueChars: 20_000,
    maxPatchBytes: 100_000,
    maxCommandMs: 2_000,
    requireHumanReviewFor: ['security_sensitive', 'destructive', 'oversized', 'ambiguous'] as const,
  };
}

function task(id: string, repository = 'acme/repo') {
  return parseNormalizedTask({
    schemaVersion: SCHEMA_VERSION,
    id,
    deliveryKey: `delivery:${id}`,
    repository,
    number: 1,
    title: 'Fix a fixture',
    body: 'Please fix the fixture.',
    comments: [],
    links: [],
    state: 'open',
    labels: [],
    author: 'tester',
    baseCommit: 'base-1',
    policy: policy(repository),
    risk: 'normal',
    receivedAt: nowIso(),
    source: 'fixture',
  });
}

test('schemas reject unknown critical fields', () => {
  assert.throws(
    () => parseNormalizedTask({ ...task('schema-task'), unknown: true }),
    /not a recognized field/,
  );
});

test('queue is durable and idempotent and recovers an expired lease', async () => {
  const root = await mkdtemp('/tmp/issue-harness-queue-');
  const queue = new DurableQueue(root);
  await queue.init();
  const first = await queue.enqueue(task('q1'));
  const duplicate = await queue.enqueue(task('q2')); // distinct delivery key, so this is a separate task
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, true);
  const sameDelivery = await queue.enqueue({ ...task('q3'), deliveryKey: 'delivery:q1', id: 'q3' });
  assert.equal(sameDelivery.accepted, false);
  assert.equal(sameDelivery.taskId, 'q1');
  const claimed = await queue.claimNext(1);
  assert.ok(claimed);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await queue.recoverExpired(), ['q1']);
  const reopened = new DurableQueue(root);
  await reopened.init();
  assert.equal((await reopened.get('q1'))?.entry.state, 'queued');
});

test('webhook verifies signatures, filters events, and deduplicates retries', async () => {
  const root = await mkdtemp('/tmp/issue-harness-webhook-');
  const queue = new DurableQueue(root);
  await queue.init();
  const secret = ['fixture', '-secret'].join('');
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/repo', default_branch: 'main' },
    issue: {
      number: 7,
      title: 'Fix it',
      body: 'A small fix',
      state: 'open',
      labels: [],
      user: { login: 'alice' },
    },
  });
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const adapter = new GitHubWebhookAdapter({
    secret,
    queue,
    policyFor: (repository) => (repository === 'acme/repo' ? policy(repository) : undefined),
  });
  await assert.rejects(
    () => adapter.ingest({ body, signature: 'sha256=forged', event: 'issues', delivery: '1' }),
    /invalid GitHub webhook signature/,
  );
  const accepted = await adapter.ingest({ body, signature, event: 'issues', delivery: '1' });
  assert.equal(accepted.accepted, true);
  const retry = await adapter.ingest({ body, signature, event: 'issues', delivery: '1' });
  assert.equal(retry.accepted, false);
  const ignored = await adapter.ingest({ body, signature, event: 'push', delivery: '2' });
  assert.equal(ignored.accepted, false);
});

test('poll reconciliation persists a cursor and handles out-of-order results', async () => {
  const root = await mkdtemp('/tmp/issue-harness-poll-');
  const queue = new DurableQueue(root);
  await queue.init();
  const issues = [
    {
      repository: 'acme/repo',
      number: 2,
      title: 'newer',
      body: 'fix',
      state: 'open',
      labels: [],
      author: 'a',
      updatedAt: '2025-01-02T00:00:00Z',
      baseCommit: 'b',
      comments: [],
    },
    {
      repository: 'acme/repo',
      number: 1,
      title: 'older',
      body: 'fix',
      state: 'open',
      labels: [],
      author: 'a',
      updatedAt: '2025-01-01T00:00:00Z',
      baseCommit: 'b',
      comments: [],
    },
  ];
  let cursor: string | undefined;
  const adapter = new GitHubPollingAdapter({
    client: { listIssues: async () => issues },
    queue,
    policyFor: (repository) => policy(repository),
    checkpoint: {
      get: async () => cursor,
      set: async (value) => {
        cursor = value;
      },
    },
  });
  const result = await adapter.reconcile('acme/repo');
  assert.equal(result.filter((item) => item.accepted).length, 2);
  assert.equal(cursor, '2025-01-02T00:00:00Z');
  const retry = await adapter.reconcile('acme/repo');
  assert.equal(retry.filter((item) => item.accepted).length, 0);
  assert.ok(retry.every((item) => item.reason?.includes('duplicate')));
});

test('workspace tools defend boundaries, redact output, and enforce commands', async () => {
  const root = await mkdtemp('/tmp/issue-harness-workspace-');
  const fixtureToken = ['sk-', 'fixture-secret-value'].join('');
  await writeFile(join(root, 'src.txt'), `token=${fixtureToken}\n`, 'utf8');
  const workspace = await makeWorkspace(root, {
    allowedCommands: ['node-test'],
    allowedPaths: ['src.txt'],
    forbiddenPaths: ['.env'],
  });
  const inspected = await workspace.inspect('src.txt');
  assert.match(inspected.content, /REDACTED/);
  await assert.rejects(() => workspace.inspect('../outside'), /workspace/);
  await assert.rejects(
    () =>
      workspace.run({
        name: 'shell',
        executable: 'sh',
        args: ['-c', 'true'],
        timeoutMs: 100,
        maxOutputChars: 100,
      }),
    /not allowlisted/,
  );
  await assert.rejects(() => workspace.exactEdit('src.txt', sha256('wrong'), 'x'), /precondition/);
  await assert.rejects(
    () =>
      workspace.exactEdit('src.txt', sha256(`token=${fixtureToken}\n`), `token=${fixtureToken}`),
    /secret-like/,
  );

  const outside = await mkdtemp('/tmp/issue-harness-outside-');
  await writeFile(join(outside, 'secret.txt'), 'private', 'utf8');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  const symlinkWorkspace = await makeWorkspace(root, {
    allowedCommands: [],
    allowedPaths: ['link.txt'],
    forbiddenPaths: [],
  });
  await assert.rejects(() => symlinkWorkspace.inspect('link.txt'), /symlink/);

  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = fixtureToken;
  try {
    await writeFile(
      join(root, 'check.mjs'),
      'import test from "node:test"; test("env", () => { if (process.env.OPENAI_API_KEY) throw new Error("secret inherited"); });',
      'utf8',
    );
    const checkWorkspace = await makeWorkspace(root, {
      allowedCommands: ['node-test'],
      allowedPaths: ['check.mjs'],
      forbiddenPaths: [],
    });
    const result = await checkWorkspace.run({
      name: 'node-test',
      executable: 'node',
      args: ['--test', 'check.mjs'],
      timeoutMs: 1_000,
      maxOutputChars: 1_000,
    });
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fixture-secret-value/);
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }

  const artifacts = new ArtifactStore(join(root, 'artifacts'));
  await artifacts.init();
  const record = await artifacts.put('evidence', `token=${fixtureToken}`);
  assert.doesNotMatch((await artifacts.get(record)).toString('utf8'), /fixture-secret-value/);
});

test('credential store is private and status never exposes credential values', async () => {
  const root = await mkdtemp('/tmp/issue-harness-auth-');
  const store = new FileCredentialStore(join(root, 'auth.json'));
  const storedKey = ['sk-', 'fixture-auth-secret-value'].join('');
  await store.modify('openai', async () => ({ type: 'api_key', key: storedKey }));
  const info = await authStatus(store);
  assert.deepEqual(info.providers, [{ provider: 'openai', type: 'api_key' }]);
  assert.equal((await stat(store.filePath)).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(info), /sk-test/);
  assert.doesNotMatch(
    JSON.stringify(info),
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('redaction covers realistic provider and browser credential shapes', () => {
  const apiKey = ['sk-proj-', 'fixture-key-material-123456'].join('');
  const githubToken = ['github_pat_', 'fixture-token-material-123456'].join('');
  const bearer = ['Bearer ', 'fixture-bearer-material-123456'].join('');
  const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const slackToken = ['xoxb-', 'fixture-slack-material-123456'].join('');
  const jwt = [
    'eyJ',
    'fixtureheader123456',
    '.',
    'fixturesignature123456',
    '.',
    'fixtureclaim123456',
  ].join('');
  const privateKey = [
    ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join(''),
    'fixture-private-material',
    ['-----END OPENSSH ', 'PRIVATE KEY-----'].join(''),
  ].join('\\n');
  const input = [
    `OPENAI_API_KEY=${apiKey}`,
    `Authorization: ${bearer}`,
    `github_pat=${githubToken}`,
    `AWS_ACCESS_KEY_ID=${awsKey}`,
    `token=${slackToken}`,
    `session_token: "${jwt}"`,
    privateKey,
  ].join('\\n');
  const output = redactSecrets(input);
  for (const secret of [apiKey, githubToken, bearer.slice(7), awsKey, slackToken, jwt, privateKey])
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')));
  assert.match(output, /REDACTED/);
});

test('task prompts redact untrusted issue content', () => {
  const promptKey = ['sk-proj-', 'fixture-prompt-material-123456'].join('');
  const prompt = taskPrompt({ ...task('prompt-secret'), body: `Use token=${promptKey}.` });
  assert.doesNotMatch(prompt.prompt, new RegExp(promptKey));
  assert.match(prompt.prompt, /REDACTED/);
});

test('fake and replay transports have deterministic contracts', async () => {
  const replay = new ReplayTransport([{ text: 'ok', toolCalls: [] }]);
  assert.deepEqual(
    await replay.complete({
      profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'replay' },
      system: '',
      prompt: '',
      history: [],
      budget: {
        schemaVersion: SCHEMA_VERSION,
        maxSteps: 1,
        maxModelCalls: 1,
        maxRetriesPerState: 0,
        timeoutMs: 1000,
        maxOutputChars: 100,
        maxPatchBytes: 100,
        maxInputChars: 100,
      },
    }),
    { text: 'ok', toolCalls: [] },
  );
  await assert.rejects(
    () =>
      replay.complete({
        profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'replay' },
        system: '',
        prompt: '',
        history: [],
        budget: {
          schemaVersion: SCHEMA_VERSION,
          maxSteps: 1,
          maxModelCalls: 1,
          maxRetriesPerState: 0,
          timeoutMs: 1000,
          maxOutputChars: 100,
          maxPatchBytes: 100,
          maxInputChars: 100,
        },
      }),
    /no response/,
  );
});

test('agent transitions through every bounded state with a fake transport', async () => {
  const root = await mkdtemp('/tmp/issue-harness-agent-');
  const workspace = await makeWorkspace(root, {
    allowedCommands: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
  });
  const responses = Array.from({ length: 6 }, (_, index) => ({
    text: `step ${index}`,
    toolCalls: [],
  }));
  responses[5] = {
    text: 'done',
    toolCalls: [{ id: 'finish', name: 'finish', arguments: { reason: 'complete' } }],
  };
  const runner = new AgentRunner({
    task: task('agent-task'),
    workspace,
    transport: new FakeTransport(async (_request, call) => responses[call - 1] ?? responses[5]),
    profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'fake' },
    budget: {
      schemaVersion: SCHEMA_VERSION,
      maxSteps: 10,
      maxModelCalls: 8,
      maxRetriesPerState: 0,
      timeoutMs: 1000,
      maxOutputChars: 1000,
      maxPatchBytes: 1000,
      maxInputChars: 1000,
    },
  });
  const result = await runner.run();
  assert.equal(result.terminal.outcome, 'resolved');
  assert.deepEqual(
    new Set(
      result.events.filter((event) => event.type === 'state_entered').map((event) => event.state),
    ),
    new Set(['inspect', 'reproduce', 'plan', 'edit', 'test', 'self_review', 'terminal']),
  );
});

test('agent cancellation and budgets produce explicit terminal reasons', async () => {
  const root = await mkdtemp('/tmp/issue-harness-budget-');
  const workspace = await makeWorkspace(root, {
    allowedCommands: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
  });
  const budget = {
    schemaVersion: SCHEMA_VERSION,
    maxSteps: 1,
    maxModelCalls: 1,
    maxRetriesPerState: 0,
    timeoutMs: 1000,
    maxOutputChars: 1000,
    maxPatchBytes: 1000,
    maxInputChars: 1000,
  } as const;
  const exhausted = await new AgentRunner({
    task: task('budget-task'),
    workspace,
    transport: new FakeTransport(() => ({ text: '', toolCalls: [] })),
    profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'fake' },
    budget,
  }).run();
  assert.equal(exhausted.terminal.outcome, 'budget_exhausted');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await new AgentRunner({
    task: task('cancel-task'),
    workspace,
    transport: new FakeTransport(() => ({ text: '', toolCalls: [] })),
    profile: { provider: 'openai', model: 'fake', auth: 'api_key', runtime: 'fake' },
    budget: { ...budget, maxSteps: 2 },
    signal: controller.signal,
  }).run();
  assert.equal(cancelled.terminal.outcome, 'cancelled');
});

test('all ten benchmark tasks grade deterministically and baseline is known failing', async () => {
  const root = await mkdtemp('/tmp/issue-harness-bench-');
  for (const taskView of listBenchmarkTasks()) {
    const attempt = join(root, taskView.id);
    await materializeBenchmarkTask(taskView.id, attempt, 'solution');
    const first = await gradeBenchmark({ taskId: taskView.id, attempt });
    const second = await gradeBenchmark({ taskId: taskView.id, attempt });
    assert.equal(first.summary.resolvedAt1, true, taskView.id);
    assert.equal(first.summary.regressionFree, true, taskView.id);
    assert.equal(second.summary.resolvedAt1, first.summary.resolvedAt1);
    assert.ok(
      first.evidence.checks.some(
        (check) => check.phase === 'baseline' && check.status === 'failed',
      ),
    );
  }
});

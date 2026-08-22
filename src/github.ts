import { createHmac } from 'node:crypto';
import { SCHEMA_VERSION, parseGitHubIssueInput } from './schema.js';
import type { NormalizedIssueTask, GitHubIssueInput, RepositoryPolicy } from './schema.js';
import type { DurableQueue } from './queue.js';
import {
  hmacEqual,
  nowIso,
  HarnessError,
  SchemaError,
  sha256,
  ensureString,
  redactSecrets,
} from './util.js';

export interface IntakeResult {
  accepted: boolean;
  task?: NormalizedIssueTask;
  reason?: string;
  duplicateOf?: string;
}

export interface IssueSourceAdapter {
  ingest(input: unknown): Promise<IntakeResult>;
}

export interface WebhookRequest {
  body: string;
  signature: string | undefined;
  event: string | undefined;
  delivery: string | undefined;
}

export interface PollIssue {
  repository: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  author: string;
  updatedAt: string;
  baseCommit: string;
  comments: string[];
  links?: string[];
}

export interface GitHubPollClient {
  listIssues(repository: string, updatedAfter: string | undefined): Promise<PollIssue[]>;
}

export function verifyGithubSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith('sha256=') || secret.length === 0) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  return hmacEqual(expected, signature);
}

const supportedActions = new Set([
  'opened',
  'reopened',
  'labeled',
  'edited',
  'synchronize',
  'created',
]);

export class GitHubWebhookAdapter implements IssueSourceAdapter {
  private readonly secret: string;
  private readonly policyFor: (repository: string) => RepositoryPolicy | undefined;
  private readonly queue: DurableQueue;
  private readonly seen = new Set<string>();

  constructor(options: {
    secret: string;
    policyFor: (repository: string) => RepositoryPolicy | undefined;
    queue: DurableQueue;
  }) {
    this.secret = options.secret;
    this.policyFor = options.policyFor;
    this.queue = options.queue;
  }

  async ingest(request: WebhookRequest | unknown): Promise<IntakeResult> {
    const r = request as Partial<WebhookRequest>;
    if (
      typeof r.body !== 'string' ||
      typeof r.signature !== 'string' ||
      typeof r.event !== 'string' ||
      typeof r.delivery !== 'string'
    ) {
      throw new SchemaError('webhook requires body, signature, event, and delivery');
    }
    if (!verifyGithubSignature(r.body, r.signature, this.secret))
      throw new HarnessError('invalid GitHub webhook signature', 'invalid_signature', 2);
    if (this.seen.has(r.delivery)) return { accepted: false, reason: 'duplicate delivery' };
    this.seen.add(r.delivery);
    if (r.event !== 'issues' && r.event !== 'issue_comment')
      return { accepted: false, reason: `ignored event ${r.event}` };
    const payload = JSON.parse(r.body) as Record<string, unknown>;
    const issue = (payload.issue ?? {}) as Record<string, unknown>;
    const repository = ((payload.repository as Record<string, unknown> | undefined)?.full_name ??
      '') as string;
    const action = typeof payload.action === 'string' ? payload.action : '';
    if (!supportedActions.has(action) || issue.pull_request)
      return { accepted: false, reason: 'event is not an actionable issue' };
    const policy = this.policyFor(repository);
    if (!policy) return { accepted: false, reason: `repository is not configured: ${repository}` };
    const input = parseGitHubIssueInput({
      action,
      deliveryId: r.delivery,
      repository,
      comments:
        r.event === 'issue_comment' && payload.comment
          ? [
              {
                body: String((payload.comment as Record<string, unknown>).body ?? ''),
                user: {
                  login: String(
                    (
                      (payload.comment as Record<string, unknown>).user as
                        Record<string, unknown> | undefined
                    )?.login ?? '',
                  ),
                },
                html_url:
                  typeof (payload.comment as Record<string, unknown>).html_url === 'string'
                    ? ((payload.comment as Record<string, unknown>).html_url as string)
                    : undefined,
              },
            ]
          : undefined,
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state,
        labels: Array.isArray(issue.labels)
          ? issue.labels.map((label) => ({
              name: String((label as Record<string, unknown>).name ?? ''),
            }))
          : [],
        user:
          issue.user === null
            ? null
            : { login: String((issue.user as Record<string, unknown> | undefined)?.login ?? '') },
        pull_request: issue.pull_request,
      },
      issueUrl: typeof issue.html_url === 'string' ? issue.html_url : undefined,
      baseCommit: String(
        (payload.repository as Record<string, unknown> | undefined)?.default_branch ?? 'unknown',
      ),
    });
    return this.enqueue(input, policy, 'webhook');
  }

  private async enqueue(
    input: GitHubIssueInput,
    policy: RepositoryPolicy,
    source: NormalizedIssueTask['source'],
  ): Promise<IntakeResult> {
    const task = normalizeIssue(input, policy, source);
    if (task.risk !== 'normal' || policy.requireHumanReviewFor.includes(task.risk))
      return { accepted: false, task, reason: `retained for human review: ${task.risk}` };
    const result = await this.queue.enqueue(task);
    return result.accepted
      ? { accepted: true, task }
      : { accepted: false, task, reason: 'duplicate delivery', duplicateOf: result.taskId };
  }
}

export class GitHubPollingAdapter implements IssueSourceAdapter {
  private readonly client: GitHubPollClient;
  private readonly queue: DurableQueue;
  private readonly policyFor: (repository: string) => RepositoryPolicy | undefined;
  private readonly checkpoint: {
    get: () => Promise<string | undefined>;
    set: (value: string) => Promise<void>;
  };

  constructor(options: {
    client: GitHubPollClient;
    queue: DurableQueue;
    policyFor: (repository: string) => RepositoryPolicy | undefined;
    checkpoint: { get: () => Promise<string | undefined>; set: (value: string) => Promise<void> };
  }) {
    this.client = options.client;
    this.queue = options.queue;
    this.policyFor = options.policyFor;
    this.checkpoint = options.checkpoint;
  }

  async reconcile(repository: string): Promise<IntakeResult[]> {
    const policy = this.policyFor(repository);
    if (!policy)
      return [{ accepted: false, reason: `repository is not configured: ${repository}` }];
    const cursor = await this.checkpoint.get();
    const issues = await this.client.listIssues(repository, cursor);
    const results: IntakeResult[] = [];
    let newest = cursor ?? '';
    for (const issue of [...issues].sort(
      (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number,
    )) {
      newest = issue.updatedAt > newest ? issue.updatedAt : newest;
      const input: GitHubIssueInput = {
        action: 'poll',
        deliveryId: `poll:${repository}:${issue.number}:${issue.updatedAt}`,
        repository,
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((name) => ({ name })),
          user: { login: issue.author },
        },
        comments: issue.comments.map((body) => ({ body, user: null })),
        issueUrl: issue.links?.[0],
        baseCommit: issue.baseCommit,
      };
      const task = normalizeIssue(input, policy, 'poll');
      if (task.risk !== 'normal' || !policy.allowedStates.includes(task.state)) {
        results.push({
          accepted: false,
          task,
          reason:
            task.risk !== 'normal'
              ? `retained for human review: ${task.risk}`
              : `state ${task.state} is not allowed`,
        });
        continue;
      }
      const added = await this.queue.enqueue(task);
      results.push(
        added.accepted
          ? { accepted: true, task }
          : { accepted: false, task, reason: 'duplicate poll result', duplicateOf: added.taskId },
      );
    }
    if (newest) await this.checkpoint.set(newest);
    return results;
  }

  async ingest(input: unknown): Promise<IntakeResult> {
    const repository = ensureString(
      (input as Record<string, unknown>).repository,
      'poll.repository',
      { nonEmpty: true },
    );
    const results = await this.reconcile(repository);
    return (
      results.find((result) => result.accepted) ??
      results[0] ?? { accepted: false, reason: 'no issues found' }
    );
  }
}

export function normalizeIssue(
  input: GitHubIssueInput,
  policy: RepositoryPolicy,
  source: NormalizedIssueTask['source'],
): NormalizedIssueTask {
  if (input.repository !== policy.repository)
    throw new HarnessError('repository is not allowed by policy', 'policy_rejected', 2);
  const body = [
    input.issue.body ?? '',
    ...(input.comments ?? []).map((comment) => comment.body ?? ''),
  ]
    .join('\n\n')
    .trim();
  const links = [
    input.issueUrl,
    ...(input.comments ?? []).map((comment) => comment.html_url),
  ].filter((value): value is string => Boolean(value));
  const labels = input.issue.labels.map((label) => label.name);
  const risk = classifyRisk(body, input.issue.title, policy.maxIssueChars, policy.maxPatchBytes);
  if (body.length > policy.maxIssueChars)
    return makeTask(
      input,
      policy,
      source,
      body.slice(0, policy.maxIssueChars),
      links,
      labels,
      'oversized',
    );
  if (!policy.allowedStates.includes(input.issue.state as 'open' | 'closed'))
    return makeTask(input, policy, source, body, links, labels, 'ambiguous');
  if (policy.optInLabels.length > 0 && !policy.optInLabels.some((label) => labels.includes(label)))
    return makeTask(input, policy, source, body, links, labels, 'ambiguous');
  return makeTask(input, policy, source, body, links, labels, risk);
}

function makeTask(
  input: GitHubIssueInput,
  policy: RepositoryPolicy,
  source: NormalizedIssueTask['source'],
  body: string,
  links: string[],
  labels: string[],
  risk: NormalizedIssueTask['risk'],
): NormalizedIssueTask {
  const deliveryKey = `${input.repository}#${input.issue.number}:${input.action}:${input.deliveryId}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: sha256(deliveryKey).slice(0, 24),
    deliveryKey: redactSecrets(deliveryKey),
    repository: redactSecrets(input.repository),
    number: input.issue.number,
    title: redactSecrets(input.issue.title),
    body: redactSecrets(body),
    comments:
      input.comments?.map((comment) => redactSecrets(comment.body ?? '')).filter(Boolean) ?? [],
    links: links.map(redactSecrets),
    state: input.issue.state === 'closed' ? 'closed' : 'open',
    labels,
    author: redactSecrets(input.issue.user?.login ?? 'unknown'),
    baseCommit: redactSecrets(input.baseCommit),
    policy,
    risk,
    receivedAt: nowIso(),
    source,
  };
}

export function classifyRisk(
  body: string,
  title: string,
  maxIssueChars: number,
  _maxPatchBytes: number,
): NormalizedIssueTask['risk'] {
  if (body.length > maxIssueChars) return 'oversized';
  const lower = `${title}\n${body}`.toLowerCase();
  if (
    /\b(delete|drop database|rotate prod|force push|credential|secret|token|password|exfiltrat|rm -rf)\b/.test(
      lower,
    )
  )
    return 'security_sensitive';
  if (/\b(maybe|possibly|not sure|investigate|unclear|\?\?\?|any ideas)\b/.test(lower))
    return 'ambiguous';
  return 'normal';
}

import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './schema.js';
import type {
  AgentState,
  Budget,
  NormalizedIssueTask,
  ProviderModelProfile,
  RunEvent,
  RunManifest,
  TerminalOutcome,
} from './schema.js';
import { taskPrompt } from './model.js';
import { ModelTransportError } from './model.js';
import type { ModelResponse, ModelToolCall, ModelTransport } from './model.js';
import { summarizeUsage, unavailableUsage } from './usage.js';
import type { ModelUsage, UsageSummary } from './usage.js';
import type { Workspace } from './workspace.js';
import type { RunLogger } from './storage.js';
import { HarnessError, nowIso, redactSecrets, withTimeout } from './util.js';

const order: AgentState[] = [
  'inspect',
  'reproduce',
  'plan',
  'edit',
  'test',
  'self_review',
  'terminal',
];

export interface AgentRunOptions {
  task: NormalizedIssueTask;
  workspace: Workspace;
  transport: ModelTransport;
  profile: ProviderModelProfile;
  budget: Budget;
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => Promise<void> | void;
  /** Optional durable sink for the same event stream returned in the result. */
  log?: RunLogger;
  /** Cost totals are withheld unless pricing evidence has been configured. */
  costsTrusted?: boolean;
}

export interface AgentRunResult {
  manifest: RunManifest;
  events: RunEvent[];
  patch: string;
  terminal: {
    outcome: TerminalOutcome;
    reason: string;
    failureCategory?: string;
    residualRisks: string[];
  };
  usage: UsageSummary;
  logPath?: string;
}

export class AgentRunner {
  private readonly events: RunEvent[] = [];
  private readonly history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [];
  private sequence = 0;
  private modelCalls = 0;
  private steps = 0;
  private readonly retries = new Map<AgentState, number>();
  private lastFailure = '';
  private readonly usageSamples: Array<ModelUsage | undefined> = [];
  private usage: UsageSummary = unavailableUsage();
  private runId = '';

  constructor(private readonly options: AgentRunOptions) {}

  async run(): Promise<AgentRunResult> {
    const { task, profile, budget } = this.options;
    this.runId = this.options.runId ?? randomUUID();
    let current: AgentState = 'inspect';
    let terminal: AgentRunResult['terminal'] = {
      outcome: 'failed',
      reason: 'worker did not reach terminal',
      residualRisks: [],
    };
    const manifest: RunManifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      taskId: task.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'running',
      agentState: current,
      repository: task.repository,
      baseCommit: task.baseCommit,
      provider: profile,
      harnessVersion: '0.1.0',
      budget,
      usage: this.usage,
      artifactIds: [],
    };
    await this.options.log?.start(manifest);
    await this.event('run_started', 'inspect', {
      taskId: task.id,
      repository: task.repository,
      provider: profile.provider,
      model: profile.model,
      runtime: profile.runtime,
    });
    if (task.risk !== 'normal' || task.policy.requireHumanReviewFor.includes(task.risk)) {
      terminal = {
        outcome: 'human_review',
        reason: `intake risk requires human review: ${task.risk}`,
        residualRisks: [task.risk],
      };
      await this.enter('terminal', { reason: terminal.reason });
      return this.finish(manifest, terminal);
    }
    while (current !== 'terminal') {
      if (this.options.signal?.aborted) {
        terminal = { outcome: 'cancelled', reason: 'run cancelled', residualRisks: [] };
        current = 'terminal';
        break;
      }
      if (this.steps >= budget.maxSteps) {
        terminal = {
          outcome: 'budget_exhausted',
          reason: `step budget exhausted at ${budget.maxSteps}`,
          residualRisks: [],
        };
        current = 'terminal';
        break;
      }
      await this.enter(current);
      this.steps += 1;
      try {
        const result = await this.executeState(current);
        if (result.failure) {
          const retry = (this.retries.get(current) ?? 0) + 1;
          this.retries.set(current, retry);
          this.lastFailure = result.failure;
          await this.event('error', current, {
            failure: redactSecrets(result.failure),
            retry,
          });
          await this.event('warning', current, { failure: redactSecrets(result.failure), retry });
          if (
            retry > budget.maxRetriesPerState ||
            (result.failure === this.lastFailure && retry > 1)
          ) {
            terminal = {
              outcome: result.failure.includes('timed') ? 'timed_out' : 'failed',
              reason: result.failure,
              failureCategory: categoryFor(result.failure),
              residualRisks: [result.failure],
            };
            current = 'terminal';
          }
        } else if (result.next) {
          await this.exit(current, result.next);
          if (result.next === 'terminal' && terminal.outcome === 'failed') {
            terminal = {
              outcome: 'resolved',
              reason: 'worker completed the bounded state machine',
              residualRisks: [],
            };
          }
          current = result.next;
        } else {
          await this.exit(current, 'terminal');
          terminal = {
            outcome: 'resolved',
            reason: 'worker completed the bounded state machine',
            residualRisks: [],
          };
          current = 'terminal';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retry = (this.retries.get(current) ?? 0) + 1;
        this.retries.set(current, retry);
        await this.event('error', current, {
          failure: redactSecrets(message),
          retry,
        });
        await this.event('warning', current, { failure: redactSecrets(message), retry });
        if (retry > budget.maxRetriesPerState) {
          terminal = {
            outcome: categoryFor(message) === 'timeout' ? 'timed_out' : 'failed',
            reason: message,
            failureCategory: categoryFor(message),
            residualRisks: [message],
          };
          current = 'terminal';
        }
      }
    }
    if (current === 'terminal') {
      await this.enter('terminal', { outcome: terminal.outcome, reason: terminal.reason });
      if (terminal.outcome === 'failed' && this.lastFailure)
        terminal.residualRisks = [this.lastFailure];
    }
    return this.finish(manifest, terminal);
  }

  private async executeState(state: AgentState): Promise<{ next?: AgentState; failure?: string }> {
    const { task, budget } = this.options;
    if (state === 'terminal') return {};
    const prompt = taskPrompt(task);
    const response = await this.ask({
      ...prompt,
      prompt: `${prompt.prompt}\n\nCurrent state: ${state}.`,
      state,
    });
    if (response.text)
      this.history.push({
        role: 'assistant',
        content: redactSecrets(response.text).slice(0, budget.maxOutputChars),
      });
    for (const tool of response.toolCalls) {
      await this.event('tool_call', state, { tool: tool.name, id: tool.id });
      const result = await this.invokeTool(tool, state);
      this.history.push({ role: 'tool', content: result });
      await this.event('tool_result', state, { tool: tool.name, ok: !result.startsWith('ERROR:') });
      if (result.startsWith('ERROR:')) return { failure: result.slice(6) };
    }
    if (state === 'inspect') return { next: 'reproduce' };
    if (state === 'reproduce') return { next: 'plan' };
    if (state === 'plan') return { next: 'edit' };
    if (state === 'edit') return { next: 'test' };
    if (state === 'test') return { next: 'self_review' };
    if (state === 'self_review') return { next: 'terminal' };
    const next = order[order.indexOf(state) + 1];
    return next ? { next } : { next: 'terminal' };
  }

  private async ask(request: {
    system: string;
    prompt: string;
    state: AgentState;
  }): Promise<ModelResponse> {
    if (this.modelCalls >= this.options.budget.maxModelCalls)
      throw new HarnessError('model call budget exhausted', 'budget_exhausted');
    this.modelCalls += 1;
    let response: ModelResponse;
    try {
      response = await withTimeout(
        this.options.transport.complete({
          profile: this.options.profile,
          system: request.system,
          prompt: request.prompt.slice(0, this.options.budget.maxInputChars),
          history: this.history,
          budget: this.options.budget,
          signal: this.options.signal,
        }),
        this.options.budget.timeoutMs,
        'model call',
        this.options.signal,
      );
    } catch (error) {
      await this.recordUsage(
        request.state,
        error instanceof ModelTransportError ? error.usage : undefined,
      );
      throw error;
    }
    await this.recordUsage(request.state, response.usage);
    return response;
  }

  private async recordUsage(state: AgentState, usage: ModelUsage | undefined): Promise<void> {
    this.usageSamples.push(usage);
    this.usage = summarizeUsage(this.usageSamples, this.options.costsTrusted ?? false);
    await this.event('model_usage', state, {
      call: this.modelCalls,
      reported: usage !== undefined,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
    });
  }

  private async invokeTool(tool: ModelToolCall, state: AgentState): Promise<string> {
    try {
      if (tool.name === 'list_files')
        return JSON.stringify(
          await this.options.workspace.list(stringArg(tool.arguments, 'path', '.')),
        );
      if (tool.name === 'inspect_file')
        return JSON.stringify(
          await this.options.workspace.inspect(stringArg(tool.arguments, 'path')),
        );
      if (tool.name === 'exact_edit') {
        const result = await this.options.workspace.exactEdit(
          stringArg(tool.arguments, 'path'),
          stringArg(tool.arguments, 'expectedSha256'),
          stringArg(tool.arguments, 'replacement'),
        );
        return JSON.stringify(result);
      }
      if (tool.name === 'run_command') {
        const command = tool.arguments.command;
        if (
          !Array.isArray(command) ||
          command.some((part) => typeof part !== 'string') ||
          command.length < 1
        )
          throw new HarnessError(
            'run_command.command must be a non-empty string array',
            'invalid_tool',
          );
        const result = await this.options.workspace.run({
          name: stringArg(tool.arguments, 'name'),
          executable: command[0] as string,
          args: command.slice(1) as string[],
          timeoutMs: this.options.task.policy.maxCommandMs,
          maxOutputChars: this.options.budget.maxOutputChars,
        });
        await this.event('check', state, {
          command: result.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
        return JSON.stringify(result);
      }
      if (tool.name === 'finish')
        return JSON.stringify({
          finished: true,
          reason: tool.arguments.reason ?? 'model finished',
        });
      throw new HarnessError(`unknown tool ${tool.name}`, 'invalid_tool');
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      await this.event('error', state, { failure: message, tool: tool.name });
      return `ERROR:${message}`;
    }
  }

  private async enter(
    state: AgentState,
    data: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    await this.event('state_entered', state, data);
  }

  private async exit(state: AgentState, next: AgentState): Promise<void> {
    await this.event('state_exited', state, { next });
  }

  private async event(
    type: RunEvent['type'],
    state: AgentState,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const event: RunEvent = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      sequence: this.sequence++,
      at: nowIso(),
      type,
      state,
      data,
    };
    this.events.push(event);
    await this.options.log?.append(event);
    await this.options.onEvent?.(event);
  }

  private async finish(
    manifest: RunManifest,
    terminal: AgentRunResult['terminal'],
  ): Promise<AgentRunResult> {
    terminal = {
      ...terminal,
      reason: redactSecrets(terminal.reason),
      residualRisks: terminal.residualRisks.map((risk) => redactSecrets(risk)),
    };
    const patch = await this.options.workspace.diff().catch(async (error) => {
      await this.event('error', 'terminal', {
        failure: redactSecrets(error instanceof Error ? error.message : String(error)),
        operation: 'collect_diff',
      });
      return '';
    });
    this.usage = summarizeUsage(this.usageSamples, this.options.costsTrusted ?? false);
    manifest.updatedAt = nowIso();
    manifest.agentState = 'terminal';
    manifest.usage = this.usage;
    manifest.status =
      terminal.outcome === 'resolved'
        ? 'succeeded'
        : terminal.outcome === 'human_review'
          ? 'review'
          : terminal.outcome === 'cancelled'
            ? 'cancelled'
            : 'failed';
    manifest.terminal = terminal.outcome;
    manifest.failureCategory = terminal.failureCategory;
    await this.event('terminal', 'terminal', {
      outcome: terminal.outcome,
      reason: redactSecrets(terminal.reason),
    });
    await this.options.log?.updateManifest(manifest);
    return {
      manifest,
      events: this.events,
      patch,
      terminal,
      usage: this.usage,
      logPath: this.options.log?.path,
    };
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== 'string' || value.length === 0)
    throw new HarnessError(`tool argument ${key} must be a non-empty string`, 'invalid_tool');
  return value;
}

function categoryFor(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('budget')) return 'budget';
  if (lower.includes('forbidden') || lower.includes('allowlist') || lower.includes('policy'))
    return 'policy';
  if (lower.includes('test') || lower.includes('check')) return 'check_failure';
  if (lower.includes('edit')) return 'edit_conflict';
  return 'worker_error';
}

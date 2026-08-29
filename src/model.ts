import type { Budget, ProviderModelProfile, NormalizedIssueTask } from './schema.js';
import type * as PiAi from '@earendil-works/pi-ai';
import type { CredentialStore } from '@earendil-works/pi-ai';
import {
  HarnessError,
  redactSecrets,
  withTimeout,
  ensureArray,
  ensureRecord,
  ensureString,
  rejectUnknown,
  SchemaError,
} from './util.js';
import { parseModelUsage } from './usage.js';
import type { ModelUsage } from './usage.js';

export interface ModelToolCall {
  id: string;
  name: 'list_files' | 'inspect_file' | 'exact_edit' | 'run_command' | 'finish';
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  usage?: ModelUsage;
}

/** A provider may return useful usage even when the response itself fails. */
export class ModelTransportError extends HarnessError {
  constructor(message: string, code = 'model_error', usage?: ModelUsage) {
    super(message, code);
    this.usage = usage;
  }

  readonly usage?: ModelUsage;
}

export function parseReplayResponses(input: unknown): ModelResponse[] {
  if (!Array.isArray(input)) throw new SchemaError('replay must be an array');
  return input.map((value, index) => {
    const record = ensureRecord(value, `replay[${index}]`);
    rejectUnknown(record, ['text', 'toolCalls', 'usage'], `replay[${index}]`);
    const calls = ensureArray(record.toolCalls, `replay[${index}].toolCalls`).map(
      (callValue, callIndex) => {
        const call = ensureRecord(callValue, `replay[${index}].toolCalls[${callIndex}]`);
        rejectUnknown(
          call,
          ['id', 'name', 'arguments'],
          `replay[${index}].toolCalls[${callIndex}]`,
        );
        const name = ensureString(call.name, `replay[${index}].toolCalls[${callIndex}].name`, {
          nonEmpty: true,
        });
        if (!isToolName(name)) throw new SchemaError(`replay tool is not allowlisted: ${name}`);
        const args = call.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args))
          throw new SchemaError(
            `replay[${index}].toolCalls[${callIndex}].arguments must be an object`,
          );
        return {
          id: ensureString(call.id, `replay[${index}].toolCalls[${callIndex}].id`, {
            nonEmpty: true,
          }),
          name,
          arguments: args as Record<string, unknown>,
        };
      },
    );
    const response: ModelResponse = {
      text: ensureString(record.text ?? '', `replay[${index}].text`),
      toolCalls: calls,
    };
    if ('usage' in record && record.usage !== undefined)
      response.usage = parseModelUsage(record.usage, `replay[${index}].usage`);
    return response;
  });
}

export interface ModelRequest {
  profile: ProviderModelProfile;
  system: string;
  prompt: string;
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  budget: Budget;
  signal?: AbortSignal;
}

/** Harness-owned transport boundary. Provider SDK types must not cross this interface. */
export interface ModelTransport {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ReplayTransport implements ModelTransport {
  private cursor = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.responses[this.cursor++];
    if (!response)
      throw new HarnessError('replay transport has no response left', 'replay_exhausted');
    return structuredClone(response);
  }

  get calls(): number {
    return this.cursor;
  }
}

export class FakeTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly responder: (
      request: ModelRequest,
      call: number,
    ) => ModelResponse | Promise<ModelResponse>,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    return this.responder(request, this.requests.length);
  }
}

/**
 * Optional pi-ai implementation. The current installed package is
 * @earendil-works/pi-ai 0.84.2: Models.completeSimple resolves provider auth,
 * and openaiProvider/openaiCodexProvider supply the authoritative API boundary.
 * Only normalized text/tool calls/usage leave this adapter.
 */
interface PiBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
interface PiAssistant {
  content: PiBlock[];
  stopReason: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    totalTokens: number;
    cost?: { total: number };
  };
}
interface PiModelCollection {
  getModel(provider: string, model: string): unknown;
  setProvider(provider: unknown): void;
  completeSimple(model: unknown, context: unknown): Promise<PiAssistant>;
}

export class PiModelTransport implements ModelTransport {
  private modelsPromise: Promise<PiModelCollection> | undefined;
  private piModule: typeof PiAi | undefined;

  constructor(private readonly credentialStore?: CredentialStore) {}

  private async models(): Promise<PiModelCollection> {
    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        const pi = await import('@earendil-works/pi-ai');
        this.piModule = pi;
        const models = this.credentialStore
          ? pi.createModels({ credentials: this.credentialStore })
          : pi.createModels();
        const openai = await import('@earendil-works/pi-ai/providers/openai');
        const codex = await import('@earendil-works/pi-ai/providers/openai-codex');
        models.setProvider(openai.openaiProvider());
        models.setProvider(codex.openaiCodexProvider());
        return models as unknown as PiModelCollection;
      })();
    }
    return this.modelsPromise;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const models = await this.models();
    const pi = this.piModule;
    if (!pi) throw new HarnessError('pi-ai runtime did not initialize', 'runtime_error');
    const model = models.getModel(request.profile.provider, request.profile.model);
    if (!model)
      throw new HarnessError(
        `model is not available: ${request.profile.provider}/${request.profile.model}`,
        'model_not_found',
      );
    const context = {
      systemPrompt: request.system,
      messages: request.history.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
        timestamp: Date.now(),
      })),
      tools: [
        {
          name: 'list_files',
          description: 'List workspace files',
          parameters: pi.Type.Object(
            { path: pi.Type.Optional(pi.Type.String()) },
            { additionalProperties: false },
          ),
        },
        {
          name: 'inspect_file',
          description: 'Read one workspace file',
          parameters: pi.Type.Object({ path: pi.Type.String() }, { additionalProperties: false }),
        },
        {
          name: 'exact_edit',
          description: 'Replace a file after an exact hash precondition',
          parameters: pi.Type.Object(
            {
              path: pi.Type.String(),
              expectedSha256: pi.Type.String(),
              replacement: pi.Type.String(),
            },
            { additionalProperties: false },
          ),
        },
        {
          name: 'run_command',
          description: 'Run a named allowlisted command',
          parameters: pi.Type.Object(
            { name: pi.Type.String(), command: pi.Type.Array(pi.Type.String()) },
            { additionalProperties: false },
          ),
        },
        {
          name: 'finish',
          description: 'Finish after checks',
          parameters: pi.Type.Object(
            { reason: pi.Type.Optional(pi.Type.String()) },
            { additionalProperties: false },
          ),
        },
      ],
    };
    const response = await withTimeout(
      models.completeSimple(model, context),
      request.budget.timeoutMs,
      'model request',
      request.signal,
    );
    const toolCalls: ModelToolCall[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (
        block.type === 'toolCall' &&
        typeof block.name === 'string' &&
        typeof block.id === 'string' &&
        isToolName(block.name) &&
        isRecord(block.arguments)
      )
        toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
    const usage = response.usage
      ? parseModelUsage(
          {
            inputTokens: response.usage.input,
            outputTokens: response.usage.output,
            cachedInputTokens: response.usage.cacheRead,
            cacheWriteTokens: response.usage.cacheWrite,
            reasoningTokens: response.usage.reasoning,
            totalTokens: response.usage.totalTokens,
            costUsd: response.usage.cost?.total,
          },
          'provider.usage',
        )
      : undefined;
    if (response.stopReason === 'error' || response.stopReason === 'aborted')
      throw new ModelTransportError(
        redactSecrets(response.errorMessage ?? 'model request failed'),
        'model_error',
        usage,
      );
    return { text: redactSecrets(text), toolCalls, usage };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToolName(value: string): value is ModelToolCall['name'] {
  return ['list_files', 'inspect_file', 'exact_edit', 'run_command', 'finish'].includes(value);
}

export function taskPrompt(task: NormalizedIssueTask): { system: string; prompt: string } {
  return {
    system:
      'You are a bounded repository worker. Use only the supplied harness tools. Never access credentials, host configuration, network, or paths outside the workspace. Make the smallest exact edit that resolves the issue. Return finish only after tests run.',
    prompt: [
      `Repository: ${redactSecrets(task.repository)}`,
      `Issue #${task.number}: ${redactSecrets(task.title)}`,
      redactSecrets(task.body),
      `Base commit: ${redactSecrets(task.baseCommit)}`,
    ].join('\n\n'),
  };
}

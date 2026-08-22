import { homedir } from 'node:os';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { atomicWrite, assertPrivateFile, HarnessError, redactSecrets } from './util.js';

interface AuthFile {
  schemaVersion: 'v1';
  credentials: Record<string, Credential>;
}

export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  private state: AuthFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path = defaultCredentialPath()) {
    this.path = path;
  }

  get filePath(): string {
    return this.path;
  }

  private async load(): Promise<AuthFile> {
    if (this.state) return this.state;
    await assertPrivateFile(this.path);
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as AuthFile;
      if (
        parsed.schemaVersion !== 'v1' ||
        !parsed.credentials ||
        typeof parsed.credentials !== 'object'
      )
        throw new HarnessError('credential store is corrupt', 'corrupt_credentials');
      this.state = parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        this.state = { schemaVersion: 'v1', credentials: {} };
      else throw error;
    }
    return this.state;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.load()).credentials[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const state = await this.load();
    return Object.entries(state.credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const operation = this.writeChain.then(async () => {
      const state = await this.load();
      const next = await fn(state.credentials[providerId]);
      if (next) state.credentials[providerId] = next;
      await this.persist(state);
      return next;
    });
    this.writeChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async delete(providerId: string): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const state = await this.load();
      delete state.credentials[providerId];
      await this.persist(state);
    });
    this.writeChain = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async persist(state: AuthFile): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWrite(this.path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    await chmod(this.path, 0o600);
  }
}

export function defaultCredentialPath(): string {
  return join(homedir(), '.config', 'issue-harness', 'auth.json');
}

export interface BrowserOAuthFlow {
  open(url: string): Promise<void>;
  promptManualCode(message: string): Promise<string>;
  notify(message: string): void;
}

export async function loginCodex(
  store: FileCredentialStore,
  flow: BrowserOAuthFlow,
): Promise<void> {
  // The provider owns OAuth URL/token exchange; this interaction only bridges
  // its browser flow and never serializes token values to logs or workspaces.
  const pi = await import('@earendil-works/pi-ai');
  const models = pi.createModels({ credentials: store });
  const provider = (
    await import('@earendil-works/pi-ai/providers/openai-codex')
  ).openaiCodexProvider();
  models.setProvider(provider);
  await models.login('openai-codex', 'oauth', {
    prompt: async (prompt) => {
      if (prompt.type === 'manual_code') return flow.promptManualCode(prompt.message);
      if (prompt.type === 'select' && prompt.options.length === 1 && prompt.options[0])
        return prompt.options[0].id;
      throw new HarnessError(
        'Codex OAuth requested an unsupported prompt; use the explicit browser login flow',
        'oauth_prompt',
        2,
      );
    },
    notify: (event) => {
      if (event.type === 'auth_url') void flow.open(event.url);
      else if (event.type === 'info' || event.type === 'progress')
        flow.notify(redactSecrets(event.message));
    },
  });
}

export async function authStatus(
  store: FileCredentialStore,
): Promise<{ providers: Array<{ provider: string; type: string }> }> {
  return {
    providers: (await store.list()).map((item) => ({ provider: item.providerId, type: item.type })),
  };
}

export async function logout(
  store: FileCredentialStore,
  provider: 'openai' | 'openai-codex',
): Promise<void> {
  await store.delete(provider);
}

export function credentialStorePathFromEnv(): FileCredentialStore {
  return new FileCredentialStore(process.env.ISSUE_HARNESS_AUTH_FILE || defaultCredentialPath());
}

export type SafeOAuthCredential = Pick<OAuthCredential, 'type' | 'expires'>;

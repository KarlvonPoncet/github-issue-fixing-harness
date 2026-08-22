import { join } from 'node:path';
import { parseNormalizedTask } from './schema.js';
import type { NormalizedIssueTask, QueueState } from './schema.js';
import { atomicWrite, nowIso, readJson, HarnessError, redactSecrets } from './util.js';
import { LocalIndex } from './storage.js';

export interface QueueEntry {
  taskId: string;
  deliveryKey: string;
  state: QueueState;
  attempts: number;
  leaseUntil?: string;
  updatedAt: string;
  terminalReason?: string;
}

interface QueueFile {
  schemaVersion: 'v1';
  entries: Record<string, QueueEntry>;
  deliveryKeys: Record<string, string>;
}

const validTransitions: Record<QueueState, QueueState[]> = {
  queued: ['claimed', 'cancelled', 'review'],
  claimed: ['running', 'queued', 'cancelled', 'review'],
  running: ['succeeded', 'failed', 'queued', 'review', 'cancelled'],
  succeeded: [],
  failed: ['queued', 'review'],
  review: ['queued', 'cancelled'],
  cancelled: [],
};

export class DurableQueue {
  private readonly path: string;
  private readonly index: LocalIndex;
  private data: QueueFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(root = '.harness', index = new LocalIndex(join(root, 'store'))) {
    this.path = join(root, 'queue.json');
    this.index = index;
  }

  async init(): Promise<void> {
    this.data = (await readJson<QueueFile>(this.path)) ?? {
      schemaVersion: 'v1',
      entries: {},
      deliveryKeys: {},
    };
    if (this.data.schemaVersion !== 'v1')
      throw new HarnessError('queue schema version is unsupported', 'corrupt_queue');
    await this.index.load();
  }

  private async ready(): Promise<QueueFile> {
    if (!this.data) await this.init();
    if (!this.data) throw new Error('queue failed to initialize');
    return this.data;
  }

  private async persist(data: QueueFile): Promise<void> {
    this.data = data;
    this.writeChain = this.writeChain.then(() =>
      atomicWrite(this.path, `${JSON.stringify(data, null, 2)}\n`),
    );
    await this.writeChain;
  }

  async enqueue(task: NormalizedIssueTask): Promise<{ accepted: boolean; taskId: string }> {
    const safeTask = parseNormalizedTask(
      JSON.parse(redactSecrets(JSON.stringify(task))) as unknown,
    );
    const data = await this.ready();
    const existing = data.deliveryKeys[safeTask.deliveryKey];
    if (existing) return { accepted: false, taskId: existing };
    const accepted = await this.index.addTask(safeTask);
    if (!accepted.accepted && accepted.existingId)
      return { accepted: false, taskId: accepted.existingId };
    const next = structuredClone(data);
    next.entries[safeTask.id] = {
      taskId: safeTask.id,
      deliveryKey: safeTask.deliveryKey,
      state: 'queued',
      attempts: 0,
      updatedAt: nowIso(),
    };
    next.deliveryKeys[safeTask.deliveryKey] = safeTask.id;
    await this.persist(next);
    return { accepted: true, taskId: safeTask.id };
  }

  async get(taskId: string): Promise<{ task: NormalizedIssueTask; entry: QueueEntry } | undefined> {
    const data = await this.ready();
    const entry = data.entries[taskId];
    if (!entry) return undefined;
    const task = await this.index.getTask(taskId);
    return task ? { task, entry } : undefined;
  }

  async list(): Promise<Array<{ task: NormalizedIssueTask; entry: QueueEntry }>> {
    const data = await this.ready();
    const result: Array<{ task: NormalizedIssueTask; entry: QueueEntry }> = [];
    for (const entry of Object.values(data.entries)) {
      const task = await this.index.getTask(entry.taskId);
      if (task) result.push({ task, entry });
    }
    return result.sort((a, b) => a.entry.updatedAt.localeCompare(b.entry.updatedAt));
  }

  async transition(taskId: string, nextState: QueueState, reason?: string): Promise<QueueEntry> {
    const data = await this.ready();
    const current = data.entries[taskId];
    if (!current) throw new HarnessError(`task is not queued: ${taskId}`, 'not_found', 2);
    if (!validTransitions[current.state].includes(nextState) && current.state !== nextState) {
      throw new HarnessError(
        `invalid queue transition ${current.state} -> ${nextState}`,
        'invalid_transition',
        2,
      );
    }
    const next = structuredClone(data);
    const entry = next.entries[taskId];
    if (!entry) throw new Error('queue entry disappeared');
    entry.state = nextState;
    entry.updatedAt = nowIso();
    if (reason) entry.terminalReason = reason;
    if (nextState === 'claimed') {
      entry.attempts += 1;
      entry.leaseUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    } else if (nextState !== 'running') {
      delete entry.leaseUntil;
    }
    await this.persist(next);
    return entry;
  }

  async claimNext(
    leaseMs = 15 * 60_000,
  ): Promise<{ task: NormalizedIssueTask; entry: QueueEntry } | undefined> {
    const data = await this.ready();
    const now = Date.now();
    const candidate = Object.values(data.entries)
      .filter(
        (entry) =>
          entry.state === 'queued' ||
          (entry.state === 'claimed' && (!entry.leaseUntil || Date.parse(entry.leaseUntil) <= now)),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!candidate) return undefined;
    const next = structuredClone(data);
    const entry = next.entries[candidate.taskId];
    if (!entry) return undefined;
    entry.state = 'claimed';
    entry.attempts += 1;
    entry.leaseUntil = new Date(now + leaseMs).toISOString();
    entry.updatedAt = nowIso();
    await this.persist(next);
    const task = await this.index.getTask(entry.taskId);
    if (!task) throw new HarnessError(`queue task index missing: ${entry.taskId}`, 'corrupt_queue');
    return { task, entry };
  }

  async recoverExpired(): Promise<string[]> {
    const data = await this.ready();
    const recovered: string[] = [];
    const next = structuredClone(data);
    for (const entry of Object.values(next.entries)) {
      if (
        (entry.state === 'claimed' || entry.state === 'running') &&
        entry.leaseUntil &&
        Date.parse(entry.leaseUntil) <= Date.now()
      ) {
        entry.state = 'queued';
        entry.updatedAt = nowIso();
        delete entry.leaseUntil;
        recovered.push(entry.taskId);
      }
    }
    if (recovered.length) await this.persist(next);
    return recovered;
  }

  async cancel(taskId: string, reason = 'cancelled by operator'): Promise<QueueEntry> {
    return this.transition(taskId, 'cancelled', reason);
  }

  async markRunning(taskId: string): Promise<QueueEntry> {
    return this.transition(taskId, 'running');
  }
}

export { validTransitions };

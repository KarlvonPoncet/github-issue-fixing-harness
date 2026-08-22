import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SCHEMA_VERSION,
  parseArtifactRecord,
  parseNormalizedTask,
  parseRunManifest,
} from './schema.js';
import type { ArtifactRecord, NormalizedIssueTask, QueueState, RunManifest } from './schema.js';
import { atomicWrite, nowIso, readJson, redactSecrets, sha256 } from './util.js';

interface IndexFile {
  schemaVersion: typeof SCHEMA_VERSION;
  tasks: Record<string, NormalizedIssueTask>;
  deliveryKeys: Record<string, string>;
  runs: Record<string, RunManifest>;
  checkpoints: Record<string, string>;
}

const emptyIndex = (): IndexFile => ({
  schemaVersion: SCHEMA_VERSION,
  tasks: {},
  deliveryKeys: {},
  runs: {},
  checkpoints: {},
});

export class LocalIndex {
  private readonly path: string;
  private data: IndexFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.path = join(root, 'index.json');
  }

  async load(): Promise<void> {
    const raw = await readJson<IndexFile>(this.path);
    if (!raw) {
      this.data = emptyIndex();
      return;
    }
    if (
      raw.schemaVersion !== SCHEMA_VERSION ||
      !raw.tasks ||
      typeof raw.tasks !== 'object' ||
      !raw.runs ||
      typeof raw.runs !== 'object' ||
      !raw.deliveryKeys ||
      typeof raw.deliveryKeys !== 'object' ||
      !raw.checkpoints ||
      typeof raw.checkpoints !== 'object'
    ) {
      throw new Error(`unsupported or corrupt index: ${this.path}`);
    }
    const tasks: Record<string, NormalizedIssueTask> = {};
    for (const [id, task] of Object.entries(raw.tasks)) tasks[id] = parseNormalizedTask(task);
    const runs: Record<string, RunManifest> = {};
    for (const [id, run] of Object.entries(raw.runs)) runs[id] = parseRunManifest(run);
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      tasks,
      deliveryKeys: { ...raw.deliveryKeys },
      runs,
      checkpoints: { ...raw.checkpoints },
    };
  }

  private async ready(): Promise<IndexFile> {
    if (!this.data) await this.load();
    return this.data ?? emptyIndex();
  }

  private async persist(data: IndexFile): Promise<void> {
    this.data = data;
    this.writeChain = this.writeChain.then(() =>
      atomicWrite(this.path, `${JSON.stringify(data, null, 2)}\n`),
    );
    await this.writeChain;
  }

  async addTask(task: NormalizedIssueTask): Promise<{ accepted: boolean; existingId?: string }> {
    const data = await this.ready();
    const existingId = data.deliveryKeys[task.deliveryKey];
    if (existingId) return { accepted: false, existingId };
    const next: IndexFile = structuredClone(data);
    next.tasks[task.id] = task;
    next.deliveryKeys[task.deliveryKey] = task.id;
    await this.persist(next);
    return { accepted: true };
  }

  async getTask(id: string): Promise<NormalizedIssueTask | undefined> {
    return (await this.ready()).tasks[id];
  }

  async listTasks(): Promise<NormalizedIssueTask[]> {
    return Object.values((await this.ready()).tasks).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
  }

  async upsertRun(run: RunManifest): Promise<void> {
    const data = await this.ready();
    const next = structuredClone(data);
    next.runs[run.runId] = parseRunManifest(run);
    await this.persist(next);
  }

  async getRun(runId: string): Promise<RunManifest | undefined> {
    return (await this.ready()).runs[runId];
  }

  async listRuns(): Promise<RunManifest[]> {
    return Object.values((await this.ready()).runs).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async setCheckpoint(name: string, value: string): Promise<void> {
    const data = await this.ready();
    const next = structuredClone(data);
    next.checkpoints[name] = value;
    await this.persist(next);
  }

  async getCheckpoint(name: string): Promise<string | undefined> {
    return (await this.ready()).checkpoints[name];
  }

  async recoverInterrupted(now = Date.now(), staleMs = 15 * 60_000): Promise<RunManifest[]> {
    const data = await this.ready();
    const recovered: RunManifest[] = [];
    const next = structuredClone(data);
    for (const run of Object.values(next.runs)) {
      if (
        (run.status === 'claimed' || run.status === 'running') &&
        now - Date.parse(run.updatedAt) > staleMs
      ) {
        run.status = 'queued';
        run.updatedAt = new Date(now).toISOString();
        recovered.push(run);
      }
    }
    if (recovered.length > 0) await this.persist(next);
    return recovered;
  }

  async updateTaskState(taskId: string, _state: QueueState): Promise<void> {
    // The queue state is represented by run manifests. This method exists as a
    // narrow extension seam for a future SQLite index without duplicating task data.
    if (!(await this.getTask(taskId))) throw new Error(`task not found: ${taskId}`);
  }
}

export class ArtifactStore {
  readonly root: string;
  readonly index: LocalIndex;

  constructor(root = '.harness') {
    this.root = root;
    this.index = new LocalIndex(join(root, 'store'));
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, 'artifacts'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'runs'), { recursive: true, mode: 0o700 });
    await this.index.load();
  }

  async put(
    kind: ArtifactRecord['kind'],
    content: string | Uint8Array,
    id: string = randomUUID(),
  ): Promise<ArtifactRecord> {
    const stored = typeof content === 'string' ? redactSecrets(content) : content;
    const bytes = typeof stored === 'string' ? Buffer.byteLength(stored) : stored.byteLength;
    const digest = sha256(stored);
    const relativePath = join('artifacts', digest.slice(0, 2), digest);
    const absolutePath = join(this.root, relativePath);
    try {
      await readFile(absolutePath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await atomicWrite(absolutePath, stored);
    }
    const record = parseArtifactRecord({
      schemaVersion: SCHEMA_VERSION,
      id,
      kind,
      sha256: digest,
      bytes,
      createdAt: nowIso(),
      relativePath,
    });
    await atomicWrite(
      join(this.root, 'runs', `${id}.${kind}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  async get(record: ArtifactRecord): Promise<Buffer> {
    const expected = join(this.root, record.relativePath);
    const data = await readFile(expected);
    if (sha256(data) !== record.sha256) throw new Error('artifact digest mismatch');
    return data;
  }
}

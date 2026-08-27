import { PgBoss } from "pg-boss";

export type QueueName = "langsmith.import" | "langfuse.import" | "ironside.import" | "judge.run" | "gate.run" | "feedback.sync" | "eval.run" | "eval.item" | "binary-calibration.run";
export type QueueJobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

// pg-boss v12 requires a queue row to exist before send()/work() — both throw
// "Queue <name> does not exist" otherwise. Every known queue is created
// (idempotently — pg-boss's create_queue is ON CONFLICT DO NOTHING) at start()
// so adding a name to the union above is the only registration step.
const ALL_QUEUES: QueueName[] = ["langsmith.import", "langfuse.import", "ironside.import", "judge.run", "gate.run", "feedback.sync", "eval.run", "eval.item", "binary-calibration.run"];

export interface QueueSendOptions {
  // A deterministic pg-boss job UUID makes a durable domain dispatch safe to
  // retry without relying on time-window singleton slots.
  id?: string;
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
  expireInSeconds?: number;
  // pg-boss throttle slots are epoch-aligned, not a durable idempotency key.
  // Use `id` plus a domain outbox claim when duplicate work has side effects.
  singletonKey?: string;
  singletonSeconds?: number;
}

// pg-boss retryCount is the number of retries already consumed (0 on the
// first delivery), so retryCount >= retryLimit means the current delivery is
// the final attempt. Metadata is optional because test stubs and NoopQueue do
// not necessarily carry retry state.
export interface QueueJob<T extends object> {
  id: string;
  data: T;
  retryCount?: number;
  retryLimit?: number;
}

export interface Queue {
  start(): Promise<void>;
  stop(): Promise<void>;
  send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string | null>;
  getJobState?(name: QueueName, id: string): Promise<QueueJobState | null>;
  work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void>;
}

export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("DATABASE_URL is required for PgBossQueue");
    this.boss = new PgBoss({ connectionString });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const name of ALL_QUEUES) {
      await this.boss.createQueue(name);
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string | null> {
    return this.boss.send(name, data, options);
  }

  async getJobState(name: QueueName, id: string): Promise<QueueJobState | null> {
    const job = await this.boss.getJobById(name, id);
    return job?.state ?? null;
  }

  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    // pg-boss@12.18.1's installed d.ts exposes WorkHandler as Job[].
    // includeMetadata surfaces retryCount/retryLimit so workers can
    // terminalize domain state before a final-attempt dead letter.
    await this.boss.work<T>(name, { includeMetadata: true }, async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      await handler({
        id: job.id,
        data: job.data as T,
        ...(typeof job.retryCount === "number" ? { retryCount: job.retryCount } : {}),
        ...(typeof job.retryLimit === "number" ? { retryLimit: job.retryLimit } : {})
      });
    });
  }
}

export class NoopQueue implements Queue {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send<T extends object>(_name: QueueName, _data: T, _options?: QueueSendOptions): Promise<string | null> {
    return null;
  }
  async getJobState(): Promise<null> { return null; }
  async work<T extends object>(_name: QueueName, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}
}

export function createQueue(connectionString = process.env.DATABASE_URL): Queue {
  return connectionString ? new PgBossQueue(connectionString) : new NoopQueue();
}

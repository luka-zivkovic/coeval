import type { Queue, QueueName } from "@coeval/queue";
import type { FeedbackSyncJob } from "@coeval/shared";
import { DemoRepository, NoCurrentSkillError } from "../src/repository.js";

export class PurposeCapturingRepository extends DemoRepository {
  readonly importedPurposes = new Array<string>();

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
    this.importedPurposes.push(args[3].ingestionPurpose);
    return super.importTrace(...args);
  }
}

export class BlockedIronsideFeedbackRepository extends DemoRepository {
  readonly blockedFeedback: FeedbackSyncJob[] = [{
    projectId: "proj_langsmith_support",
    feedbackSyncJobId: "fsync_blocked_revalidation"
  }];
  readonly redispatched: FeedbackSyncJob[] = [];

  override async listBlockedIronsideFeedbackSyncJobs(): Promise<FeedbackSyncJob[]> {
    return [...this.blockedFeedback];
  }

  override async markFeedbackSyncPending(job: FeedbackSyncJob): Promise<void> {
    this.redispatched.push(job);
  }
}

export class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: object | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

export class FailingOnceQueue extends CapturingQueue {
  private failed = false;

  override async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Queue unavailable after trace import");
    }
    return super.send(name, data, options);
  }
}

export class EmptySkillRepository extends DemoRepository {
  importCalled = false;

  override async getCurrentSkill(): Promise<never> {
    throw new NoCurrentSkillError("proj_langsmith_support");
  }

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>): ReturnType<DemoRepository["importTrace"]> {
    this.importCalled = true;
    return super.importTrace(...args);
  }
}

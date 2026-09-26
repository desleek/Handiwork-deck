import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env';
import type { PushMessage } from '../services/notifications/push';

export const QUEUE_NAMES = { escalations: 'escalations', notifications: 'notifications', payouts: 'payouts', challenges: 'challenges', maintenance: 'maintenance' } as const;

export type EscalationKind = 'no_quote_widen' | 'no_quote_admin' | 'no_show';
export interface EscalationJobData {
  kind: EscalationKind;
  jobId: string;
  /** Distinguishes deliberate re-schedules of the same escalation (BullMQ dedupes on job id). */
  round?: number;
}
export interface ChallengeStepData {
  challengeId: string;
  step: 'reminder' | 'escalate' | 'final';
  n?: number;
}
export interface PayoutJobData {
  payoutId: string;
}
export interface NotificationJobData {
  userId: string;
  message: PushMessage;
}

/** Thin seam over BullMQ so the API can run (and be tested) without Redis. */
export interface JobScheduler {
  scheduleEscalation(data: EscalationJobData, delayMs: number): Promise<void>;
  notify(userId: string, message: PushMessage): Promise<void>;
  schedulePayout(payoutId: string, delayMs: number): Promise<void>;
  scheduleChallengeStep(data: ChallengeStepData, delayMs: number): Promise<void>;
  close(): Promise<void>;
}

let redis: Redis | undefined;
export function redisConnection(): Redis {
  // BullMQ workers require maxRetriesPerRequest: null.
  redis ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

class BullScheduler implements JobScheduler {
  private readonly escalations = new Queue<EscalationJobData>(QUEUE_NAMES.escalations, { connection: redisConnection() });
  private readonly notifications = new Queue<NotificationJobData>(QUEUE_NAMES.notifications, { connection: redisConnection() });
  private readonly payouts = new Queue<PayoutJobData>(QUEUE_NAMES.payouts, { connection: redisConnection() });
  private readonly challenges = new Queue<ChallengeStepData>(QUEUE_NAMES.challenges, { connection: redisConnection() });

  async scheduleChallengeStep(data: ChallengeStepData, delayMs: number) {
    await this.challenges.add(data.step, data, {
      delay: delayMs,
      jobId: `challenge:${data.challengeId}:${data.step}:${data.n ?? 0}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 5000,
      removeOnFail: 5000,
    });
  }

  async schedulePayout(payoutId: string, delayMs: number) {
    // Not retried automatically: a failed transfer refunds the wallet and the technician can request again.
    await this.payouts.add('payout', { payoutId }, { delay: delayMs, jobId: `payout:${payoutId}`, removeOnComplete: 1000, removeOnFail: 5000 });
  }

  async scheduleEscalation(data: EscalationJobData, delayMs: number) {
    // Deterministic id: re-scheduling the same escalation for a job is a no-op.
    await this.escalations.add(data.kind, data, {
      delay: delayMs,
      jobId: `${data.kind}:${data.jobId}:${data.round ?? 1}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async notify(userId: string, message: PushMessage) {
    await this.notifications.add('push', { userId, message }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async close() {
    await Promise.all([this.escalations.close(), this.notifications.close(), this.payouts.close(), this.challenges.close()]);
  }
}

/** Records scheduled work in memory; used by tests. */
export class InMemoryScheduler implements JobScheduler {
  escalations: { data: EscalationJobData; delayMs: number }[] = [];
  notifications: NotificationJobData[] = [];
  payouts: { payoutId: string; delayMs: number }[] = [];
  challengeSteps: { data: ChallengeStepData; delayMs: number }[] = [];
  async scheduleChallengeStep(data: ChallengeStepData, delayMs: number) {
    this.challengeSteps.push({ data, delayMs });
  }
  async schedulePayout(payoutId: string, delayMs: number) {
    this.payouts.push({ payoutId, delayMs });
  }
  async scheduleEscalation(data: EscalationJobData, delayMs: number) {
    this.escalations.push({ data, delayMs });
  }
  async notify(userId: string, message: PushMessage) {
    this.notifications.push({ userId, message });
  }
  async close() {}
  reset() {
    this.escalations = [];
    this.notifications = [];
    this.payouts = [];
    this.challengeSteps = [];
  }
}

let scheduler: JobScheduler | undefined;
export function jobs(): JobScheduler {
  scheduler ??= env.NODE_ENV === 'test' ? new InMemoryScheduler() : new BullScheduler();
  return scheduler;
}
export function setScheduler(s: JobScheduler) {
  scheduler = s;
}

export const minutes = (n: number) => n * 60_000;

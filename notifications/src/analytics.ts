import { Config, Evaluation, Job, Subscription } from './model';
import { Store } from './store';
import { ENGINE_VERSION } from './shared/engine';
import {
  DecisionRecord,
  DeliveryRecord,
  NotificationAnalytics,
  SubscriberRecord,
} from './analytics-contract';

const DAY = 86_400_000;
const LIMIT = 500;

// Keep response size bounded without truncating the aggregate metrics.
function keepNewest<T>(rows: T[], value: T, timestamp: (row: T) => number) {
  rows.push(value);
  rows.sort((a, b) => timestamp(b) - timestamp(a));
  if (rows.length > LIMIT) rows.pop();
}

function counts(values: Map<string, number>) {
  return [...values]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function notificationAnalytics(
  store: Store,
  config: Config,
  now: number,
): Promise<NotificationAnalytics> {
  const since = now - 14 * DAY;
  const subscriptions = new Map<string, Subscription>();
  const subscribers: SubscriberRecord[] = [];
  const deliveries: DeliveryRecord[] = [];
  const evaluations: DecisionRecord[] = [];
  const reasons = new Map<string, number>();
  const profiles = new Map<string, number>();
  const totals: NotificationAnalytics['totals'] = {
    subscribers: 0,
    states: {},
    activeEmail: 0,
    activePush: 0,
    deliveries: 0,
    sentEmail: 0,
    sentPush: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    retried: 0,
    sentWithoutTimestamp: 0,
    evaluations: 0,
    eligible: 0,
    evaluationFailures: 0,
  };
  const daily = new Map<string, { day: string; email: number; push: number }>();
  // Rolling 14 days can cover parts of 15 UTC calendar dates.
  for (let day = Date.parse(new Date(since).toISOString().slice(0, 10)); day <= now; day += DAY) {
    const key = new Date(day).toISOString().slice(0, 10);
    daily.set(key, { day: key, email: 0, push: 0 });
  }

  for await (const { value: s } of store.list<Subscription>('subscriptions')) {
    if (s.expires && s.expires <= now) continue;
    subscriptions.set(s.id, s);
    totals.subscribers++;
    totals.states[s.state] = (totals.states[s.state] ?? 0) + 1;
    if (s.state === 'active') {
      if (s.channel === 'email') totals.activeEmail++;
      else totals.activePush++;
      profiles.set(s.preferences.profile, (profiles.get(s.preferences.profile) ?? 0) + 1);
    }
    keepNewest(
      subscribers,
      {
        id: s.id,
        channel: s.channel,
        email: s.email ?? null,
        state: s.state,
        place: s.place.name,
        timeZone: s.place.timeZone,
        profile: s.preferences.profile,
        equipment: s.preferences.equipment,
        notifyMinute: s.preferences.notifyMinute,
        days: s.preferences.days,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        pausedUntil: s.pausedUntil ?? null,
      },
      (row) => row.createdAt,
    );
  }

  for await (const { value: j } of store.list<Job>('jobs')) {
    if (Math.max(j.createdAt, j.sentAt ?? 0, j.completedAt ?? 0) < since || j.createdAt > now)
      continue;
    if (j.kind === 'evaluate') {
      if (j.state === 'failed') totals.evaluationFailures++;
      continue;
    }
    const s = subscriptions.get(j.subscriptionId);
    const channel = j.deliveryChannel ?? s?.channel ?? null;
    // Expired pending jobs can remain until cleanup. They cannot be sent.
    const expired = (j.state === 'pending' || j.state === 'sending') && j.expires <= now;
    const state = expired ? 'cancelled' : j.state;
    const record: DeliveryRecord = {
      id: j.id,
      subscriptionId: j.subscriptionId,
      kind: j.kind,
      channel,
      recipient: j.deliveryRecipient ?? s?.email ?? null,
      place: j.deliveryPlace ?? s?.place.name ?? null,
      timeZone: j.deliveryTimeZone ?? s?.place.timeZone ?? null,
      state,
      createdAt: j.createdAt,
      sentAt: j.sentAt ?? null,
      completedAt: j.completedAt ?? null,
      lastAttemptAt: j.lastAttemptAt ?? null,
      nextAttempt: state === 'pending' ? j.nextAttempt : null,
      attempts: j.attempts,
      error: j.error ?? null,
      errorCode: j.errorCode ?? null,
      errorStage: j.errorStage ?? null,
      backendWakeMs: j.backendWakeMs ?? null,
      cancellationReason: expired ? 'Delivery window expired' : (j.cancellationReason ?? null),
      night: j.advice?.night ?? null,
      window: j.advice?.best ?? null,
    };
    totals.deliveries++;
    if (state === 'sent') {
      if (channel === 'email') totals.sentEmail++;
      if (channel === 'push') totals.sentPush++;
      if (!j.sentAt) totals.sentWithoutTimestamp++;
      else if (j.sentAt >= since && j.sentAt <= now && channel) {
        const bucket = daily.get(new Date(j.sentAt).toISOString().slice(0, 10));
        if (bucket) bucket[channel]++;
      }
    }
    if (state === 'failed') totals.failed++;
    if (state === 'pending' || state === 'sending') totals.pending++;
    if (state === 'cancelled') totals.cancelled++;
    if (j.attempts > 1) totals.retried++;
    keepNewest(deliveries, record, (row) => row.createdAt);
  }

  for await (const { value: e } of store.list<Evaluation>('evaluations')) {
    if (e.createdAt < since || e.createdAt > now) continue;
    totals.evaluations++;
    if (e.eligible) totals.eligible++;
    else
      for (const reason of new Set(e.reasons)) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    const s = subscriptions.get(e.subscriptionId);
    keepNewest(
      evaluations,
      {
        id: e.id,
        subscriptionId: e.subscriptionId,
        recipient: s?.email ?? null,
        place: s?.place.name ?? null,
        timeZone: s?.place.timeZone ?? null,
        night: e.night,
        createdAt: e.createdAt,
        eligible: e.eligible,
        mode: e.mode,
        reasons: e.reasons,
        best: e.best,
      },
      (row) => row.createdAt,
    );
  }

  const health = await store.get<{
    id: string;
    startedAt?: number;
    completedAt?: number;
    failedAt?: number;
  }>('health', 'scheduler');
  return {
    generatedAt: now,
    since,
    retentionDays: 14,
    mode: config.mode,
    emailEnabled: config.emailEnabled,
    pushEnabled: config.pushEnabled,
    engineVersion: ENGINE_VERSION,
    scheduler: health
      ? {
          startedAt: health.value.startedAt,
          completedAt: health.value.completedAt,
          failedAt: health.value.failedAt,
        }
      : null,
    totals,
    daily: [...daily.values()],
    reasons: counts(reasons),
    profiles: counts(profiles),
    deliveries,
    subscribers,
    evaluations,
    limits: { deliveries: LIMIT, subscribers: LIMIT, evaluations: LIMIT },
  };
}

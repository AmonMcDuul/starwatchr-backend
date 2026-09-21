// Read-only notification analytics contract. Timestamps are Unix milliseconds.
export interface DeliveryRecord {
  id: string;
  subscriptionId: string;
  kind: 'advice' | 'confirm' | 'manage';
  channel: 'email' | 'push' | null;
  recipient: string | null;
  place: string | null;
  timeZone: string | null;
  state: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
  createdAt: number;
  sentAt: number | null;
  completedAt: number | null;
  lastAttemptAt: number | null;
  nextAttempt: number | null;
  attempts: number;
  error: string | null;
  errorCode: number | null;
  errorStage: 'wake' | 'delivery' | null;
  backendWakeMs: number | null;
  cancellationReason: string | null;
  night: string | null;
  window: { start: number; end: number; score: number } | null;
}
export interface SubscriberRecord {
  id: string;
  channel: 'email' | 'push';
  email: string | null;
  state: 'pending' | 'active' | 'paused' | 'unsubscribed' | 'suppressed' | 'expired';
  place: string;
  timeZone: string;
  profile: string;
  equipment: string;
  notifyMinute: number;
  days: number[];
  createdAt: number;
  updatedAt: number;
  pausedUntil: number | null;
}
export interface DecisionRecord {
  id: string;
  subscriptionId: string;
  recipient: string | null;
  place: string | null;
  timeZone: string | null;
  night: string;
  createdAt: number;
  eligible: boolean;
  mode: string;
  reasons: string[];
  best: { start: number; end: number; score: number } | null;
}
export interface NotificationAnalytics {
  generatedAt: number;
  since: number;
  retentionDays: number;
  mode: 'live' | 'dry-run';
  emailEnabled: boolean;
  pushEnabled: boolean;
  engineVersion: string;
  scheduler: { startedAt?: number; completedAt?: number; failedAt?: number } | null;
  totals: {
    subscribers: number;
    states: Record<string, number>;
    activeEmail: number;
    activePush: number;
    deliveries: number;
    sentEmail: number;
    sentPush: number;
    failed: number;
    pending: number;
    cancelled: number;
    retried: number;
    sentWithoutTimestamp: number;
    evaluations: number;
    eligible: number;
    evaluationFailures: number;
  };
  daily: { day: string; email: number; push: number }[];
  reasons: { label: string; count: number }[];
  profiles: { label: string; count: number }[];
  deliveries: DeliveryRecord[];
  subscribers: SubscriberRecord[];
  evaluations: DecisionRecord[];
  limits: { deliveries: number; subscribers: number; evaluations: number };
}

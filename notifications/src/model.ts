import { Advice, Place, Preferences, WeatherSnapshot } from './shared/engine';
import { PushData } from './security';
export interface Subscription {
  id: string;
  channel: 'email' | 'push';
  email?: string;
  push?: PushData;
  place: Place;
  preferences: Preferences;
  state: 'pending' | 'active' | 'paused' | 'unsubscribed' | 'suppressed' | 'expired';
  pausedUntil?: number;
  manageHash: string;
  manageExpires: number;
  createdAt: number;
  updatedAt: number;
  expires?: number;
}
export interface Job {
  id: string;
  kind: 'evaluate' | 'advice' | 'confirm' | 'manage';
  subscriptionId: string;
  createdAt: number;
  state: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
  attempts: number;
  nextAttempt: number;
  expires: number;
  leaseUntil?: number;
  lease?: string;
  advice?: Advice;
  token?: string;
  providerId?: string;
  sentAt?: number;
  completedAt?: number;
  lastAttemptAt?: number;
  deliveryChannel?: Subscription['channel'];
  deliveryRecipient?: string;
  deliveryPlace?: string;
  deliveryTimeZone?: string;
  cancellationReason?: string;
  errorCode?: number;
  errorStage?: 'wake' | 'delivery';
  backendWakeMs?: number;
  error?: string;
}
export interface Evaluation {
  id: string;
  subscriptionId: string;
  night: string;
  createdAt: number;
  eligible: boolean;
  mode: string;
  reasons: string[];
  best: Advice['best'];
  version: string;
  expires: number;
}
export interface Config {
  siteUrl: string;
  apiUrl: string;
  tokenSecret: string;
  mode: 'dry-run' | 'live';
  vapidPublicKey: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  adminKey: string;
  analyticsKey?: string;
}
export interface DeliveryResult {
  providerId?: string;
}
export interface Sender {
  prepare?(subscription: Subscription): Promise<{ backendWakeMs?: number }>;
  send(subscription: Subscription, job: Job): Promise<DeliveryResult>;
}
export type WeatherLoader = (place: Place, now: number) => Promise<WeatherSnapshot>;

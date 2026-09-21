import { Store } from './store';
import { notificationAnalytics } from './analytics';
import { Config, Subscription, Job, Sender, WeatherLoader, Evaluation } from './model';
import { Tokens, hash, secret, equal, validatePush } from './security';
import {
  ENGINE_VERSION,
  validatePlace,
  validatePreferences,
  localParts,
  buildAdvice,
  Preferences,
  Place,
} from './shared/engine';
const DAY = 86400000;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class NotificationApp {
  readonly tokens: Tokens;
  private verifyLink(token: string, purpose: string, now: number) {
    try {
      return this.tokens.verify(token, purpose, now);
    } catch {
      throw new HttpError(400, 'Invalid or expired link.');
    }
  }
  constructor(
    readonly store: Store,
    readonly config: Config,
    private weather: WeatherLoader,
    private sender: Sender,
    private enqueue: (id: string) => Promise<void>,
  ) {
    this.tokens = new Tokens(config.tokenSecret);
  }
  async rate(key: string, limit: number, period: number, now: number) {
    const id = hash(key + ':' + Math.floor(now / period));
    for (let i = 0; i < 6; i++) {
      const row = await this.store.get<{ id: string; count: number; expires: number }>(
        'limits',
        id,
      );
      if (!row) {
        if (await this.store.create('limits', { id, count: 1, expires: now + period * 2 })) return;
      } else {
        if (row.value.count >= limit) throw new HttpError(429, 'Please try again later.');
        if (
          await this.store.replace('limits', { ...row.value, count: row.value.count + 1 }, row.etag)
        )
          return;
      }
    }
    throw new HttpError(429, 'Please try again later.');
  }
  private fields(body: any): { place: Place; preferences: Preferences } {
    try {
      validatePlace(body?.place);
      validatePreferences(body?.preferences);
    } catch {
      throw new HttpError(400, 'Choose a valid location and observing preferences.');
    }
    if (body.preferences.notifyMinute < 720 || body.preferences.notifyMinute > 1380)
      throw new HttpError(400, 'Choose a notification time between noon and 23:00.');
    // Construct fields explicitly: no client-controlled state, secrets or persistence fields.
    const p = body.preferences;
    return {
      place: {
        name: body.place.name.trim(),
        latitude: body.place.latitude,
        longitude: body.place.longitude,
        timeZone: body.place.timeZone,
      },
      preferences: {
        profile: p.profile,
        equipment: p.equipment,
        startMinute: p.startMinute,
        endMinute: p.endMinute,
        notifyMinute: p.notifyMinute,
        days: [...new Set(p.days)] as number[],
        minMinutes: p.minMinutes,
        maxCloud: p.maxCloud,
        maxWindKmh: p.maxWindKmh,
        maxPrecipitationProbability: p.maxPrecipitationProbability,
        maxMoonIllumination: p.maxMoonIllumination,
      },
    };
  }
  async createJob(job: Job) {
    if (job.kind !== 'evaluate') {
      const subscription = await this.store.get<Subscription>('subscriptions', job.subscriptionId);
      if (subscription) {
        job = {
          ...job,
          deliveryChannel: subscription.value.channel,
          deliveryRecipient: subscription.value.email,
          deliveryPlace: subscription.value.place.name,
          deliveryTimeZone: subscription.value.place.timeZone,
        };
      }
    }
    if (await this.store.create('jobs', job)) {
      try {
        await this.enqueue(job.id);
      } catch {
        /* Timer repairs pending work; persistence is the source of truth. */
      }
    }
  }
  private job(kind: Job['kind'], subId: string, now: number, seed: string): Job {
    return {
      id: hash(seed),
      kind,
      subscriptionId: subId,
      createdAt: now,
      state: 'pending',
      attempts: 0,
      nextAttempt: now,
      expires: now + DAY,
    };
  }
  async emailStart(body: any, now: number, manageOnly = false) {
    if (!this.config.emailEnabled)
      throw new HttpError(503, 'Email subscriptions are not available yet.');
    if (
      typeof body?.email !== 'string' ||
      body.email.length > 254 ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(body.email)
    )
      throw new HttpError(400, 'Enter a valid email address.');
    const email = body.email.trim().toLowerCase(),
      id = this.tokens.addressId(email);
    const fields = manageOnly ? null : this.fields(body);
    await this.rate('email:' + id, 2, 3600000, now);
    await this.rate('email-total', 100, 3600000, now);
    let row = await this.store.get<Subscription>('subscriptions', id);
    if (!row && !manageOnly) {
      await this.store.create('subscriptions', {
        id,
        channel: 'email',
        email,
        ...fields!,
        state: 'pending',
        manageHash: '',
        manageExpires: 0,
        createdAt: now,
        updatedAt: now,
        expires: now + 7 * DAY,
      } as Subscription);
      row = await this.store.get<Subscription>('subscriptions', id);
    }
    if (row && row.value.state !== 'suppressed') {
      const kind = row.value.state === 'pending' ? 'confirm' : 'manage';
      const job = this.job(kind, id, now, kind + id + Math.floor(now / 3600000));
      job.token = this.tokens.sign(id, kind, now + DAY);
      await this.createJob(job);
    }
    return {
      message:
        'If this address can receive alerts, a confirmation or settings link will arrive shortly.',
    };
  }
  async redeem(token: string, purpose: 'confirm' | 'manage', now: number) {
    const id = this.verifyLink(token, purpose, now),
      row = await this.store.get<Subscription>('subscriptions', id);
    if (!row || row.value.state === 'suppressed')
      throw new HttpError(400, 'This subscription is unavailable.');
    // A mail link is single-use. Scanners following GET links cannot consume it.
    if (!(await this.store.create('usedLinks', { id: hash(token), expires: now + 2 * DAY })))
      throw new HttpError(400, 'This link was already used. Request a new settings link.');
    const credential = secret(),
      value = {
        ...row.value,
        manageHash: hash(credential),
        manageExpires: now + 90 * DAY,
        updatedAt: now,
      };
    if (purpose === 'confirm' && value.state === 'pending') {
      value.state = 'active';
      delete value.expires;
    }
    if (!(await this.store.replace('subscriptions', value, row.etag)))
      throw new HttpError(409, 'Settings changed. Request a new link.');
    return { id, credential, subscription: this.publicSub(value) };
  }
  async pushStart(body: any, now: number) {
    if (!this.config.pushEnabled)
      throw new HttpError(503, 'Push subscriptions are not available yet.');
    const fields = this.fields(body);
    try {
      validatePush(body.push);
    } catch {
      throw new HttpError(400, 'Invalid or unsupported push subscription.');
    }
    const id = hash(body.push.endpoint),
      existing = await this.store.get<Subscription>('subscriptions', id);
    // Knowledge of an endpoint is not a management credential.
    if (existing)
      throw new HttpError(
        409,
        'This browser is already registered. Use its saved settings, or reset its browser push subscription.',
      );
    const credential = secret(),
      value: Subscription = {
        id,
        channel: 'push',
        push: body.push,
        ...fields,
        state: 'active',
        manageHash: hash(credential),
        manageExpires: now + 365 * DAY,
        createdAt: now,
        updatedAt: now,
      };
    if (!(await this.store.create('subscriptions', value)))
      throw new HttpError(409, 'Already registered.');
    return { id, credential, subscription: this.publicSub(value) };
  }
  publicSub(s: Subscription) {
    return {
      id: s.id,
      channel: s.channel,
      place: s.place,
      preferences: s.preferences,
      state: s.state,
      pausedUntil: s.pausedUntil,
      updatedAt: s.updatedAt,
    };
  }
  async authorize(id: string, bearer: string, now: number) {
    const row = await this.store.get<Subscription>('subscriptions', id);
    if (
      !row ||
      !bearer ||
      row.value.manageExpires < now ||
      !equal(hash(bearer), row.value.manageHash)
    )
      throw new HttpError(401, 'Open a valid settings link or register this device again.');
    return row;
  }
  async update(id: string, bearer: string, body: any, now: number) {
    const row = await this.authorize(id, bearer, now),
      fields = this.fields(body);
    if (!['active', 'paused', 'unsubscribed'].includes(body.state))
      throw new HttpError(400, 'Invalid subscription state.');
    if (['pending', 'suppressed', 'expired'].includes(row.value.state))
      throw new HttpError(409, 'This subscription cannot be activated here.');
    if (
      body.state === 'paused' &&
      (!Number.isFinite(body.pausedUntil) ||
        body.pausedUntil <= now ||
        body.pausedUntil > now + 90 * DAY)
    )
      throw new HttpError(400, 'Choose a pause of up to 90 days.');
    const value: Subscription = { ...row.value, ...fields, state: body.state, updatedAt: now };
    if (body.state === 'paused') value.pausedUntil = body.pausedUntil;
    else delete value.pausedUntil;
    if (body.state === 'unsubscribed') value.expires = now + 30 * DAY;
    else delete value.expires;
    if (!(await this.store.replace('subscriptions', value, row.etag)))
      throw new HttpError(409, 'Settings changed; reload and try again.');
    return this.publicSub(value);
  }
  async unsubscribe(token: string, now: number) {
    const id = this.verifyLink(token, 'unsubscribe', now);
    for (let i = 0; i < 5; i++) {
      const row = await this.store.get<Subscription>('subscriptions', id);
      if (!row || row.value.state === 'suppressed') return;
      if (
        await this.store.replace(
          'subscriptions',
          {
            ...row.value,
            state: 'unsubscribed',
            updatedAt: now,
            expires: now + 30 * DAY,
          } as Subscription,
          row.etag,
        )
      )
        return;
    }
    throw new HttpError(409, 'Please retry.');
  }
  async suppress(email: string, now: number) {
    for (let i = 0; i < 5; i++) {
      const row = await this.store.get<Subscription>('subscriptions', this.tokens.addressId(email));
      if (!row) return;
      if (
        await this.store.replace(
          'subscriptions',
          {
            ...row.value,
            state: 'suppressed',
            updatedAt: now,
            expires: now + 90 * DAY,
          } as Subscription,
          row.etag,
        )
      )
        return;
    }
    throw new HttpError(503, 'Please retry suppression.');
  }
  private async schedulerHealth(update: {
    startedAt?: number;
    completedAt?: number;
    failedAt?: number;
  }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.store.get<{ id: string }>('health', 'scheduler');
      const value = { ...row?.value, id: 'scheduler', ...update };
      const saved = row
        ? await this.store.replace('health', value, row.etag)
        : await this.store.create('health', value);
      if (saved) return;
    }
  }

  async tick(now: number) {
    await this.schedulerHealth({ startedAt: now });
    try {
      await this.schedule(now);
      await this.schedulerHealth({ completedAt: Date.now() });
    } catch (error) {
      await this.schedulerHealth({ failedAt: Date.now() });
      throw error;
    }
  }

  private async schedule(now: number) {
    for await (const row of this.store.list<Subscription>('subscriptions')) {
      let s = row.value;
      if (s.state === 'paused' && (s.pausedUntil ?? Infinity) <= now) {
        s = { ...s, state: 'active', updatedAt: now };
        delete s.pausedUntil;
        if (!(await this.store.replace('subscriptions', s, row.etag))) continue;
      }
      if (s.state !== 'active') continue;
      const local = localParts(now, s.place.timeZone);
      if (
        local.minute < s.preferences.notifyMinute ||
        local.minute >= s.preferences.notifyMinute + 60
      )
        continue;
      const job = this.job('evaluate', s.id, now, 'eval:' + s.id + ':' + Math.floor(now / 600000));
      job.expires = now + 3600000;
      await this.createJob(job);
    }
    // Recovers jobs persisted before a crash or queue outage. Claims prevent duplicate sends.
    for await (const row of this.store.list<Job>('jobs')) {
      const j = row.value;
      if (
        (j.state === 'pending' || j.state === 'sending') &&
        j.expires <= now &&
        (j.leaseUntil ?? 0) <= now
      ) {
        await this.store.replace(
          'jobs',
          {
            ...j,
            state: 'cancelled',
            completedAt: now,
            cancellationReason: 'Delivery window expired',
            expires: Math.max(now + DAY, j.createdAt + 14 * DAY),
          },
          row.etag,
        );
        continue;
      }
      if (
        (j.state === 'pending' || j.state === 'sending') &&
        j.nextAttempt <= now &&
        (j.leaseUntil ?? 0) <= now &&
        j.expires > now
      )
        await this.enqueue(j.id);
    }
  }
  async process(id: string, now: number) {
    const processingStartedAt = Date.now();
    const row = await this.store.get<Job>('jobs', id);
    if (
      !row ||
      !['pending', 'sending'].includes(row.value.state) ||
      row.value.nextAttempt > now ||
      (row.value.leaseUntil ?? 0) > now
    )
      return;
    let j = row.value;
    if (j.expires <= now) {
      await this.store.replace(
        'jobs',
        {
          ...j,
          state: 'cancelled',
          completedAt: now,
          cancellationReason: 'Delivery window expired',
          expires: Math.max(j.expires, j.createdAt + 14 * DAY),
        },
        row.etag,
      );
      return;
    }
    const lease = secret();
    j = {
      ...j,
      state: 'sending',
      lease,
      leaseUntil: now + 120000,
      attempts: j.attempts + 1,
      lastAttemptAt: now,
    };
    if (!(await this.store.replace('jobs', j, row.etag))) return;
    try {
      const sub = await this.store.get<Subscription>('subscriptions', j.subscriptionId);
      if (!sub) {
        await this.finish(
          { ...j, cancellationReason: 'Subscription no longer exists' },
          'cancelled',
        );
        return;
      }
      if (j.kind === 'evaluate') {
        await this.evaluate(sub.value, j, now);
        await this.finish(j, 'sent');
        return;
      }
      if (j.kind === 'advice') {
        if (
          sub.value.state !== 'active' ||
          this.config.mode !== 'live' ||
          !j.advice?.best ||
          j.advice.best.end <= now ||
          now - j.advice.fetchedAt > 3 * 3600000 ||
          sub.value.updatedAt > j.createdAt
        ) {
          await this.finish(
            { ...j, cancellationReason: 'Subscription, forecast or observing window changed' },
            'cancelled',
          );
          return;
        }
      } else if (
        sub.value.state === 'suppressed' ||
        (j.kind === 'confirm' && sub.value.state !== 'pending')
      ) {
        await this.finish(
          { ...j, cancellationReason: 'Subscription no longer accepts this message' },
          'cancelled',
        );
        return;
      }
      const preparation = await this.sender.prepare?.(sub.value);
      j = { ...j, ...preparation };
      // Waking a sleeping API can take time. Re-read preferences and expiry after waking it.
      const current = await this.store.get<Subscription>('subscriptions', j.subscriptionId);
      const deliveryNow = now + Math.max(0, Date.now() - processingStartedAt);
      if (
        !current ||
        j.expires <= deliveryNow ||
        current.value.state === 'suppressed' ||
        (j.kind === 'confirm' && current.value.state !== 'pending') ||
        (j.kind === 'advice' &&
          (current.value.state !== 'active' ||
            this.config.mode !== 'live' ||
            current.value.updatedAt > j.createdAt ||
            !j.advice?.best ||
            j.advice.best.end <= deliveryNow ||
            deliveryNow - j.advice.fetchedAt > 3 * 3600000))
      ) {
        await this.finish(
          {
            ...j,
            cancellationReason: 'Subscription or delivery window changed while preparing delivery',
          },
          'cancelled',
        );
        return;
      }
      j = {
        ...j,
        deliveryChannel: current.value.channel,
        deliveryRecipient: current.value.email,
        deliveryPlace: current.value.place.name,
        deliveryTimeZone: current.value.place.timeZone,
      };
      const result = await this.sender.send(current.value, j);
      delete j.error;
      delete j.errorCode;
      delete j.errorStage;
      await this.finish({ ...j, providerId: result.providerId, sentAt: Date.now() }, 'sent');
    } catch (error: any) {
      const status = error.statusCode ?? error.status;
      if ((status === 404 || status === 410) && j.kind === 'advice') {
        const sub = await this.store.get<Subscription>('subscriptions', j.subscriptionId);
        if (sub?.value.channel === 'push')
          await this.store.replace(
            'subscriptions',
            { ...sub.value, state: 'expired', updatedAt: now, expires: now + 30 * DAY },
            sub.etag,
          );
      }
      const permanent =
        (error.retryable !== true && [400, 401, 403, 404, 410, 422].includes(status)) ||
        j.attempts >= 6;
      await this.finish(
        {
          ...j,
          error:
            error.stage === 'wake'
              ? 'Backend is not ready'
              : permanent
                ? 'Delivery failed; operator review required'
                : 'Provider unavailable',
          errorStage: error.stage === 'wake' ? 'wake' : 'delivery',
          errorCode: Number.isInteger(status) ? status : undefined,
          nextAttempt: now + Math.min(3600000, 30000 * 2 ** j.attempts),
        },
        permanent ? 'failed' : 'pending',
      );
    }
  }
  private async finish(j: Job, state: Job['state']) {
    const row = await this.store.get<Job>('jobs', j.id);
    if (!row || row.value.lease !== j.lease) return;
    const value = {
      ...j,
      state,
      leaseUntil: 0,
      completedAt: state === 'pending' ? undefined : Date.now(),
      expires: state === 'pending' ? j.expires : Math.max(j.expires, j.createdAt + 14 * DAY),
    };
    await this.store.replace('jobs', value, row.etag);
  }
  private async evaluate(s: Subscription, j: Job, now: number) {
    if (s.state !== 'active') return;
    const local = localParts(now, s.place.timeZone);
    if (
      local.minute < s.preferences.notifyMinute ||
      local.minute >= s.preferences.notifyMinute + 60
    )
      return;
    const snapshot = await this.weather(s.place, now);
    const advice = buildAdvice(snapshot, s.place, s.preferences, now, local.date);
    const evaluation: Evaluation = {
      id: j.id,
      subscriptionId: s.id,
      night: advice.night,
      createdAt: now,
      eligible: !!advice.best,
      mode: this.config.mode,
      reasons: advice.reasons,
      best: advice.best,
      version: advice.version,
      expires: now + 14 * DAY,
    };
    await this.store.create('evaluations', evaluation);
    if (!advice.best || this.config.mode !== 'live') return;
    const job = this.job('advice', s.id, now, 'advice:' + s.id + ':' + advice.night);
    job.advice = advice;
    job.expires = Math.min(advice.best.start, now + 3600000);
    if (job.expires > now) await this.createJob(job);
  }
  async cleanup(now: number) {
    for (const kind of ['limits', 'usedLinks', 'weather', 'evaluations', 'jobs', 'subscriptions'])
      for await (const row of this.store.list<{ id: string; expires?: number }>(kind)) {
        if (row.value.expires && row.value.expires < now)
          try {
            await this.store.remove(kind, row.value.id, row.etag);
          } catch {
            /* Concurrent edits win. */
          }
      }
  }
  async handle(
    method: string,
    path: string,
    body: any,
    bearer: string,
    now = Date.now(),
  ): Promise<{ status: number; body: any }> {
    try {
      if (method === 'GET' && path === 'config')
        return {
          status: 200,
          body: {
            mode: this.config.mode,
            engineVersion: ENGINE_VERSION,
            emailEnabled: this.config.emailEnabled,
            pushEnabled: this.config.pushEnabled,
            vapidPublicKey: this.config.vapidPublicKey,
          },
        };
      if (method === 'POST' && path === 'email/start')
        return { status: 202, body: await this.emailStart(body, now) };
      if (method === 'POST' && path === 'email/link')
        return { status: 202, body: await this.emailStart(body, now, true) };
      if (method === 'POST' && path === 'confirm')
        return { status: 200, body: await this.redeem(body.token, 'confirm', now) };
      if (method === 'POST' && path === 'manage')
        return { status: 200, body: await this.redeem(body.token, 'manage', now) };
      if (method === 'POST' && path === 'push')
        return { status: 201, body: await this.pushStart(body, now) };
      if (method === 'POST' && path === 'unsubscribe') {
        await this.unsubscribe(body.token, now);
        return { status: 200, body: { message: 'Notifications stopped.' } };
      }
      if (method === 'POST' && path === 'report') {
        const id = this.verifyLink(body?.token, 'report', now),
          job = await this.store.get<Job>('jobs', id);
        if (!job?.value.advice) throw new HttpError(404, 'This report has expired.');
        return { status: 200, body: job.value.advice };
      }
      const match = /^subscriptions\/([a-f0-9]{64})$/.exec(path);
      if (match) {
        if (method === 'GET')
          return {
            status: 200,
            body: this.publicSub((await this.authorize(match[1], bearer, now)).value),
          };
        if (method === 'PATCH')
          return { status: 200, body: await this.update(match[1], bearer, body, now) };
        if (method === 'DELETE') {
          const row = await this.authorize(match[1], bearer, now);
          if (
            row.value.state !== 'suppressed' &&
            !(await this.store.replace(
              'subscriptions',
              {
                ...row.value,
                state: 'unsubscribed',
                updatedAt: now,
                expires: now + 30 * DAY,
              } as Subscription,
              row.etag,
            ))
          )
            throw new HttpError(409, 'Settings changed; reload and try again.');
          return { status: 200, body: { message: 'Notifications stopped.' } };
        }
      }
      if (method === 'GET' && path === 'admin/analytics') {
        const key = this.config.analyticsKey;
        if (!key || key.length < 32 || !equal(bearer, key)) {
          throw new HttpError(401, 'A valid analytics read key is required.');
        }
        await this.rate('analytics-read', 60, 60000, now);
        return { status: 200, body: await notificationAnalytics(this.store, this.config, now) };
      }
      if (method === 'POST' && path === 'admin/suppress') {
        if (!this.config.adminKey || !equal(bearer, this.config.adminKey))
          throw new HttpError(401, 'Unauthorized');
        if (typeof body?.email !== 'string') throw new HttpError(400, 'Supply an email address.');
        await this.suppress(body.email, now);
        return { status: 200, body: { message: 'Delivery suppressed.' } };
      }
      if (method === 'GET' && path === 'admin/jobs') {
        if (!this.config.adminKey || !equal(bearer, this.config.adminKey))
          throw new HttpError(401, 'Unauthorized');
        const jobs = [];
        for await (const { value: j } of this.store.list<Job>('jobs'))
          jobs.push({
            id: j.id,
            kind: j.kind,
            state: j.state,
            attempts: j.attempts,
            createdAt: j.createdAt,
            nextAttempt: j.nextAttempt,
            error: j.error,
          });
        return { status: 200, body: jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200) };
      }
      if (method === 'GET' && path === 'admin/evaluations') {
        if (!this.config.adminKey || !equal(bearer, this.config.adminKey))
          throw new HttpError(401, 'Unauthorized');
        const values: Evaluation[] = [];
        for await (const row of this.store.list<Evaluation>('evaluations')) values.push(row.value);
        return {
          status: 200,
          body: values.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
        };
      }
      throw new HttpError(404, 'Not found');
    } catch (error: any) {
      return {
        status: error instanceof HttpError ? error.status : 503,
        body: {
          error:
            error instanceof HttpError
              ? error.message
              : 'Notification service temporarily unavailable.',
        },
      };
    }
  }
}

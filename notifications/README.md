# Observing notifications

Azure Functions (Node 22 / TypeScript) schedules and evaluates observing alerts. Email delivery calls the existing .NET API's EmailService over an authenticated internal endpoint. The website continues to calculate forecasts locally. The existing App Service can remain on Free: the worker wakes it on demand before sending mail. Notification state remains in separate Azure Storage. Free CPU/bandwidth quotas can still delay or prevent delivery.

## What is implemented

- An observing planner and exact shared calculation source, with location time zones, equipment, observing nights, weather, darkness and Moon limits.
- Dry-run decisions with reasons and a protected review API.
- Confirmed email subscriptions, device Web Push, preferences, pause/resume, unsubscribe, signed report links, durable storage, queues, retries, expiry and delivery suppression.
- A 10-minute UTC timer checks each subscription's **location clock**. Checks continue for one hour after the requested notification time (12:00–23:00). Only a qualifying future window generates an evening message; at most one job per subscription and observing night.
- The cloud template starts in `dry-run`: confirmation/settings emails send, evening decisions are recorded only. Development (`npm run dev`) defaults to live SMTP delivery. Only the explicit test command (`npm run test:local`) captures messages. Operational modes are not displayed as temporary product banners.

## Development with real email

1. Set your existing `EmailSettings` in `api/appsettings.Development.json` or .NET configuration. Keep credentials out of source control:

```json
{
  "EmailSettings": {
    "SmtpServer": "",
    "SmtpPort": 587,
    "FromEmail": "",
    "Password": "",
    "ToEmail": ""
  }
}
```

`ToEmail` is still the recipient of contact-form messages. Observing notifications go to the email address entered and confirmed by the subscriber.

2. In the backend's `notifications` directory run `npm ci`, then `npm run dev`.
3. Run the existing .NET API using its HTTP profile: `dotnet run --project api/Api.csproj --launch-profile http` from the repository root (or the corresponding IDE profile).
4. Start the frontend with `npm start`, visit `http://localhost:4200/alerts`, choose a location and submit your email. The confirmation goes through your SMTP server.

The frontend development proxy forwards /notifications-api to localhost:7071. The worker calls localhost:5016/internal/notification-mail. No Azure Functions host or emulator is required for this development route. Restart ng serve after pulling the proxy change.

The dev worker generates a private relay key in ignored `notifications/.local/api-settings.json`. The API loads that file only in Development. Subscriptions, queue jobs and signed-link secrets survive worker restarts in `.local`. This file store supports one local process only. You can override URLs and settings in an ignored `.env` using `.env.example`. If using another frontend port, update SITE_URL and NOTIFICATIONS_API_URL together.

The local scheduler runs every minute and retries pending SMTP work. Confirmation email is sent immediately after signup. Automatic evening mail still requires a suitable future window at the selected local notification time. Local capture endpoints are available only with --capture; real-mail development never exposes mail tokens through /\_\_test/deliveries.

## Local checks

Node 22 or later:

```powershell
cd notifications
npm ci
npm test
npm run test:local
```

The isolated preview listens on 127.0.0.1:7071, uses memory storage and captures messages at `/__test/deliveries`. It is never a production entry point. The Function App entry point is `dist/functions.js`.

For actual Azure Table/Queue SDK integration, in a separate terminal:

```powershell
npx azurite --silent --skipApiVersionCheck --location .azurite
$env:RUN_AZURITE_TESTS='1'
npm test
```

The integration test uses only the local emulator connection. It checks persistence across clients, optimistic concurrency and queue encoding.

For the real Functions host, install Azure Functions Core Tools v4, copy `local.settings.example.json` to ignored `local.settings.json`, supply local configuration and run `npm start`. This can send real transactional email if real credentials are supplied.

## Calculation contract

The authoritative source is the frontend's `src/app/shared/observing/engine.ts`. Never edit the backend copy independently. From the frontend:

```powershell
node scripts/sync-notification-engine.cjs '<backend repository>'
node scripts/sync-notification-engine.cjs '<backend repository>' --check
```

Both builds verify the committed SHA-256 manifest. Both pin Astronomy Engine 2.1.19. For each rule change bump ENGINE_VERSION, sync both copies, run both suites and deploy compatible frontend/worker releases together. The browser integration script also compares complete advice objects in Chrome with the Node worker for multiple locations and profiles.

Same input snapshot + location + preferences + evaluation instant produces the same advice. Independent weather requests can obtain different model updates; opening a notification first displays its saved snapshot, with an explicit option to calculate the latest forecast. Cache TTL is 45 minutes; snapshots older than 3 hours cannot produce an alert.

All instants use epoch milliseconds. Scheduling, observing dates and rendering use the selected location's IANA zone, never the host/browser default. Nights run noon-to-noon, so Friday 01:00 belongs to Thursday's observing evening. DST changes use actual elapsed duration, including repeated hours, half-hour changes and midnight changes. Ambiguous wall times select the first occurrence; missing times return no instant. Weather timestamps are requested as Unix seconds. Precipitation is shifted from Open-Meteo's preceding-hour label into the correct forward interval.

Windows use half-hour samples and conservative checks at darkness/Moon boundaries; only full slots within chosen observing hours count. Weather remains hourly. Terrain, buildings, light pollution and actual atmospheric seeing are not measured. Scores are comparative heuristics; suitability uses explicit limits, not a magic score threshold.

## Azure deployment

Deployment has not been performed. The template was reviewed against Microsoft's schema documentation but has not been compiled locally: downloading an external Bicep executable was blocked by automatic approval review. Run the what-if step below with your installed Azure CLI/Bicep before provisioning. The template requires a resource group in a Flex Consumption-supported region, Azure CLI with Bicep, and Core Tools v4. It provisions a separate Function App, Storage account (Tables/Queues/Blobs), Flex Consumption plan and Application Insights. No always-ready instances are configured. Storage and logging are billed separately; a usage grant is not a promise of zero cost. Set an Azure budget before enabling live delivery.

1. Copy `infra/parameters.example.json` to ignored `infra/parameters.local.json`. Set the exact frontend origin, unique app name, distinct random token/admin secrets, and optional provider settings. Keep TOKEN_SECRET stable: it signs links and derives subscription IDs. Rotating it invalidates links and requires an explicit subscription migration.
2. Review and deploy:

```powershell
az deployment group what-if --resource-group YOUR_GROUP --template-file infra/main.bicep --parameters '@infra/parameters.local.json'
az deployment group create --resource-group YOUR_GROUP --template-file infra/main.bicep --parameters '@infra/parameters.local.json'
npm ci
npm run build
npm prune --omit=dev
func azure functionapp publish YOUR_FUNCTION_NAME --no-build
# Restore development tools afterwards: npm ci
```

3. Configure the frontend's `public/notifications-config.json` with the deployment's `apiBaseUrl` output (including `/api`) and rebuild/redeploy the frontend. Keep CORS limited to the exact production origin; add a staging origin explicitly when needed.
4. Keep `NOTIFICATION_MODE=dry-run` initially. Complete the staging acceptance checks below. Switch to `live` only after checking actual recorded decisions.

The Bicep appsettings resource replaces settings on deployment. Keep all provider settings in the secure parameters file or supply Key Vault references in deliverySettings. Do not deploy an empty deliverySettings object over a configured live instance. Secrets must never enter source control, terminal output or frontend configuration.

Publish from the notifications directory, which contains host.json and package.json. The --no-build flag uploads the JavaScript already compiled into dist; source and build scripts are intentionally excluded by .funcignore. Local .env files, local.settings.json and .local state are excluded too. The Azure app must have a full AzureWebJobsStorage connection string: the current storage clients do not use identity-only storage configuration.

### Email

Keep the SMTP credentials in the existing API's EmailSettings (Azure app settings use `EmailSettings__SmtpServer`, `EmailSettings__SmtpPort`, `EmailSettings__FromEmail` and `EmailSettings__Password`). Configure the sending domain's SPF/DKIM/DMARC through your mail provider. The implementation uses the existing EmailService and SMTP with STARTTLS, not a separate email delivery provider.

Set a distinct random 32+ character NotificationDelivery\_\_ApiKey on the API. Set the same value as MAIL_SERVICE_KEY on the Function App, and MAIL_SERVICE_URL=https://YOUR_API_HOST/internal/notification-mail. The secret stays server-side. The endpoint cannot accept subscriber recipients without authentication; the public contact endpoint retains its fixed recipient.

The current deployment keeps the API on Free. Deploy the updated API first: it provides authenticated GET /internal/notification-mail/ready. The worker checks this endpoint before SMTP delivery; Always On is not required. Set MAIL_SERVICE_WAKE_ENABLED=false only when deliberately disabling this readiness step. SMTP failures are retried by the worker. SMTP has no universal bounce webhook: monitor the sender mailbox/provider reports, and suppress a bounced/complaining address through authenticated POST /api/admin/suppress with {\"email\":\"address\"} and the notifications admin bearer key.

Email signup requires clicking a link and then Continue. GET cannot confirm, unsubscribe or consume a management token; POST is deliberate. Evening mail has text and HTML alternatives and RFC 8058 one-click unsubscribe headers. A visible unsubscribe link opens a confirmation form. Each retry uses a stable SMTP Message-ID. SMTP does not guarantee deduplication: a timeout or crash after server acceptance can still cause a duplicate. Queue claims prevent ordinary concurrent sends.

### Web Push / PWA

Generate VAPID keys with `npx web-push generate-vapid-keys`, store the private key securely, and configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a monitored mailto contact). Do not rotate VAPID keys without re-enrolling devices. The public key is intentionally public through /api/config.

Production HTTPS and the Angular service worker are required. On iOS/iPadOS, install to the Home Screen and grant notification permission from the app. No account is required: the endpoint identifies the browser installation. One device permission does not apply to another device. Offline devices receive messages only within their short TTL. Revoked/expired subscriptions are removed from active delivery on gateway 404/410. Delivery is best effort; browsers/OS can delay or suppress it.

## Free API readiness

The worker only wakes the API when a real email job is ready; timer ticks and push-only jobs do not call the API. GET /internal/notification-mail/ready requires the same X-Notification-Key as sending and returns 204 without connecting to SMTP.

MAIL_SERVICE_WAKE_ENABLED defaults to true. Readiness uses up to three 15-second requests, with 2- and 4-second delays. One worker shares simultaneous wake requests and caches success for five minutes. A failure gets a one-minute cooldown. This fits within the existing two-minute delivery lease together with the mail request timeout. Readiness proves that the API has started, not that SMTP will succeed.

Azure Free 403 quota responses and temporary 408/429/5xx failures remain retryable. Invalid credentials (401) or a missing readiness route (404) require configuration/deployment fixes. Quotas cannot be bypassed by waking the app. Existing queue retries stop after six claims or message expiry. After preparation, the subscription and time-sensitive advice are rechecked; stale, expired or no-longer-wanted messages are cancelled. Expired pending jobs are retained as cancelled for the delivery log.

The API can remain on Free with this configuration. Keep an eye on Azure's actual CPU and bandwidth quotas before deciding whether to upgrade. The ten-minute scheduler has not changed.

## Analytics dashboard

SW-Analytics reads authenticated GET /api/admin/analytics. Set a distinct random 32+ character NOTIFICATIONS_ANALYTICS_KEY in the Function App settings (or in local .env). This read-only key is separate from NOTIFICATIONS_ADMIN_KEY and MAIL_SERVICE_KEY; it cannot suppress subscribers or use operator routes.

Add the exact analytics site origin to Function App CORS. The Bicep analyticsOrigin parameter defaults to https://sw-analytics.netlify.app. Include NOTIFICATIONS_ANALYTICS_KEY in deliverySettings when deploying app settings through Bicep, so a later deployment does not remove it. The public website origin remains allowed too.

The endpoint returns safe recipient/contact fields, current subscription states and preferences, message states, actual sending/attempt timestamps, retry counts, cancellation reasons, safe error codes, wake-versus-delivery failure stage, preparation duration, scheduler heartbeat and evaluation reasons. It never returns link tokens, management credentials, provider IDs, push endpoints/keys or precise coordinates.

Delivery and evaluation aggregates cover retained activity over the last 14 days. Detailed lists are capped at the newest 500 records each, with limits and full totals returned explicitly. Current subscription totals are separate from historical event metrics. Completed evaluation jobs are never counted as sent messages. Legacy records without an actual sending timestamp are reported as unknown, not assigned their creation time.

Email and push acceptance are not proof of inbox delivery or opening. No tracking pixels or click tracking are added. Recipient snapshots share the existing job retention period; removed subscriptions are not kept alive for analytics.

## Review and operations

Set NOTIFICATIONS_API_URL and NOTIFICATIONS_ADMIN_KEY in your shell, then:

```powershell
node scripts/review.cjs
```

Protected GET /admin/evaluations shows the 200 newest decisions and reasons. GET /admin/jobs shows state, attempts and sanitized errors, without email addresses, endpoints, tokens or credentials.

Pending jobs are stored before enqueue. ETag claims prevent concurrent processing. Timer repair re-enqueues jobs after a crash, queue outage or retry delay. Send-time checks cancel advice if preferences changed, the subscription was paused/removed, weather became stale or delivery expired. Retries back off and stop after six claims or a permanent provider error. A provider-accepted message cannot be recalled. Push has no provider idempotency API: a crash after acceptance can produce a repeat, although the stable notification tag replaces the existing displayed notification. Do not claim exactly-once external delivery.

Monitor timer failures, failed jobs, queue age and notification-jobs-poison in Azure. Alert on any failed delivery jobs or timer inactivity >20 minutes. Application Insights avoids payload logging; the template limits daily log ingestion to 0.1 GB (this is a log cap, not a spending cap). Review provider bounce/complaint rates. For larger populations replace full table scans with partitions indexed by due time before exceeding the Function timeout.

Emergency stop: set NOTIFICATION_MODE=dry-run. This stops evening deliveries but leaves confirmation/settings email available. To disable those too, remove MAIL_SERVICE_KEY from the worker. Do not delete subscriptions to pause delivery.

Retention: pending confirmation 7 days; unsubscribed/expired subscriptions 30 days; bounce/complaint suppression 90 days; decisions/completed jobs 14 days; report links 7 days; weather cache records 1 day. Daily cleanup performs deletion. Active subscriptions remain until unsubscribed or delivery invalidates them. Device management credentials expire after 365 days; email management after 90 days. Requesting a new email settings link replaces the previous browser credential.

## Staging acceptance before live delivery

- Use only your own test address/device. Verify email confirmation, replay rejection, settings recovery on a second browser, pause/resume and unsubscribe.
- Verify an actual production PWA push on desktop and iOS/Android as applicable, including click-through to the saved report and revoked permission handling.
- Verify the Free API wakes through authenticated /internal/notification-mail/ready, then verify worker-to-API mail delivery. Ensure the relay key is absent from frontend assets.
- Compare recorded decisions with the evening planner using the saved snapshot, especially DST and a browser in another time zone.
- Verify SMTP failure handling and operator suppression and GET-safe / POST unsubscribe, and intentionally exercise a provider failure/retry.
- Verify Azure triggers, secrets, exact-origin CORS, failed-job monitoring and retention. The local test suite does not prove cloud deployment or real-provider delivery.

References: [Flex Consumption](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan), [Functions infrastructure](https://learn.microsoft.com/en-us/azure/azure-functions/functions-infrastructure-as-code), [Open-Meteo hourly definitions](https://open-meteo.com/en/docs), [Astronomy Engine](https://github.com/cosinekitty/astronomy), [App Service plans](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans), [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058).

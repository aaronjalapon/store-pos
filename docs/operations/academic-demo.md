# Free academic demo: Vercel, Render, Supabase

This guide deploys the existing Next.js website and NestJS API with one fictional store. It targets roughly five simultaneous users and a few weeks of grading. No custom domain, paid plan, paid add-on, or real payment processing is required. QR transactions are fictional ledger entries; never upload a real payment QR for this demo.

## Hosting settings

| Service | Plan | Settings |
| --- | --- | --- |
| Vercel website | Hobby | Root directory `apps/web`; Node 22.x; include files outside the root directory; use checked-in `apps/web/vercel.json` |
| Render API | Free instance in a free workspace | Repository root; `Dockerfile.api`; Singapore; port 4000; `/health/live`; settings in `render.yaml` |
| Supabase | Free | Dedicated demo project in Singapore; PostgreSQL session pooler; private S3-compatible storage bucket |

Use one stable production `vercel.app` address for grading. Do not point preview deployments at the demo API or give previews production credentials. Keep production deployments publicly accessible at Vercel's platform layer; the app itself still requires login.

Provider references (checked October 4, 2026): [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel monorepos](https://vercel.com/docs/monorepos/monorepo-faq), [Render Free](https://render.com/docs/free), [Render Blueprint format](https://render.com/docs/blueprint-spec), [Supabase pricing](https://supabase.com/pricing).

## 1. Prepare Supabase

1. Create a dedicated **Free** project and keep its database password in your password manager. Do not reuse a production store database.
2. Disable the unused Data API in the project's API settings. The app connects through PostgreSQL and its own API, not Supabase's generated REST endpoints. Supabase Storage remains necessary; do not disable it.
3. Copy the **Session pooler** connection string, on port **5432**, from Connect. Use this for `DATABASE_URL`, with TLS enabled (`sslmode=verify-full` and the provider CA if required). URL-encode special characters in the database password. Never disable certificate verification to make a connection work. Do not use the transaction pooler on port 6543: startup migrations use session-level advisory locks. [Connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres).
4. Create a **private** bucket named `gma-pos-demo`. Set its per-file limit to 50 MB. Product images, QR images, and encrypted backups share this bucket in separate prefixes.
5. In Storage's S3 settings, create server-side S3 credentials and copy the exact endpoint, region, access key, and secret into Render. Use `S3_FORCE_PATH_STYLE=true`. Do not use the public anon/publishable key as S3 credentials and never put S3 secrets in Vercel's public variables. [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication), [supported operations](https://supabase.com/docs/guides/storage/s3/compatibility).

## 2. Configure and deploy the API

Use the repository's `render.yaml` Blueprint. Select only the Free plan and do not attach a payment method. The Blueprint deliberately provisions no Render database or disk. Choose the branch containing this deployment change.

Provide the prompted variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session-pooler URL with verified TLS |
| `NODE_EXTRA_CA_CERTS` | `/app/certs/supabase-prod-ca-2021.crt` (set by the Blueprint) |
| `CORS_ORIGIN` | Exact final website origin, e.g. `https://YOUR-PROJECT.vercel.app`; no slash or path |
| `SUPERADMIN_EMAIL` | Your private administrator login |
| `SUPERADMIN_PASSWORD` | Unique random password, at least 16 characters; no placeholder text |
| `BACKUP_ENCRYPTION_KEYS_JSON` | `{"demo-v1":"BASE64_ENCODED_32_RANDOM_BYTES"}` |
| `S3_ENDPOINT`, `S3_REGION` | Exact values from Supabase Storage |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Private S3 credentials |

Render generates `JWT_SECRET` and `METRICS_TOKEN`. The Blueprint sets `BACKUP_MAX_BYTES=41943040` (40 MiB), the active backup key ID to `demo-v1`, and the bucket name to `gma-pos-demo`. Save a secure copy of the backup key: losing it makes old backups unreadable. Secrets belong in host settings, never in committed files, images, screenshots, or chat.

The API runs migrations automatically at startup, then ensures the configured superadmin exists. `/health/live` is Render's process check; explicitly verify `/health/ready` returns 200 before publishing the link. The readiness check also confirms PostgreSQL migrations and storage access. Keep one API instance.

`TRUST_PROXY_HOPS=1` trusts Render's immediate ingress. Verify rate limiting and client IP attribution through both the Vercel URL and the direct API URL; do not blindly increase this value because the public API has a shorter proxy path. A shared proxy IP can aggregate the small demo's login limits; avoid repeated failed logins.

## 3. Deploy the website

The Docker image includes the public Supabase Root 2021 CA downloaded from the project's Database Settings certificate link. `NODE_EXTRA_CA_CERTS` adds it to Node's trust store while `sslmode=verify-full` still validates the certificate and hostname. Its SHA-256 fingerprint is `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`; it expires April 26, 2031. Follow Supabase's certificate rotation guidance if that CA changes.

Import the repository into a Vercel **Hobby** project. Choose root directory `apps/web`, enable **Include source files outside of the Root Directory**, and select Node 22.x. The checked-in configuration installs from the workspace root and builds the shared packages before Next.js.

Set these two **Production** environment variables before building:

```dotenv
NEXT_PUBLIC_API_URL=https://YOUR-PROJECT.vercel.app
API_PROXY_TARGET=https://YOUR-API.onrender.com
```

The first address is the website, the second is Render. Both must be origins without a path. `API_PROXY_TARGET` is server-only; it is not a secret, but must never point back at the website. Update Render's `CORS_ORIGIN` to exactly match. These values are used at build time, so redeploy Vercel after changing them.

Next.js forwards `/v1/*` to Render under the website origin. This preserves the existing `HttpOnly`, `Secure`, `SameSite=Lax` refresh cookie and its `/v1/auth` path. The proxy forwards query strings, HTTP methods, binary request bodies, authorization headers, cookies, and `Set-Cookie`. API responses use `private, no-store` and CDN no-store headers; the service worker already excludes `/v1/*`. Product images continue to use the app's explicit offline cache.

Do not add database, S3, JWT, backup, or administrator secrets to the website project. Local development still defaults to `http://localhost:4000`; the proxy is optional. For a local proxy check, set `API_PROXY_TARGET=http://127.0.0.1:4400` and build with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3400`.

## 4. Create fictional demo data

Use Node from `.nvmrc`. Copy `.env.demo.example` to `.env.demo` and privately enter the deployed website origin and the Render superadmin credentials. Then run from the repository root:

```sh
node --env-file=.env.demo scripts/demo-setup.mjs
```

Alternatively, export those variables and run `npm run demo:setup`. Setup is never run on server startup or deployment.

The script creates **Bayanihan Academic Demo**, a generated owner login and cashier PIN, 20 fictional products, a sample customer, and one cash, utang, and QR sale. It approves only its own setup device through the existing administrator API. It saves demo access details in `.demo/demo-access.txt`, with file permissions restricted to the local user. Administrator credentials and session tokens are not saved or printed.

Keep `.demo/setup-state.json`: it saves each exact command before transmission so rerunning after interruption reuses the same idempotency key. Run only one setup process at a time. Do not delete the journal to retry, and do not rerun an old journal after the app's 30-day command-retention window. A conflict stops setup for inspection. `.demo/` is excluded from Git and Docker builds. Never share the setup journal; share demo access details privately with graders.

New browsers need enrollment approval. Sign in to the website as the private superadmin in your own browser. Attempt the demo owner login on the presentation or instructor's browser, approve the pending device from the administrator console, then retry owner login. Sign in as owner on each device once to associate it with the store and reveal the Cashier tab. The owner can approve later browsers. Do this before handing out the link; unapproved browsers cannot independently log in. Do not give graders the superadmin account.

## 5. Acceptance and presentation checklist

- Run `npm test`, `npm run typecheck`, and `npm run build` with Node 22.
- Check `/health/ready` directly on Render, then `/v1/auth/setup-status` through Vercel. Responses must not be served from a CDN cache.
- Test owner/cashier login, browser enrollment, logout, reload, and refresh-token rotation on desktop and a phone. Inspect cookies without recording their values; confirm `Secure`, `HttpOnly`, and `SameSite=Lax` in the hosted environment.
- Upload/read/delete a product image and fictional QR image. Confirm they remain private, survive redeployment, and are copied/deleted successfully by the storage reconciliation job.
- On an enrolled, fully synchronized browser, record a sale offline and reconnect. Verify exactly one sale and correct stock changes. Repeat after reloading offline; pending work must remain on the device.
- Trigger an encrypted backup manually; leave the app open until its status becomes complete. The object worker runs every minute while the API is awake.
- Restart/redeploy the API and confirm the sample store, transactions, and images remain. Render's filesystem is ephemeral; all durable data belongs in Supabase.
- Leave the API idle for at least 15 minutes, then open a fresh browser visit. Verify connection feedback, eventual login, and the retry button when unavailable for two minutes. Only the initial setup read is automatically retried.
- Check all three usage dashboards. Supabase Free provides 500 MB database space and 1 GB file storage; stored backups and staging objects count toward storage. Review usage before grading and retain only needed backups according to the existing retention procedure.

Render may sleep after 15 minutes and take around a minute to wake. Supabase may pause after a week of inactivity; check and resume the project before grading. Free quotas can suspend service. Without a Render payment method, quota exhaustion suspends services/builds rather than billing overages. Do not upgrade or add cards to recover a free demo; reduce usage or wait for quota renewal.

Overnight backup and retention jobs are best-effort while the API sleeps. Take a manual application backup and a separate database export before the presentation. Application backups are store-level and require existing users/devices for restore; they do not replace a database backup. Using PostgreSQL client tools matching the server major version and a private `DATABASE_URL`, a demo export can be created with:

```sh
umask 077
mkdir -p .demo
pg_dump --dbname="$DATABASE_URL" --format=custom --schema=public --file=.demo/pre-demo.dump
```

This exports the application's public schema, not Supabase-managed infrastructure or stored files. Retain the encrypted application backup, its keys, and storage objects separately. Check the dump with `pg_restore --list .demo/pre-demo.dump`; test a restore into a separate disposable PostgreSQL database before relying on it. Never restore over the live demo without an explicit recovery decision. Keep a working local demo as the presentation fallback.

Before presenting: check Supabase is active, open the website, log in, sync, check images, and create the backup. After grading: export anything needed, remove shared demo access, and delete only the dedicated demo resources you no longer need.

## Deployment record

### Repeat the local deployment acceptance test

Use a disposable audit stack only. The test creates fictional data and stops the API and website processes it starts. It checks resumable seeding, cookie forwarding/rotation, JSON and binary requests, no-cache headers, image deletion, encrypted backup creation, and restart persistence. It does not verify the hosted providers or production HTTPS cookies.

```sh
docker compose -p store-pos-demo-test -f docker-compose.audit.yml up -d --no-build --wait
API_PROXY_TARGET=http://127.0.0.1:4400 NEXT_PUBLIC_API_URL=http://127.0.0.1:3400 npm run build
AUDIT_DATABASE_URL=postgresql://pos_audit:audit-only@127.0.0.1:55433/gma_pos_audit npm run test:demo
docker compose -p store-pos-demo-test -f docker-compose.audit.yml down --volumes
```

Build the MinIO image first with `docker compose -p store-pos-demo-test -f docker-compose.audit.yml build` if it is not already available. Ports 3400, 4400, 55433, and 59000 must be free. Run against a fresh audit stack because each test run uses a new private setup journal.

### Hosted rollout status

Fill these in after the hosted checks pass; configuration files alone do not constitute a deployment.

- Website URL: pending
- Render API URL: pending
- Supabase project reference: `xoqpymjnsrgusrndhlqt` (`store-pos-academic-demo`, Singapore, Free)
- Deployed commit: pending
- Hosted acceptance date/result: pending
- Private credential location: `.demo/demo-access.txt`
- Pre-demo database export: `.demo/pre-demo.dump`

Provisioning checkpoint (October 5, 2026): the dedicated Supabase project and private `gma-pos-demo` bucket exist. The Data API is disabled. Live S3 bucket access, upload, download, copy, and deletion passed; disposable verification objects were removed. The session pooler host is `aws-0-ap-southeast-1.pooler.supabase.com`, port `5432`, database `postgres`, user `postgres.xoqpymjnsrgusrndhlqt`. Render and Vercel deployment and hosted application checks remain pending. The tested hosting implementation is on branch `codex/academic-demo-hosting` (commit `78711cb`).

Private provisioning files under `.demo/` contain the storage credentials and generated application secrets. They are excluded from Git and Docker; keep them private and preserve the backup encryption key. `.demo/database-password.txt` is the local handoff file for the database password chosen during project creation. Never copy these files into a public deployment record.

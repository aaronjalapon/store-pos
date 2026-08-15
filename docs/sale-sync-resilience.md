# Sale sync resilience

## Non-negotiable invariant

After checkout returns “Sale saved,” the local sale and its synchronization command exist in the same IndexedDB transaction. The command stays on the device until the server durably acknowledges it. Refreshes, sign-out, failed authentication checks, network failures, and server conflicts do not delete it.

## Implemented foundation

- Local POS writes and mutation-queue insertion commit atomically.
- Sales send permanent `saleId`, `transactionNumber`, and `occurredAt` values created by the device.
- PostgreSQL claims `(store_id, device_id, client_command_id)` in the same transaction that applies the command and records its result. Replays return the recorded result.
- Sale inventory rows are locked and validated against current stock instead of requiring an exact stale product version.
- One client sync coordinator flushes core commands before pulling a snapshot, prevents snapshot replacement while commands exist, and processes images afterward.
- Queue entries move through `pending`, `syncing`, and `needs_attention`; conflicts remain durable and visible.
- Ordinary sign-out clears credentials only. An owner-only, explicitly confirmed operation removes device-local data.
- The header reports synced, offline/pending sales, syncing progress, or needs-attention state from IndexedDB rather than relying only on `navigator.onLine`.

## Follow-up milestones

1. **Conflict operations:** add an owner transaction-review view with retry, reconciliation details, and a strongly confirmed resolution action. Never offer an automatic completed-sale discard.
2. **Retry policy:** persist next-attempt timestamps, use capped exponential backoff with jitter, and distinguish authentication, validation, rate-limit, and availability failures.
3. **Operational visibility:** persist last successful sync time, show device/storage-persistence warnings, and add server metrics for duplicate command replays, queue age, and unresolved sales.
4. **End-to-end resilience:** automate response-loss replay, two-device concurrent inventory, refresh during checkout, logout with pending sales, server outage, expired session, upgrade, and long-offline recovery scenarios against real IndexedDB and PostgreSQL.

## Deployment order

Run database migration `004_processed_commands.sql` before deploying clients that rely on command replay. Deploy the API next, then the web client. Existing queued non-sale commands remain compatible through the IndexedDB version-5 upgrade; the complete-sale wire contract must be deployed API-first because it now requires the permanent sale identity fields.

# GMA Store POS

Mobile-first, offline-first sari-sari store POS built with Next.js, TypeScript, Dexie, NestJS, Fastify, and PostgreSQL.

## Local development

1. Copy `.env.example` to `.env` and change the JWT secret and superadmin credentials.
2. Start PostgreSQL and MinIO with `docker compose up -d`.
3. Install dependencies with `npm install`.
4. Apply the database migration with `npm run db:migrate`.
5. Start the PWA and API with `npm run dev`.

The PWA opens at `http://localhost:3000` and the API at `http://localhost:4000`.

The API creates or updates the configured superadmin account on startup when `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` are set. Sign in through the Owner / Admin / Superadmin tab to create stores and assign owner/admin access.

## Offline model

The browser database is the working source of truth. Checkout, inventory, utang, expenses, and reports never wait for the API. Cloud backups are encrypted in the browser and uploaded only when connectivity is available.

Amounts are stored as integer centavos. Inventory is stored in the product's smallest sellable unit.

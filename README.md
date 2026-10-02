# Store POS

Mobile-first, offline-first sari-sari store POS built with Next.js, TypeScript, Dexie, NestJS, Express, PostgreSQL, and MinIO.

#Course:
CCE106L Applications Development and Emerging Technologies

## Local development

1. Install and select the Node.js version in `.nvmrc` with `nvm install && nvm use`.
2. Copy `.env.example` to `.env` and change the JWT secret and superadmin credentials.
3. Start PostgreSQL and MinIO with `docker compose up -d --build`.
4. Install dependencies with `npm install`.
5. Apply the database migration with `npm run db:migrate`.
6. Start the PWA and API with `npm run dev`.

The PWA opens at `http://localhost:3000` and the API at `http://localhost:4000`.

The API creates or updates the configured superadmin account on startup when `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` are set. Sign in through the Owner / Admin / Superadmin tab to create stores and assign owner/admin access.

## Offline model

The browser database is the working source of truth. Checkout, inventory, utang, expenses, and reports never wait for the API. Cloud backups are encrypted in the browser and uploaded only when connectivity is available.

Amounts are stored as integer centavos. Inventory is stored in the product's smallest sellable unit.

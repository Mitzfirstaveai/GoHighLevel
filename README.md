# Gujarati Samaj of Arkansas — Member App

A simple, mobile-friendly web app for the samaj's members and committee:

**Members can**
- Create an account and keep their profile up to date (contact info, address, native place/vatan, occupation)
- List family members in their household
- Browse events and RSVP with the number of people coming
- Pay event fees and membership dues online (card via Stripe)
- Get a **QR ticket** for each event (in *My tickets*, one tap away on the phone's bottom bar)

**Admins can**
- See and edit every member's full profile and family list; search and export the directory to CSV
- Create events (date, location, per-person fee, capacity, max people per RSVP, RSVP deadline, members-only)
- See who is attending and **how many people** (confirmed, awaiting payment, checked in) and export the guest list
- **Scan QR codes** at the door with any phone: the scan shows the member's name and how many guests are
  registered on that code; the admin picks how many actually arrived and checks them in.
  **A QR code can only be used once** — a second scan shows "Already used", when, and by whom.
- Collect cash/check at the door, or record any offline payment (dues, donations)
- Manage membership plans (annual family, individual, life, …) and view all payments

## Run it locally

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env   # then edit
npm run seed           # optional: demo data (admin@example.com / password123)
npm start              # http://localhost:3000
```

Without Stripe keys the app runs in **demo payment mode** (a "simulate payment" button; never enabled in
production unless `ALLOW_DEMO_PAYMENTS=true`).

## Going live

1. Host it anywhere that runs Node (Render, Railway, Fly.io, a small VPS). Mount a persistent disk for the
   SQLite database file (`DATABASE_FILE`) and back it up.
2. Set `NODE_ENV=production`, `BASE_URL` (your public https URL — it's printed in QR codes), a long random
   `SESSION_SECRET`, `TZ=America/Chicago`, and `ADMIN_EMAIL`/`ADMIN_PASSWORD` for the first admin.
3. Payments: create a Stripe account, set `STRIPE_SECRET_KEY`, and add a webhook endpoint
   `https://YOUR-SITE/pay/webhook` for `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Sign in as the admin, add membership plans under **Admin → Dues plans**, and promote other committee members
   to admin from their member page.

If `ADMIN_EMAIL` isn't set, the first account registered becomes the administrator.

## Development

```bash
npm test        # end-to-end tests (RSVP, payments, one-time QR check-in, capacity, dues, CSV, CSRF)
npm run dev     # restart on file changes
```

Stack: Express 5 + EJS server-rendered pages, SQLite (Node's built-in `node:sqlite`), Stripe Checkout,
`qrcode` for tickets and `html5-qrcode` for the in-browser scanner.

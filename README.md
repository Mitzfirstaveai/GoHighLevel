# Gujarati Samaj of Arkansas — Member App

A simple, mobile-friendly web app for the samaj's members and committee:

Organization details (About, Committee, Sponsors, Contact) live in `src/content.js`.

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
- Manage membership levels (Senior Citizen, Individual, Married Couple, Family, Family with Parents) — each level
  decides which family members can be on the profile and how many people the member can bring to events

## Put the demo online (free, about 10 minutes)

1. Create a free account at [render.com](https://render.com) and sign in with GitHub.
2. Click **New → Blueprint**, choose the `GoHighLevel` repository and this branch, then **Apply**.
   Render reads `render.yaml` and sets everything up (demo mode, demo payments, Central time).
3. After the build finishes you get a link like `https://gsa-members.onrender.com` — open it on your phone or
   share it with the committee.

Notes for the free plan: the site goes to sleep after ~15 minutes without visitors (the first visit then takes
about a minute to wake up), and every restart reloads fresh demo data. Open the link a minute before presenting.

## Demo walkthrough

On the sign-in page, tap **Member (Family level)** or **Admin (committee)** — no typing needed.
Other sample members use the password `demo1234`.

**As a member (best shown on a phone)**
1. *Home*: quick tiles, membership status, upcoming events.
2. *My tickets*: the Navratri Garba #1 QR ticket for 4 people.
3. *Events → Diwali Dinner & Cultural Program*: RSVP for 4 → pay $60 (simulated) → QR ticket appears.
4. Change the RSVP from 4 to 2 → a new QR code is issued and the old one stops working (fees are non-refundable).
5. *Profile*: try adding a "Father" — the Family level doesn't cover parents, so the app suggests
   upgrading to Family with Parents.
6. *Dues*: see the five levels, "Upgrade — pay $55 difference", and renewal for next year.
7. *More*: member directory (with privacy settings), News, About Us, Committee, Sponsors and Contact.

**As an admin**
1. *Overview*: members, paid memberships, money collected, upcoming events.
2. *Events → Navratri Garba #1*: headcount (confirmed / awaiting payment / checked in) and the guest list; download CSV.
3. *Check-in*: scan the member's QR with the phone camera (or click **Check in** on the guest list) → choose how many
   arrived → **Check in**. Scan the same code again → **Already used**. Scan the old (replaced) code → **Old QR code — replaced**.
4. *Members*: search the directory, open a profile, see family, payments and RSVPs; record a cash/check payment.
5. *Membership levels*: the five GSA levels and who each covers.
6. *News*: post an announcement — it appears on every member's home page.
7. *Overview → Reset demo data* before the next presentation.

## Adding Stripe later

No code changes are needed. When you're ready to take real card payments:
1. Create a Stripe account and copy the **secret key** (Developers → API keys).
2. In Stripe, add a webhook endpoint `https://YOUR-SITE/pay/webhook` for the events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`, and copy its **signing secret**.
3. In Render → your service → **Environment**, add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and set
   `ALLOW_DEMO_PAYMENTS` to `false`. Render restarts the app and the "Simulate payment" button becomes a real card checkout.

Tip: Stripe's *test mode* keys (`sk_test_…`) let you rehearse with test card `4242 4242 4242 4242` before going live.

## Run it locally

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env   # then edit
npm run seed           # optional: demo data (admin@example.com or member@example.com / demo1234)
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

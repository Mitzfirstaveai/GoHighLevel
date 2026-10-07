# Gujarati Samaj of Arkansas — Member App

A simple, mobile-friendly web app for the samaj's members and committee:

Organization details (About, Committee, Sponsors, Contact) live in `src/content.js`.

**Members can**
- Keep their profile and family up to date; family members allowed depend on their membership level
- Pay or renew membership dues (Senior Citizen, Individual, Married Couple, Family, Family with Parents) — upgrades pay the difference
- Browse events as a list or a monthly calendar, add them to their phone calendar, and RSVP for their family
  plus **guests at the guest price**; answer registration questions; use **coupon codes** and **early-bird** prices
- Join a **waitlist** when an event is full — they're moved in automatically when seats free up
- Show a one-time **QR ticket** at the door (works offline once opened)
- **Donate** to the general fund or a campaign (e.g. Facility Fund) and get a **tax receipt**
- Get a printable receipt for every payment; search the **member directory** (with privacy settings); read **News**
- **Install the app** on their phone's home screen (iPhone and Android) — no app store needed

**Admins can**
- Keep a **contact database** of members *and* non-members (donors, sponsors, vendors, volunteers) — with tags,
  filters (membership status, level, tag, city, login) and CSV export
- **Import contacts from a spreadsheet** — e.g. a WildApricot export — including membership levels and renewal dates
- Create events with photos, member / guest / early-bird prices, capacity, waitlists, coupon codes and custom questions
- See who's coming and how many (family vs. guests), answers to questions, and export the guest list
- **Scan QR codes** at the door; each code works once, and changed or old codes are flagged
- Record cash/check payments and donations; run **donation campaigns** with a goal thermometer; see the **donor list**
- View **financial reports** by month and category and **export to QuickBooks**
- Watch **trends**: new members per month, active members by level, event registrations vs. arrivals, renewals due
- Edit the website's About, Committee, Sponsors and Contact pages, and post News with photos — no code needed

Organization details default to `src/content.js` and can then be edited in **Admin → Website**.

## Where the data lives

Everything — members, contacts, events, payments, photos — is stored in one database on the hosting server
(Render), reachable from any phone or computer. On the free demo plan that storage is temporary. For real use,
pick a paid plan with a **persistent disk** (in `render.yaml`, uncomment the `disk:` section and set `DATABASE_FILE`
to a path on it); Render snapshots the disk daily so you can restore from a backup.

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
1. *Home*: quick tiles, latest news, and the "Get the GSA app" card (install it to the home screen).
2. *Tickets*: the Navratri Garba #1 QR ticket for 4 people.
3. *Events → Diwali Dinner & Cultural Program*: choose 3 family + 2 guests, pick a dietary preference, enter coupon
   `DIWALI10` → the estimate updates → pay (simulated) → QR ticket. Early-bird member price applies.
4. *Events → Garba Dance Workshop for Kids*: it's full — **Join waitlist**. Try the **Calendar** view and **Add to my calendar**.
5. Change an RSVP from 4 to 2 → a new QR code is issued and the old one stops working.
6. *Profile*: try adding a "Father" — the Family level doesn't cover parents, so the app suggests an upgrade.
7. *Dues*: the five levels, "Upgrade — pay $55 difference", renewal for next year.
8. *More → My payments → Make a donation* → give to the Facility Fund → tax receipt (Print / Save as PDF).

**As an admin**
1. *Overview*: totals and upcoming events. *Trends*: membership and attendance charts.
2. *Events → Diwali*: headcount incl. guests, answers to questions, coupon usage; download CSV.
3. *Check-in*: scan a member's QR (or click **Check in**) → choose how many arrived. Scan again → **Already used**.
4. *Contacts*: filter by Sponsor / Donor / "No login yet"; add a contact without email; **Import from spreadsheet**.
5. *Donations*: Facility Fund thermometer, donor list, start a new fund. *Reports*: income by month, **Export for QuickBooks**.
6. *Website*: change the motto or committee list and open the public pages. *News*: post an announcement with a photo.
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
npm test        # end-to-end tests (RSVPs, guests, waitlist, coupons, QR check-in, dues, contacts/import, donations, reports)
npm run dev     # restart on file changes
```

Stack: Express 5 + EJS server-rendered pages, SQLite (Node's built-in `node:sqlite`), Stripe Checkout,
`qrcode` for tickets and `html5-qrcode` for the in-browser scanner.

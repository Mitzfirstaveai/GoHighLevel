# Gujarati Samaj of Arkansas — Member App

A simple, mobile-friendly web app for the samaj's members and committee:

Organization details (About, Committee, Sponsors, Contact) live in `src/content.js`.

**Easy for every member**
- **ગુજરાતી / English** button on every page (also before signing in). The choice is saved to the member's profile,
  so the app opens in their language on any phone. Membership levels, family relationships, About Us, mission and
  vision, event names and descriptions, and news can all be shown in Gujarati.
- **Text size button (A+)** with Normal / Large / Extra large, also saved per member. Larger default text, darker grey
  text for contrast, and large buttons and tap targets throughout — designed with older members in mind.
- **Gujarat & India news** (News → Gujarat & India news, and the top headlines on Home): headlines and a short
  "quick read" from Indian news websites the committee picks, refreshed every hour, with **Read the full story**
  opening the newspaper's site (full articles are never copied). Admin → News → Gujarat & India news manages the
  sources (**Check now** shows whether each feed works), hides single stories, and edits the **filter words** that keep
  out US politics, elections and political parties (important for a 501(c)(3)) and distressing stories. The four
  suggested sources are a starting point; check them on the live site and add Gujarati papers' RSS feeds.
  `NEWS_REFRESH_MINUTES` changes the refresh interval (0 turns it off).
- **Event reminders**: members get notifications on the phones, tablets and computers where they turned reminders on
  (Profile → Event reminders, or on a ticket) — even when the app is closed or they are signed out. Each event sets its
  own schedule (Edit event → Phone reminders): the morning of (9 AM by default, never later than two hours before the
  start), the day before and/or a week before, each at a chosen time, plus a one-time "RSVP now" invitation (every event
  has one: a week before at 10 AM unless the committee picks a time) to members whose family has no ticket. Reminders say the time and place and anything still to pay at the door, and
  open the QR ticket. On iPhone and iPad this needs the app added to the
  Home Screen (iOS 16.4 or later). Opening the app that day also shows a pop-up with the ticket. Push keys are made
  automatically (or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`); `REMINDER_MINUTES` sets how often reminders are
  checked (default 5, 0 turns them off). The server must keep running for reminders to go out on time.
- **Sponsors & vendors** (Admin → Contacts → Sponsors & vendors tab): businesses and organizations are kept apart
  from members, with organization name, contact person, website, sponsorship level and year. They don't sign in and
  aren't counted in member numbers, reports, the directory or celebrations. Sponsorship payments get tax receipts in
  the organization's name. Sponsors marked **Show on the website** make up the public Sponsors page, by level.
- **Celebrations**: members choose to share their birthday, wedding anniversary and family members' birthdays
  (Profile → Celebrations). Members see this week's on Home and News; only the month and day, never a year or age.
- **Light/dark button** (moon/sun) next to A+ for members, admins, door volunteers and visitors. Until someone picks,
  the app follows their phone's own light/dark setting; their choice is then saved (on the profile when signed in,
  on the device otherwise). *More → Language, text size and colors* also offers "Same as my phone".
- Gujarati dictionary: `src/locales/gu.js` (please have a native speaker on the committee review it). Gujarati event
  and news text is entered by admins in the optional "Gujarati version" fields; the Gujarati About page is edited in
  **Admin → Website**. The admin area itself stays in English.

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

## Passwords

- **Rules** (checked at sign-up, family invites and *Profile → Change password*, with a checklist that ticks itself
  while typing): at least **8 characters**, for members, committee members and door volunteers alike;
  an **uppercase letter, a lowercase letter, a number and a symbol**; not a common or easily guessed password
  (e.g. `Garba@2026`, `Password#1`, `Qwerty!12345`); not the person's own name or email.
- **Older or weaker passwords** (chosen before these rules) work once more: at that sign-in the person must choose a
  new one before anything else.
- **Temporary passwords** a committee member hands out (*Reset password*, or a new contact's first login) are random
  16-character ones, and must be replaced at the first sign-in.
- **Storage:** passwords are never stored or shown. The app keeps only a **bcrypt hash** (one-way, salted, work
  factor 12), so no one — committee members included — can read a password back, and a copy of the database
  doesn't reveal them. Repeated wrong passwords pause sign-in for 15 minutes.
- The demo's sample accounts keep the shared password `demo1234`.

## Put the demo online (free, about 10 minutes)

1. Create a free account at [render.com](https://render.com) and sign in with GitHub.
2. Click **New → Blueprint**, choose the `GoHighLevel` repository and this branch, then **Apply**.
   Render reads `render.yaml` and sets everything up (demo mode, demo payments, Central time).
3. After the build finishes you get a link like `https://gsa-members.onrender.com` — open it on your phone or
   share it with the committee.

Notes for the free plan: the site goes to sleep after ~15 minutes without visitors (the first visit then takes
about a minute to wake up), and every restart reloads fresh demo data. Open the link a minute before presenting.

## Demo walkthrough

On the sign-in page, tap **Member (Family level)** — no typing needed. The **Admin (committee)** and **Door volunteer**
buttons are on **Committee & volunteer sign-in** (link under the sign-in form and at the bottom of every page).
Other sample members use the password `demo1234`.

**As a member (best shown on a phone)**
1. Tap **ગુજરાતી** at the top — the whole member app switches to Gujarati. Tap **A+** to make the text bigger.
   Tap the moon/sun button to switch between dark and light colors. (Also under *More → Language, text size and colors*.)
2. *Home*: quick tiles, latest news, and the "Get the GSA app" card (install it to the home screen). Closing it hides
   it until the app is next opened; *More* always has it.
3. *Tickets*: the Navratri Garba #1 QR ticket for Priya, Diya and Aarav — the names are on the ticket (and shown at the
   door). Tap **Change who's coming** to add or remove someone; a new QR code replaces the old one.
4. *Events → Diwali Dinner & Cultural Program*: tick 3 family members + 2 guests, pick a dietary preference, enter coupon
   `DIWALI10` → the estimate updates → pay (simulated) → QR ticket. Early-bird member price applies.
5. *Events → Garba Dance Workshop for Kids*: it's full — **Join waitlist**. Try the **Calendar** view and **Add to my calendar**.
6. When registering, tick who's coming by name — only family on the profile and covered by the membership level can be
   ticked, and nobody can be on two tickets for the same event.
7. *Family login*: sign out and tap **Spouse (family login)** (Amit, Priya's husband). He's covered by Priya's
   membership; on Navratri Garba #1 the kids show "Already registered on Priya Shah's ticket", so he can only add himself,
   and he gets his own QR ticket. Members give family their own login under *Profile → Family members → Create invite
   link*, then send it by **WhatsApp**, text message or copy/paste. The private link works once and expires in 14 days;
   the family member opens it and creates their login (or, if they already have one, signs in and joins).
8. *Profile*: try adding a "Father" — the Family level doesn't cover parents, so the app suggests an upgrade.
9. *Dues*: the five levels, "Upgrade — pay $55 difference", renewal for next year.
10. *Photos* (in the top menu, or *More → Photos* on a phone): albums grouped by type of event — Navratri & Garba,
   Diwali, Festivals, Sports… Tap an album, then a photo; use the big **Next / Previous** buttons (or swipe).
   The demo albums use illustrated stand-ins; upload real event photos to replace them.
11. *More → My payments → Make a donation* → give to the Facility Fund → tax receipt (Print / Save as PDF).

**As an admin** (open **Committee & volunteer sign-in** and tap **Admin (committee)**)

The admin area is only for admin work: there is no profile, dues or tickets in it, and **Sign out** returns to the
committee sign-in. A committee member who is also a member uses the normal member sign-in for their own membership and
tickets; that member app has no Admin link and no access to other families' tickets or receipts.

1. *Overview*: totals and upcoming events. *Trends*: membership and attendance charts.
2. *Events → Diwali*: headcount incl. guests, answers to questions, coupon usage; download CSV.
3. *Check-in*: scan a member's QR (or click **Check in**) → choose how many arrived. Scan again → **Already used**.
   No phone? Search by name, a family member's name or phone number. The list at the bottom shows the door volunteers.
4. *Contacts*: filter by Sponsor / Donor / "No login yet"; add a contact without email; **Import from spreadsheet**.
5. *Donations*: Facility Fund thermometer, donor list, start a new fund. *Reports*: income by month, **Export for QuickBooks**.
6. *Photos*: **New album** → pick the event and type → **Upload photos** (up to 20 at a time, straight from a phone).
   Photos are resized, location data from phones is removed, and only signed-in members can see them. Set the cover
   photo, add captions, delete photos.
7. *Website*: change the motto or committee list and open the public pages. *News*: post an announcement with a photo.
   Events announce themselves in **GSA announcements** on members' Home: "Coming up" from the day the RSVP invitation
   goes out, then "Tomorrow", "Today" and "Happening now", pointing ticket holders to their QR ticket and everyone else
   to RSVP. On each event's *Edit* page (**GSA announcements**) add your own message (English and Gujarati) or switch
   it off — e.g. Navratri Garba #1 in the demo.
8. *Overview → Reset demo data* before the next presentation.

**Shared door login** (the demo's **Door team (shared login)** button: username `door`, password `demo1234`)
- On the real site the committee turns it on under *Admin → Check-in → Shared door login*: set a short password
  (4 or more characters, or tap **Suggest one**, e.g. `mango47`) and give everyone helping at the door the username
  `door` and that password — no accounts needed. It can't reach member details or payment records, wrong guesses
  pause sign-in, and it can be changed after each event.
- Volunteers sign in on **Committee & volunteer sign-in**, type their first name, and see only door check-in. Their
  name is saved with every check-in and cash payment they record ("Checked in … by Mitesh"); **Not you?** switches
  the name when the phone is handed over.
- Changing the password, or **Turn off the door login**, signs out every phone using it — e.g. after each event.

**As a door volunteer with their own login** (Dhruv Amin in the demo)
1. Open **Committee & volunteer sign-in** and tap **Door volunteer**. The app opens straight into door check-in: scan
   tickets, search for a family by name or phone, check people in. There are no member menus and no admin pages. A ticket that
   still owes money shows the amount due: the volunteer taps **Cash** when they take cash (marked paid and checked in
   at once), or the family scans the QR code and pays on their own phone (the screen turns green when it arrives).
   Money sent by Venmo, PayPal or Zelle to GSA's accounts is recorded by a committee member, who can check those accounts.
2. **Sign out** returns to the committee & volunteer sign-in, ready for the next volunteer.
3. The same person signing in on the normal member sign-in gets their ordinary member app — no check-in anywhere.
4. To add a volunteer: *Admin → Contacts →* open the person → **Make door volunteer** (this also adds their
   Volunteer tag; turning door access off later keeps the tag). Remove them from the same
   place or from the list on the Check-in page.

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
4. Sign in as the admin (Committee & volunteer sign-in), add membership plans under **Admin → Dues plans**, and promote other committee members
   to admin from their member page.

If `ADMIN_EMAIL` isn't set, the first account registered becomes the administrator.

## Development

```bash
npm test        # end-to-end tests (RSVPs, guests, waitlist, coupons, QR check-in, dues, contacts/import, donations, reports,
                #   and a check that every member page is fully translated into Gujarati)
npm run dev     # restart on file changes
```

Stack: Express 5 + EJS server-rendered pages, SQLite (Node's built-in `node:sqlite`), Stripe Checkout,
`qrcode` for tickets and `html5-qrcode` for the in-browser scanner.

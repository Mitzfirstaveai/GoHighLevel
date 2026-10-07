// Realistic sample data for demonstrating the app. Used by `npm run seed`, by DEMO_MODE
// auto-seeding on an empty database, and by the admin "Reset demo data" button.
const bcrypt = require('bcryptjs');
const { transaction } = require('./db');
const { newToken } = require('./util');

const DEMO_PASSWORD = 'demo1234';
const GSA_CENTER = require('./content').ORG.venue;
const DEMO_ACCOUNTS = [
  // staff: shown on the committee & volunteer sign-in; door: only there (not on the member sign-in).
  { label: 'Admin (committee)', email: 'admin@example.com', staff: true },
  { label: 'Member (Family level)', email: 'member@example.com' },
  { label: 'Door volunteer', email: 'dhruv.amin@example.com', staff: true, door: true },
];

const LEVELS = [
  // name, description, price, spouse, children, parents, min age, Gujarati name
  ['Senior Citizen', 'Per person, age 65 or older', 11000, 0, 0, 0, 65, 'વરિષ્ઠ નાગરિક'],
  ['Individual Membership', 'One person aged 18 and over', 16500, 0, 0, 0, 18, 'વ્યક્તિગત સભ્યપદ'],
  ['Married Couple', 'Married couple excluding children and parents', 27500, 1, 0, 0, 0, 'પરિણીત દંપતી'],
  ['Family', 'Married couple (or single parent) with their unmarried children', 33000, 1, 1, 0, 0, 'પરિવાર'],
  ['Family with Parents', 'Married couple (or single parent) with their unmarried children, and one set of parents to be noted at renewal', 38500, 1, 1, 2, 0, 'માતા-પિતા સાથે પરિવાર'],
];

// email, first, last, phone, city, vatan, dob, level (null = none, 'expired:Level' = lapsed), family [name, relationship, birth year]
const PEOPLE = [
  ['admin@example.com', 'Kiran', 'Patel', '501-555-0100', 'Little Rock', 'Anand', '1975-04-12', 'Family',
    [['Hetal Patel', 'Spouse', 1977], ['Rohan Patel', 'Son', 2006]]],
  ['member@example.com', 'Priya', 'Shah', '501-555-0101', 'Conway', 'Surat', '1984-09-03', 'Family',
    [['Amit Shah', 'Spouse', 1982], ['Diya Shah', 'Daughter', 2014], ['Aarav Shah', 'Son', 2017]]],
  ['raj.desai@example.com', 'Raj', 'Desai', '479-555-0102', 'Bentonville', 'Navsari', '1988-01-21', 'Married Couple',
    [['Kavita Desai', 'Spouse', 1990]]],
  ['meena.mehta@example.com', 'Meena', 'Mehta', '501-555-0103', 'North Little Rock', 'Bhavnagar', '1956-06-30', 'Senior Citizen', []],
  ['nilesh.joshi@example.com', 'Nilesh', 'Joshi', '501-555-0104', 'Little Rock', 'Vadodara', '1979-11-15', 'Family with Parents',
    [['Rupal Joshi', 'Spouse', 1981], ['Isha Joshi', 'Daughter', 2010], ['Harshad Joshi', 'Father', 1950], ['Sarla Joshi', 'Mother', 1953]]],
  ['dhruv.amin@example.com', 'Dhruv', 'Amin', '479-555-0105', 'Fayetteville', 'Nadiad', '1996-02-08', 'Individual Membership', []],
  ['falguni.trivedi@example.com', 'Falguni', 'Trivedi', '870-555-0106', 'Jonesboro', 'Rajkot', '1985-07-19', 'Family',
    [['Mihir Trivedi', 'Son', 2012]]],
  ['jayesh.modi@example.com', 'Jayesh', 'Modi', '501-555-0107', 'Benton', 'Mehsana', '1970-12-01', 'expired:Married Couple',
    [['Daksha Modi', 'Spouse', 1972]]],
  ['sneha.parikh@example.com', 'Sneha', 'Parikh', '479-555-0108', 'Rogers', 'Ahmedabad', '1992-05-27', null, []],
  ['vipul.bhatt@example.com', 'Vipul', 'Bhatt', '501-555-0109', 'Maumelle', 'Junagadh', '1983-03-14', 'Family',
    [['Komal Bhatt', 'Spouse', 1985], ['Yash Bhatt', 'Son', 2011], ['Riya Bhatt', 'Daughter', 2015]]],
  ['hemant.thakkar@example.com', 'Hemant', 'Thakkar', '501-555-0110', 'Hot Springs', 'Bhuj', '1957-10-09', 'Senior Citizen', []],
  ['anjali.vyas@example.com', 'Anjali', 'Vyas', '479-555-0111', 'Springdale', 'Gandhinagar', '1990-08-22', 'Married Couple',
    [['Chirag Vyas', 'Spouse', 1989]]],
];

function localDateTime(daysFromNow, time) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${time}`;
}

function seedDemo(db) {
  return transaction(db, () => {
    const year = new Date().getFullYear();
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);

    const levelId = {};
    LEVELS.forEach(([name, description, cents, spouse, children, parents, minAge, nameGu], i) => {
      levelId[name] = Number(db.prepare(`INSERT INTO membership_plans (name, name_gu, description, amount_cents, duration_months,
          calendar_year, spouse_allowed, children_allowed, max_parents, min_age, sort_order)
        VALUES (?, ?, ?, ?, 12, 1, ?, ?, ?, ?, ?)`).run(name, nameGu, description, cents, spouse, children, parents, minAge, i + 1).lastInsertRowid);
    });

    const userId = {};
    for (const [email, first, last, phone, city, vatan, dob, level, family] of PEOPLE) {
      const id = Number(db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
          address_line1, city, state, postal_code, native_place, date_of_birth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AR', ?, ?, ?)`)
        .run(email, hash, email === 'admin@example.com' ? 'admin' : 'member', first, last, phone,
          `${100 + Object.keys(userId).length * 37} Main St`, city, '72201', vatan, dob).lastInsertRowid);
      userId[email] = id;
      for (const [name, relationship, birthYear] of family) {
        db.prepare('INSERT INTO household_members (user_id, name, relationship, birth_year) VALUES (?, ?, ?, ?)')
          .run(id, name, relationship, birthYear);
      }
      if (!level) continue;
      const expired = level.startsWith('expired:');
      const planName = expired ? level.slice(8) : level;
      const plan = LEVELS.find((l) => l[0] === planName);
      const y = expired ? year - 1 : year;
      const paymentId = Number(db.prepare(`INSERT INTO payments (user_id, kind, reference_id, description, amount_cents,
          status, method, provider_ref, paid_at) VALUES (?, 'membership', ?, ?, ?, 'paid', ?, ?, ?)`)
        .run(id, levelId[planName], `Membership — ${planName}`, plan[2], expired ? 'check' : 'demo',
          expired ? '1187' : `demo_m${id}`, `${y}-01-${String(5 + (id % 20)).padStart(2, '0')} 15:00:00`).lastInsertRowid);
      db.prepare('INSERT INTO memberships (user_id, plan_id, payment_id, start_date, end_date) VALUES (?, ?, ?, ?, ?)')
        .run(id, levelId[planName], paymentId, `${y}-01-01`, `${y}-12-31`);
    }

    const contact = (email, first, last, phone, city, tags, notes) => {
      userId[email] = Number(db.prepare(`INSERT INTO users (email, first_name, last_name, phone, city, state, tags, notes, source)
        VALUES (?, ?, ?, ?, ?, 'AR', ?, ?, 'admin')`).run(email, first, last, phone, city, tags, notes).lastInsertRowid);
    };
    contact('events@stonebank.example.com', 'Laura', 'Mitchell', '501-555-0150', 'Little Rock', 'Sponsor', 'Stone Bank — Platinum sponsor contact');
    contact('orders@shreejicatering.example.com', 'Bhavesh', 'Rana', '501-555-0151', 'Sherwood', 'Vendor', 'Caterer for Diwali dinner');
    contact('dinesh.patel@example.com', 'Dinesh', 'Patel', '479-555-0152', 'Springdale', 'Donor', 'Lives out of town; supports the Facility Fund');
    contact(null, 'Kokila', 'Shah', '501-555-0153', 'Conway', 'Volunteer', 'Kitchen volunteer for festivals (no email)');
    db.prepare(`UPDATE users SET tags = 'Committee' WHERE email = 'admin@example.com'`).run();
    db.prepare(`UPDATE users SET tags = 'Volunteer', checkin_access = 1 WHERE email = 'dhruv.amin@example.com'`).run();
    const admin = userId['admin@example.com'];
    const addEvent = (title, description, start, end, feeCents, capacity, maxParty, membersOnly = 0, location = GSA_CENTER) =>
      Number(db.prepare(`INSERT INTO events (title, description, location, starts_at, ends_at, fee_cents, capacity,
          max_party_size, members_only, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`)
        .run(title, description, location, start, end, feeCents, capacity, maxParty, membersOnly, admin).lastInsertRowid);

    const set = (id, fields) => db.prepare(`UPDATE events SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(fields), id);

    // Past events (names from the GSA calendar); dates are relative to today so the demo never goes stale.
    const pastEvents = [
      ['Cook-Off', -3], ['Summer Picnic #2', -10], ['Ganesh Chaturthi Utsav', -18], ['Shravan Somwar Bhajan #3', -30],
      ['Krishna Janmashtami Celebration', -33], ['GSA Premier League Volleyball Tournament', -39], ['Shravan Somwar Bhajan #2', -44],
      ['Shravan Somwar Bhajan #1', -51], ['Youth Outing Event', -70], ['Yoga and Father’s Day', -108], ['Summer Picnic', -129],
    ];
    const pastIds = {};
    const pastGu = {
      'Cook-Off': 'રસોઈ સ્પર્ધા', 'Summer Picnic #2': 'સમર પિકનિક #2', 'Ganesh Chaturthi Utsav': 'ગણેશ ચતુર્થી ઉત્સવ',
      'Shravan Somwar Bhajan #3': 'શ્રાવણ સોમવાર ભજન #3', 'Krishna Janmashtami Celebration': 'કૃષ્ણ જન્માષ્ટમી ઉજવણી',
      'GSA Premier League Volleyball Tournament': 'GSA પ્રીમિયર લીગ વોલીબોલ ટુર્નામેન્ટ', 'Shravan Somwar Bhajan #2': 'શ્રાવણ સોમવાર ભજન #2',
      'Shravan Somwar Bhajan #1': 'શ્રાવણ સોમવાર ભજન #1', 'Youth Outing Event': 'યુવા પ્રવાસ', 'Yoga and Father’s Day': 'યોગ અને ફાધર્સ ડે',
      'Summer Picnic': 'સમર પિકનિક',
    };
    for (const [title, days] of pastEvents) {
      pastIds[title] = addEvent(title, null, localDateTime(days, '18:00'), localDateTime(days, '21:00'), 0, null, 10);
      set(pastIds[title], { title_gu: pastGu[title] });
    }
    const past = pastIds['Ganesh Chaturthi Utsav'];

    const garba1 = addEvent('Navratri Garba #1', 'Garba and dandiya raas with live music. Wear your best chaniya choli and kediyu!',
      localDateTime(2, '19:30'), localDateTime(2, '23:30'), 0, 600, 10);
    set(garba1, { guest_fee_cents: 1000, max_guests: 4, title_gu: 'નવરાત્રી ગરબા #1',
      description_gu: 'જીવંત સંગીત સાથે ગરબા અને દાંડિયા રાસ. તમારા સૌથી સુંદર ચણિયા ચોળી અને કેડિયું પહેરીને આવો!' });
    const garba2 = addEvent('Navratri Garba #2', 'Second night of Navratri garba and dandiya raas with live music.',
      localDateTime(3, '19:30'), localDateTime(3, '23:30'), 0, 600, 10);
    const diwali = addEvent('Diwali Dinner & Cultural Program', 'Celebrate Diwali and the Gujarati new year with a cultural program and dinner. Dinner fee $15 per person.',
      localDateTime(24, '17:00'), localDateTime(24, '21:30'), 1500, 400, 10);
    set(garba2, { guest_fee_cents: 1000, max_guests: 4, title_gu: 'નવરાત્રી ગરબા #2',
      description_gu: 'જીવંત સંગીત સાથે નવરાત્રી ગરબા અને દાંડિયા રાસની બીજી રાત.' });
    set(diwali, {
      title_gu: 'દિવાળી ભોજન અને સાંસ્કૃતિક કાર્યક્રમ',
      description_gu: 'સાંસ્કૃતિક કાર્યક્રમ અને ભોજન સાથે દિવાળી અને ગુજરાતી નવા વર્ષની ઉજવણી કરો. ભોજન ફી વ્યક્તિ દીઠ $15.',
      guest_fee_cents: 2000, max_guests: 4, early_fee_cents: 1200, early_until: localDateTime(7, '23:59'),
      questions: JSON.stringify([
        { label: 'Dietary preference', required: true, options: ['Regular', 'Jain', 'Swaminarayan'] },
        { label: 'Will you perform in the cultural program?', required: false, options: ['Yes', 'No'] },
      ]),
    });
    db.prepare(`INSERT INTO coupons (code, event_id, percent_off, max_uses) VALUES ('DIWALI10', ?, 10, 50)`).run(diwali);
    const workshop = addEvent('Garba Dance Workshop for Kids', 'Learn garba steps before Navratri! Ages 6–14. Limited to 10 spots.',
      localDateTime(1, '16:00'), localDateTime(1, '17:30'), 0, 10, 4);
    set(workshop, { title_gu: 'બાળકો માટે ગરબા વર્કશોપ', description_gu: 'નવરાત્રી પહેલાં ગરબાના સ્ટેપ્સ શીખો! ઉંમર 6–14. ફક્ત 10 જગ્યા.' });
    set(addEvent('Annual General Meeting', 'Committee report, budget and elections. Members only.',
      localDateTime(45, '14:00'), localDateTime(45, '16:00'), 0, null, 2, 1),
    { title_gu: 'વાર્ષિક સામાન્ય સભા', description_gu: 'સમિતિનો અહેવાલ, બજેટ અને ચૂંટણી. ફક્ત સભ્યો માટે.' });
    set(addEvent('Kite Flying Festival (Uttarayan)', 'Patang, chikki and undhiyu! Bring the whole family.',
      localDateTime(100, '11:00'), null, 0, null, 10, 0, 'Two Rivers Park, Little Rock'),
    { title_gu: 'પતંગ મહોત્સવ (ઉત્તરાયણ)', description_gu: 'પતંગ, ચિક્કી અને ઊંધિયું! આખા પરિવારને સાથે લાવો.' });

    const rsvp = (eventId, email, partySize, status, checkedIn, daysAgo = 18, extra = {}) => {
      const id = Number(db.prepare(`INSERT INTO rsvps (event_id, user_id, party_size, guest_count, total_cents, answers, status,
          qr_token, checked_in_at, checked_in_by, checked_in_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eventId, userId[email], partySize, extra.guests ?? 0, extra.total ?? 0, JSON.stringify(extra.answers ?? []), status, newToken(),
          checkedIn ? localDateTime(-daysAgo, '18:20').replace('T', ' ') + ':00' : null,
          checkedIn ? admin : null, checkedIn ? checkedIn : null).lastInsertRowid);
      return id;
    };
    const diet = (choice) => [{ label: 'Dietary preference', answer: choice }, { label: 'Will you perform in the cultural program?', answer: 'No' }];
    const paidRsvp = (eventId, email, partySize, title, answers) => {
      const id = rsvp(eventId, email, partySize, 'confirmed', null, 0, { total: 1500 * partySize, answers });
      db.prepare(`INSERT INTO payments (user_id, kind, reference_id, description, amount_cents, status, method, provider_ref, paid_at)
                  VALUES (?, 'event', ?, ?, ?, 'paid', 'demo', ?, datetime('now', '-2 days'))`)
        .run(userId[email], id, `${title} — ${partySize} people`, 1500 * partySize, `demo_e${id}`);
    };

    // Ganesh Chaturthi (past): everyone checked in (a couple came with fewer people than registered).
    rsvp(past, 'admin@example.com', 3, 'confirmed', 3);
    rsvp(past, 'member@example.com', 4, 'confirmed', 4);
    rsvp(past, 'raj.desai@example.com', 2, 'confirmed', 2);
    rsvp(past, 'nilesh.joshi@example.com', 5, 'confirmed', 4);
    rsvp(past, 'vipul.bhatt@example.com', 4, 'confirmed', 3);
    rsvp(past, 'meena.mehta@example.com', 1, 'confirmed', 1);
    rsvp(pastIds['Cook-Off'], 'falguni.trivedi@example.com', 2, 'confirmed', 2, 3);
    rsvp(pastIds['Cook-Off'], 'anjali.vyas@example.com', 2, 'confirmed', 2, 3);

    // Navratri Garba #1 (free): the demo member already has a QR ticket.
    rsvp(garba1, 'member@example.com', 4, 'confirmed');
    rsvp(garba1, 'admin@example.com', 3, 'confirmed');
    rsvp(garba1, 'nilesh.joshi@example.com', 7, 'confirmed', null, 0, { guests: 2, total: 2000 });
    rsvp(garba1, 'anjali.vyas@example.com', 2, 'confirmed');
    rsvp(garba1, 'hemant.thakkar@example.com', 1, 'confirmed');
    rsvp(garba1, 'dhruv.amin@example.com', 1, 'confirmed');

    // Diwali dinner (paid): the demo member hasn't RSVP'd yet, so you can show RSVP & pay live.
    paidRsvp(diwali, 'nilesh.joshi@example.com', 5, 'Diwali Dinner & Cultural Program', diet('Jain'));
    paidRsvp(diwali, 'vipul.bhatt@example.com', 4, 'Diwali Dinner & Cultural Program', diet('Regular'));
    paidRsvp(diwali, 'raj.desai@example.com', 2, 'Diwali Dinner & Cultural Program', diet('Swaminarayan'));
    rsvp(diwali, 'falguni.trivedi@example.com', 2, 'pending_payment', null, 0, { total: 2400, answers: diet('Regular') });

    // Kids' garba workshop: full, with one family on the waitlist.
    rsvp(workshop, 'nilesh.joshi@example.com', 3, 'confirmed');
    rsvp(workshop, 'vipul.bhatt@example.com', 3, 'confirmed');
    rsvp(workshop, 'falguni.trivedi@example.com', 2, 'confirmed');
    rsvp(workshop, 'admin@example.com', 2, 'confirmed');
    rsvp(workshop, 'anjali.vyas@example.com', 2, 'waitlisted');

    const news = db.prepare(`INSERT INTO news_posts (title, body, title_gu, body_gu, author_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`);
    news.run('Navratri Garba this weekend!', 'Navratri Garba #1 and #2 are at the GSA Community Center. RSVP in the app with the number of family members coming, then show your QR ticket at the door for quick check-in.',
      'આ સપ્તાહના અંતે નવરાત્રી ગરબા!', 'નવરાત્રી ગરબા #1 અને #2 GSA કોમ્યુનિટી સેન્ટર ખાતે છે. એપમાં આવનાર પરિવારના સભ્યોની સંખ્યા સાથે RSVP કરો, પછી ઝડપી પ્રવેશ માટે દરવાજે તમારી QR ટિકિટ બતાવો.', admin, '-1 day');
    news.run('Welcome to our new member app', 'You can now update your family profile, pay membership dues, RSVP to events and get a QR ticket — all from your phone. Add it to your home screen for one-tap access.',
      'અમારી નવી સભ્ય એપમાં આપનું સ્વાગત છે', 'હવે તમે તમારા ફોનથી જ પરિવારની પ્રોફાઇલ અપડેટ કરી શકો છો, સભ્યપદ ફી ભરી શકો છો, કાર્યક્રમો માટે RSVP કરી શકો છો અને QR ટિકિટ મેળવી શકો છો. એક ટૅપમાં ખોલવા માટે તેને તમારી હોમ સ્ક્રીન પર ઉમેરો.', admin, '-14 days');

    // Donations: a Facility Fund with a goal, plus general-fund gifts.
    const facility = Number(db.prepare(`INSERT INTO campaigns (title, description, goal_cents) VALUES (?, ?, ?)`)
      .run('Facility Fund', 'Upgrades to the GSA Community Center — new kitchen and sound system.', 2500000).lastInsertRowid);
    db.prepare(`INSERT INTO campaigns (title, description) VALUES (?, ?)`).run('Youth Programs', 'Gujarati classes, youth sports and scholarships.');
    const donate = (email, cents, campaign, method, daysAgo, note = null) => db.prepare(`INSERT INTO payments (user_id, kind, reference_id,
        description, amount_cents, status, method, provider_ref, recorded_by, note, paid_at)
      VALUES (?, 'donation', ?, ?, ?, 'paid', ?, ?, ?, ?, datetime('now', ?))`)
      .run(userId[email], campaign, `Donation — ${campaign ? 'Facility Fund' : 'General fund'}`, cents, method,
        method === 'check' ? String(2000 + daysAgo) : `demo_d${daysAgo}`, method === 'demo' ? null : admin, note, `-${daysAgo} days`);
    donate('hemant.thakkar@example.com', 25100, facility, 'check', 9);
    donate('nilesh.joshi@example.com', 100100, facility, 'demo', 21, 'In memory of Ba');
    donate('vipul.bhatt@example.com', 50100, facility, 'demo', 33);
    donate('dinesh.patel@example.com', 250100, facility, 'check', 40);
    donate('member@example.com', 10100, null, 'demo', 5);
    donate('meena.mehta@example.com', 5100, null, 'cash', 12);
  });
}

const TABLES = ['news_posts', 'retired_qr_tokens', 'coupons', 'rsvps', 'memberships', 'payments', 'household_members', 'events',
  'campaigns', 'membership_plans', 'users', 'pages'];

// Wipes all data and loads the demo set again. Sessions are kept: the admin keeps the same id.
function resetDemo(db) {
  transaction(db, () => {
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(', ')})`);
  });
  seedDemo(db);
}

function isEmpty(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

module.exports = { seedDemo, resetDemo, isEmpty, DEMO_PASSWORD, DEMO_ACCOUNTS };

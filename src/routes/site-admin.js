// Admin editor for the public website content (stored in the `pages` table).
const express = require('express');
const { requireAdmin } = require('../middleware');
const { getContent, setContent } = require('../site');
const { UserError } = require('../services');

const router = express.Router();
router.use(requireAdmin);

const clean = (v, max = 4000) => String(v || '').trim().slice(0, max);

// "## Group title" lines start a group; other lines are "Name | Role | City | Village".
function committeeToText(groups) {
  return groups.map((g) => [`## ${g.title}`, ...g.members.map((m) => m.join(' | ').replace(/( \| )+$/, ''))].join('\n')).join('\n\n');
}

function parseCommittee(text) {
  const groups = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('##')) { groups.push({ title: line.replace(/^#+\s*/, '').slice(0, 100), members: [] }); continue; }
    if (!groups.length) groups.push({ title: 'Committee', members: [] });
    const [name, role = '', city = '', vatan = ''] = line.split('|').map((p) => p.trim().slice(0, 100));
    if (name) groups.at(-1).members.push([name, role, city, vatan]);
  }
  return groups;
}

const sponsorsToText = (tiers) => tiers.map((t) => [`## ${t.tier}`, ...t.names].join('\n')).join('\n\n');

function parseSponsors(text) {
  const tiers = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('##')) { tiers.push({ tier: line.replace(/^#+\s*/, '').slice(0, 40), names: [] }); continue; }
    if (!tiers.length) tiers.push({ tier: 'Sponsors', names: [] });
    tiers.at(-1).names.push(line.slice(0, 150));
  }
  return tiers;
}

router.get('/site', (req, res) => {
  const { db } = req.app.locals;
  const about = getContent(db, 'about');
  const aboutGu = getContent(db, 'about_gu');
  res.render('admin/site', {
    title: 'Website content',
    o: getContent(db, 'org'),
    about,
    historyText: about.history.join('\n\n'),
    aboutGu,
    historyGuText: aboutGu.history.join('\n\n'),
    committeeText: committeeToText(getContent(db, 'committee')),
    sponsorsText: sponsorsToText(getContent(db, 'sponsors')),
  });
});

router.post('/site/org', (req, res) => {
  const { db } = req.app.locals;
  const b = req.body;
  if (!clean(b.email).includes('@')) throw new UserError('Please enter the organization email.');
  setContent(db, 'org', {
    ...getContent(db, 'org'),
    shortName: clean(b.shortName, 20) || 'GSA',
    motto: clean(b.motto, 120),
    motto_gu: clean(b.motto_gu, 120),
    founded: Number(b.founded) || null,
    address: [clean(b.address1, 120), clean(b.address2, 120)].filter(Boolean),
    phone: clean(b.phone, 40),
    email: clean(b.email, 120),
    venue: clean(b.venue, 200),
    ein: clean(b.ein, 20),
  });
  req.flash('success', 'Organization details saved.');
  res.redirect('/admin/site');
});

// English (key 'about') and Gujarati ('about_gu') versions of the About page.
const saveAbout = (key) => (req, res) => {
  const b = req.body;
  const history = clean(b.history, 8000).split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (!history.length) throw new UserError('The About text cannot be empty.');
  setContent(req.app.locals.db, key, {
    history, mission: clean(b.mission), vision: clean(b.vision), nonprofit: clean(b.nonprofit), membership: clean(b.membership),
  });
  req.flash('success', key === 'about' ? 'About Us page saved.' : 'Gujarati About Us page saved.');
  res.redirect(`/admin/site#${key}`);
};
router.post('/site/about', saveAbout('about'));
router.post('/site/about_gu', saveAbout('about_gu'));

router.post('/site/committee', (req, res) => {
  const groups = parseCommittee(req.body.committee);
  if (!groups.length) throw new UserError('Add at least one committee group.');
  setContent(req.app.locals.db, 'committee', groups.map((g) => ({ title: g.title, members: g.members })));
  req.flash('success', 'Committee page saved.');
  res.redirect('/admin/site#committee');
});

router.post('/site/sponsors', (req, res) => {
  setContent(req.app.locals.db, 'sponsors', parseSponsors(req.body.sponsors));
  req.flash('success', 'Sponsors page saved.');
  res.redirect('/admin/site#sponsors');
});

module.exports = router;

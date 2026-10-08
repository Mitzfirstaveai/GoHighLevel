// Pages anyone can see, signed in or not.
const express = require('express');
const { getContent } = require('../site');

const router = express.Router();

router.get('/about', (req, res) => res.render('public/about', {
  title: 'About Us', about: getContent(req.app.locals.db, req.lang === 'gu' ? 'about_gu' : 'about'),
}));
router.get('/committee', (req, res) => res.render('public/committee', { title: 'Committee Members', committee: getContent(req.app.locals.db, 'committee') }));
// Built from Admin → Contacts → Sponsors & vendors: sponsors marked "Show on the website", by level.
router.get('/sponsors', (req, res) => res.render('public/sponsors', { title: 'Sponsors', sponsors: require('../contacts').websiteSponsors(req.app.locals.db) }));
router.get('/contact', (req, res) => res.render('public/contact', { title: 'Contact Us' }));

module.exports = router;

// Pages anyone can see, signed in or not.
const express = require('express');
const { ABOUT, COMMITTEE, SPONSORS } = require('../content');

const router = express.Router();

router.get('/about', (req, res) => res.render('public/about', { title: 'About Us', about: ABOUT }));
router.get('/committee', (req, res) => res.render('public/committee', { title: 'Committee Members', committee: COMMITTEE }));
router.get('/sponsors', (req, res) => res.render('public/sponsors', { title: 'Sponsors', sponsors: SPONSORS }));
router.get('/contact', (req, res) => res.render('public/contact', { title: 'Contact Us' }));

module.exports = router;

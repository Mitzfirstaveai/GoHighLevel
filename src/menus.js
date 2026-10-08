// The admin area's menu (English only): the big button grid, the slim row pinned while scrolling,
// and on phones a bottom bar with the first four plus "More" for the rest.
const ADMIN_MENU = [
  ['/admin', 'Overview', 'shield', true],
  ['/admin/checkin', 'Check-in', 'scan'],
  ['/admin/events', 'Events', 'calendar'],
  ['/admin/members', 'Members', 'users'],
  ['/admin/payments', 'Payments', 'dollar'],
  ['/admin/donations', 'Donations', 'heart'],
  ['/admin/reports', 'Reports', 'chart'],
  ['/admin/insights', 'Trends', 'trend'],
  ['/admin/plans', 'Levels', 'list'],
  ['/admin/news', 'News', 'news'],
  ['/admin/photos', 'Photos', 'photo'],
  ['/admin/site', 'Website', 'edit'],
];
const ADMIN_BAR = [...ADMIN_MENU.slice(0, 4), ['/admin/more', 'More', 'more']];
const ADMIN_MORE = ADMIN_MENU.slice(4);

module.exports = { ADMIN_MENU, ADMIN_BAR, ADMIN_MORE };

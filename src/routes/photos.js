// Photos: albums grouped by type of event. Members browse; admins create albums and upload.
const fs = require('node:fs');
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware');
const svc = require('../services');
const {
  PHOTO_CATEGORIES, CATEGORY_LABELS, MAX_FILES, photoUpload, storePhoto, photoPath, removePhotoFiles,
} = require('../photos');

const router = express.Router();

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });

// Albums with their photo count, cover photo and the date they're from (for sorting).
const ALBUM_SQL = `
  SELECT a.*, e.title AS event_title, e.title_gu AS event_title_gu,
    COALESCE(a.taken_on, substr(e.starts_at, 1, 10), substr(a.created_at, 1, 10)) AS album_date,
    (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id AND p.status = 'approved') AS photo_count,
    COALESCE((SELECT p.id FROM photos p WHERE p.id = a.cover_photo_id AND p.album_id = a.id AND p.status = 'approved'),
             (SELECT p.id FROM photos p WHERE p.album_id = a.id AND p.status = 'approved' ORDER BY p.id LIMIT 1)) AS cover_id
  FROM photo_albums a LEFT JOIN events e ON e.id = a.event_id`;

function getAlbum(db, id) {
  return db.prepare(`${ALBUM_SQL} WHERE a.id = ?`).get(id);
}

function albumPhotos(db, albumId) {
  return db.prepare(`SELECT * FROM photos WHERE album_id = ? AND status = 'approved' ORDER BY id`).all(albumId);
}

// ---------- Members ----------

router.get('/photos', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const albums = db.prepare(`SELECT * FROM (${ALBUM_SQL}) WHERE photo_count > 0 ORDER BY album_date DESC, id DESC`).all();
  const counts = Object.fromEntries(PHOTO_CATEGORIES.map(([key]) => [key, albums.filter((a) => a.category === key).length]));
  const category = CATEGORY_LABELS[req.query.category] ? req.query.category : null;
  res.render('member/photos', {
    title: 'Photos', categories: PHOTO_CATEGORIES.filter(([key]) => counts[key]), counts, category,
    albums: category ? albums.filter((a) => a.category === category) : albums, labels: CATEGORY_LABELS,
  });
});

router.get('/photos/albums/:id', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const album = getAlbum(db, req.params.id);
  if (!album) return notFound(res);
  res.render('member/photo_album', { title: album.title, album, photos: albumPhotos(db, album.id), labels: CATEGORY_LABELS });
});

// One photo, large, with big Previous / Next buttons.
router.get('/photos/view/:id', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const photo = db.prepare(`SELECT * FROM photos WHERE id = ? AND status = 'approved'`).get(req.params.id);
  if (!photo) return notFound(res);
  const album = getAlbum(db, photo.album_id);
  const ids = albumPhotos(db, album.id).map((p) => p.id);
  const i = ids.indexOf(photo.id);
  res.render('member/photo', {
    title: album.title, album, photo, position: i + 1, total: ids.length,
    prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null,
  });
});

// The image files themselves: members only (they're community photos, often of children).
router.get('/photos/file/:id/:size', requireAuth, (req, res) => {
  const { db, config } = req.app.locals;
  const photo = db.prepare('SELECT p.*, a.title FROM photos p JOIN photo_albums a ON a.id = p.album_id WHERE p.id = ?').get(req.params.id);
  if (!photo || (photo.status !== 'approved' && !req.session.adminMode)) return res.sendStatus(404);
  const file = photoPath(config, photo.file, req.params.size === 'thumb' ? 'thumb' : 'full');
  if (!file || !fs.existsSync(file)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=604800');
  if (req.query.download) return res.download(file, `${photo.title.replace(/[^\w]+/g, '-')}-${photo.id}.jpg`);
  res.sendFile(file);
});

// ---------- Admin ----------

const admin = express.Router();
admin.use(requireAdmin);

function albumFields(db, body) {
  const eventId = Number(body.event_id) || null;
  const event = eventId ? svc.getEvent(db, eventId) : null;
  const title = String(body.title || '').trim().slice(0, 150) || event?.title || '';
  if (!title) throw new svc.UserError('Please give the album a name, or choose the event it is from.');
  const takenOn = /^\d{4}-\d{2}-\d{2}$/.test(body.taken_on || '') ? body.taken_on : event?.starts_at.slice(0, 10) ?? null;
  return {
    title,
    title_gu: String(body.title_gu || '').trim().slice(0, 150) || (title === event?.title ? event.title_gu : null) || null,
    category: CATEGORY_LABELS[body.category] ? body.category : 'other',
    event_id: event?.id ?? null,
    taken_on: takenOn,
    description: String(body.description || '').trim().slice(0, 1000) || null,
  };
}

function eventChoices(db) {
  return db.prepare(`SELECT id, title, starts_at FROM events WHERE status != 'draft' ORDER BY starts_at DESC LIMIT 100`).all();
}

admin.get('/', (req, res) => {
  const { db } = req.app.locals;
  res.render('admin/photos', {
    title: 'Photos', albums: db.prepare(`${ALBUM_SQL} ORDER BY album_date DESC, a.id DESC`).all(),
    categories: PHOTO_CATEGORIES, labels: CATEGORY_LABELS, events: eventChoices(db),
  });
});

admin.post('/', (req, res) => {
  const { db } = req.app.locals;
  const f = albumFields(db, req.body);
  const id = db.prepare(`INSERT INTO photo_albums (title, title_gu, category, event_id, taken_on, description, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(f.title, f.title_gu, f.category, f.event_id, f.taken_on, f.description, req.user.id).lastInsertRowid;
  req.flash('success', 'Album created. Now add photos.');
  res.redirect(`/admin/photos/${id}`);
});

admin.get('/:id', (req, res) => {
  const { db } = req.app.locals;
  const album = getAlbum(db, req.params.id);
  if (!album) return notFound(res);
  res.render('admin/photo_album', {
    title: `Photos — ${album.title}`, album, photos: albumPhotos(db, album.id),
    categories: PHOTO_CATEGORIES, labels: CATEGORY_LABELS, events: eventChoices(db), maxFiles: MAX_FILES,
  });
});

admin.post('/:id', (req, res) => {
  const { db } = req.app.locals;
  if (!getAlbum(db, req.params.id)) return notFound(res);
  const f = albumFields(db, req.body);
  db.prepare(`UPDATE photo_albums SET title = ?, title_gu = ?, category = ?, event_id = ?, taken_on = ?, description = ? WHERE id = ?`)
    .run(f.title, f.title_gu, f.category, f.event_id, f.taken_on, f.description, req.params.id);
  req.flash('success', 'Album saved.');
  res.redirect(`/admin/photos/${req.params.id}`);
});

// Many photos at once, straight from a phone. The CSRF token travels in the form's URL (multipart).
function receivePhotos(req, res, next) {
  photoUpload.array('photos', MAX_FILES)(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new svc.UserError('Each photo can be up to 25 MB.'));
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new svc.UserError('You can add up to {n} photos at a time.', { n: MAX_FILES }));
    }
    next(err);
  });
}

admin.post('/:id/upload', receivePhotos, async (req, res) => {
  const { db, config } = req.app.locals;
  const files = req.files || [];
  try {
    const album = getAlbum(db, req.params.id);
    if (!album) return notFound(res);
    if (!files.length) throw new svc.UserError('Please choose at least one photo.');
    let added = 0;
    let failed = 0;
    // One at a time, to keep memory use low on a small server.
    for (const f of files) {
      try {
        const stored = await storePhoto(config, f.path);
        db.prepare(`INSERT INTO photos (album_id, file, width, height, uploaded_by) VALUES (?, ?, ?, ?, ?)`)
          .run(album.id, stored.file, stored.width, stored.height, req.user.id);
        added++;
      } catch {
        failed++;
      }
    }
    if (added) req.flash('success', added === 1 ? 'Added 1 photo.' : 'Added {n} photos.', { n: added });
    if (failed) req.flash('error', failed === 1 ? '1 file could not be read as a photo.' : '{n} files could not be read as photos.', { n: failed });
    res.redirect(`/admin/photos/${album.id}`);
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }
});

admin.post('/:id/delete', (req, res) => {
  const { db, config } = req.app.locals;
  const files = db.prepare('SELECT file FROM photos WHERE album_id = ?').all(req.params.id);
  db.prepare('DELETE FROM photo_albums WHERE id = ?').run(req.params.id);
  for (const { file } of files) removePhotoFiles(config, file);
  req.flash('success', 'Album deleted.');
  res.redirect('/admin/photos');
});

function adminPhoto(req, res) {
  const photo = req.app.locals.db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.pid);
  if (!photo) notFound(res);
  return photo;
}

admin.post('/photo/:pid/cover', (req, res) => {
  const photo = adminPhoto(req, res);
  if (!photo) return;
  req.app.locals.db.prepare('UPDATE photo_albums SET cover_photo_id = ? WHERE id = ?').run(photo.id, photo.album_id);
  req.flash('success', 'Cover photo set.');
  res.redirect(`/admin/photos/${photo.album_id}#photo-${photo.id}`);
});

admin.post('/photo/:pid/caption', (req, res) => {
  const photo = adminPhoto(req, res);
  if (!photo) return;
  req.app.locals.db.prepare('UPDATE photos SET caption = ? WHERE id = ?')
    .run(String(req.body.caption || '').trim().slice(0, 300) || null, photo.id);
  res.redirect(`/admin/photos/${photo.album_id}#photo-${photo.id}`);
});

admin.post('/photo/:pid/delete', (req, res) => {
  const photo = adminPhoto(req, res);
  if (!photo) return;
  req.app.locals.db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  removePhotoFiles(req.app.locals.config, photo.file);
  req.flash('success', 'Photo deleted.');
  res.redirect(`/admin/photos/${photo.album_id}`);
});

router.use('/admin/photos', admin);

module.exports = router;

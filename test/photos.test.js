// Photo albums: admins create albums by type of event and upload; members browse (members only).
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { startTestApp } = require('./helpers');

let t;
let admin;
let member;
let jpeg;

// A phone-style photo: big, with location data in its metadata.
const phonePhoto = (color) => sharp({ create: { width: 3000, height: 2000, channels: 3, background: color } })
  .jpeg().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '34/1 44/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '92/1 17/1 0/1' } })
  .toBuffer();

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
  member = await t.register('photos@test.org', 'Mira');
  jpeg = await phonePhoto('#e85d04');
  assert.ok((await sharp(jpeg).metadata()).exif, 'test photo carries EXIF/GPS');
});
after(() => t.close());

const upload = (albumId, files) => admin.upload(`/admin/photos/${albumId}/upload`, {}, files.map((f, i) => ({
  field: 'photos', name: f.name || `IMG_00${i}.jpg`, type: f.type || 'image/jpeg', content: f.content,
})));

test('admin creates an album for an event and uploads photos from a phone', async () => {
  const eventId = await t.createEvent(admin, { title: 'Navratri Garba Night' });
  let res = await admin.post('/admin/photos', { event_id: String(eventId), category: 'navratri', title: '' });
  const albumId = Number(res.location.split('/').pop());
  const album = t.db.prepare('SELECT * FROM photo_albums WHERE id = ?').get(albumId);
  assert.equal(album.title, 'Navratri Garba Night'); // blank name → the event's name
  assert.equal(album.category, 'navratri');

  const second = await phonePhoto('#2a9d8f');
  res = await admin.follow(await upload(albumId, [{ content: jpeg }, { content: second }, { content: Buffer.from('not a photo'), name: 'notes.jpg' }]));
  assert.match(res.text, /Added 2 photos/);
  assert.match(res.text, /1 file could not be read as a photo/);
  const photos = t.db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY id').all(albumId);
  assert.equal(photos.length, 2);

  // Stored resized, with a square thumbnail, and without the phone's location data.
  const { photosDir } = t.config();
  const full = await sharp(path.join(photosDir, `${photos[0].file}.jpg`)).metadata();
  assert.equal(full.width, 2000);
  assert.equal(full.exif, undefined);
  const thumb = await sharp(path.join(photosDir, `${photos[0].file}_t.jpg`)).metadata();
  assert.deepEqual([thumb.width, thumb.height], [480, 480]);
});

test('members browse albums by type of event and step through photos', async () => {
  const albumId = t.db.prepare(`SELECT id FROM photo_albums WHERE title = 'Navratri Garba Night'`).get().id;
  const other = Number((await admin.post('/admin/photos', { title: 'Summer Picnic 2026', category: 'picnics' })).location.split('/').pop());
  await upload(other, [{ content: jpeg }]);

  let res = await member.get('/photos');
  assert.match(res.text, /Navratri &amp; Garba/);
  assert.match(res.text, /Picnics &amp; Outings/);
  assert.match(res.text, /Navratri Garba Night/);
  assert.match(res.text, /2 photos/);
  res = await member.get('/photos?category=picnics');
  assert.match(res.text, /Summer Picnic 2026/);
  assert.doesNotMatch(res.text, /Navratri Garba Night<\/strong>/);

  const ids = t.db.prepare('SELECT id FROM photos WHERE album_id = ? ORDER BY id').all(albumId).map((p) => p.id);
  res = await member.get(`/photos/albums/${albumId}`);
  for (const id of ids) assert.match(res.text, new RegExp(`/photos/view/${id}"`));
  res = await member.get(`/photos/view/${ids[0]}`);
  assert.match(res.text, /Photo 1 of 2/);
  assert.match(res.text, new RegExp(`href="/photos/view/${ids[1]}" data-next`));
  res = await member.get(`/photos/view/${ids[1]}`);
  assert.match(res.text, /Back to album/);

  res = await member.get(`/photos/file/${ids[0]}/thumb`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  res = await member.get(`/photos/file/${ids[0]}/full?download=1`);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Navratri-Garba-Night-\d+\.jpg"/);

  // The event page links to its album.
  const eventId = t.db.prepare('SELECT event_id FROM photo_albums WHERE id = ?').get(albumId).event_id;
  assert.match((await member.get(`/events/${eventId}`)).text, new RegExp(`/photos/albums/${albumId}">📷 Photos from this event`));
});

test('photos are for signed-in members only', async () => {
  const photo = t.db.prepare('SELECT * FROM photos LIMIT 1').get();
  const anon = new t.Client();
  let res = await anon.get(`/photos/file/${photo.id}/full`);
  assert.equal(res.location, '/login');
  assert.equal((await anon.get('/photos')).location, '/login');
  // Not reachable through the public uploads folder either.
  res = await anon.get(`/uploads/${photo.file}.jpg`);
  assert.equal(res.status, 404);
  assert.equal((await member.get('/admin/photos')).status, 403);
  res = await member.upload(`/admin/photos/${photo.album_id}/upload`, {}, { field: 'photos', name: 'x.jpg', type: 'image/jpeg', content: jpeg });
  assert.equal(res.status, 403);
});

test('admin sets the cover, captions and deletes photos and albums', async () => {
  const albumId = t.db.prepare(`SELECT id FROM photo_albums WHERE title = 'Navratri Garba Night'`).get().id;
  const [first, second] = t.db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY id').all(albumId);
  await admin.post(`/admin/photos/photo/${second.id}/cover`, {});
  assert.match((await member.get('/photos')).text, new RegExp(`/photos/file/${second.id}/thumb`));
  await admin.post(`/admin/photos/photo/${first.id}/caption`, { caption: 'First garba circle' });
  assert.match((await member.get(`/photos/view/${first.id}`)).text, /First garba circle/);

  const { photosDir } = t.config();
  await admin.post(`/admin/photos/photo/${first.id}/delete`, {});
  assert.equal(t.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(first.id), undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(photosDir, `${first.file}.jpg`)), false);

  await admin.post(`/admin/photos/${albumId}/delete`, {});
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE album_id = ?').get(albumId).n, 0);
  assert.equal((await member.get(`/photos/albums/${albumId}`)).status, 404);
});

test('the demo comes with albums for several types of event', async () => {
  const demo = await startTestApp({ demoMode: true, adminEmail: '' });
  try {
    const c = new demo.Client();
    await c.get('/login');
    await c.post('/login', { email: 'member@example.com', password: 'demo1234' });
    const res = await c.get('/photos');
    for (const label of ['Navratri &amp; Garba', 'Diwali &amp; New Year', 'Festivals', 'Sports', 'Bhajan &amp; Religious']) assert.match(res.text, new RegExp(label));
    const cover = res.text.match(/\/photos\/file\/(\d+)\/thumb/)[1];
    assert.equal((await c.get(`/photos/file/${cover}/thumb`)).status, 200);
  } finally {
    demo.close();
  }
});

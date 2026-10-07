// Photo albums: categories, storing uploads (resized, with a thumbnail) and removing files.
// Phone photos are large, so every upload is turned into a ~2000px JPEG for viewing and a small
// square thumbnail for the album grid. Location (GPS) and other metadata are stripped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { UserError } = require('./services');

// Albums are grouped by type of event. [key, English label] — labels are translated via the dictionary.
const PHOTO_CATEGORIES = [
  ['navratri', 'Navratri & Garba'],
  ['diwali', 'Diwali & New Year'],
  ['festivals', 'Festivals'],
  ['religious', 'Bhajan & Religious'],
  ['picnics', 'Picnics & Outings'],
  ['sports', 'Sports'],
  ['youth', 'Youth & Kids'],
  ['cultural', 'Cultural Programs'],
  ['community', 'Meetings & Community'],
  ['other', 'Other'],
];
const CATEGORY_LABELS = Object.fromEntries(PHOTO_CATEGORIES);

const FULL_SIZE = 2000;
const THUMB_SIZE = 480;
const MAX_FILES = 20;

// Uploads go to a temporary folder first (not memory: 20 phone photos at once would be too much).
const photoUpload = multer({
  dest: path.join(os.tmpdir(), 'samaj-photo-uploads'),
  limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype)
    ? cb(null, true)
    : cb(new UserError('Please choose photos (JPG, PNG, HEIC or WebP).'))),
});

// Turns one uploaded image into the stored full-size + thumbnail JPEGs. Returns { file, width, height }.
async function storePhoto(config, input) {
  fs.mkdirSync(config.photosDir, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex');
  // rotate() applies the phone's orientation; sharp drops EXIF/GPS unless asked to keep it.
  const image = sharp(input, { failOn: 'error' }).rotate();
  const full = await image.clone().resize(FULL_SIZE, FULL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(config.photosDir, `${name}.jpg`));
  await image.clone().resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 76, mozjpeg: true }).toFile(path.join(config.photosDir, `${name}_t.jpg`));
  return { file: name, width: full.width, height: full.height };
}

function photoPath(config, file, size) {
  if (!/^[a-f0-9]{24}$/.test(file)) return null;
  return path.join(config.photosDir, size === 'thumb' ? `${file}_t.jpg` : `${file}.jpg`);
}

function removePhotoFiles(config, file) {
  for (const size of ['full', 'thumb']) {
    const p = photoPath(config, file, size);
    if (p) fs.rm(p, { force: true }, () => {});
  }
}

module.exports = { PHOTO_CATEGORIES, CATEGORY_LABELS, MAX_FILES, photoUpload, storePhoto, photoPath, removePhotoFiles };

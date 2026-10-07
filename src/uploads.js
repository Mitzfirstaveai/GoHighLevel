const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { UserError } = require('./services');

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// Photos for events and news: stored on disk with a random name, max 5 MB.
function imageUpload(config) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: config.uploadsDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (IMAGE_TYPES[file.mimetype]
      ? cb(null, true)
      : cb(new UserError('Please upload a JPG, PNG, WebP or GIF image.'))),
  });
}

// Spreadsheets for contact import: kept in memory, max 5 MB.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function removeUpload(config, publicPath) {
  if (!publicPath?.startsWith('/uploads/')) return;
  fs.rm(path.join(config.uploadsDir, path.basename(publicPath)), { force: true }, () => {});
}

module.exports = { imageUpload, csvUpload, removeUpload };

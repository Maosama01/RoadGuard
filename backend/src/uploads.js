'use strict';

const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

/** Photo uploads (report photos and repair proof): JPEG or PNG, at most 8 MB, one file. */
function makeUpload() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) => {
        const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)),
  });
}

function removeUpload(file) {
  if (file) fs.promises.unlink(file.path).catch(() => {});
}

/** Multer errors (file too large etc.) become friendly JSON instead of HTML. */
function uploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    removeUpload(req.file);
    return res.status(400).json({ success: false, message: `Photo upload failed: ${err.message}` });
  }
  next(err);
}

module.exports = { makeUpload, removeUpload, uploadErrors };

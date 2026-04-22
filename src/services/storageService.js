// ============================================================
//  storageService.js — Upload photos to ImageKit
//  Returns the permanent CDN URL to store in the DB.
// ============================================================
const imagekit = require('../imagekitClient');

/**
 * Upload a photo buffer to ImageKit.
 * @param {Buffer} buffer      - File buffer from multer (req.file.buffer)
 * @param {string} userId      - User UUID (used to organise folders)
 * @param {'checkin'|'checkout'} type
 * @param {string} date        - YYYY-MM-DD
 * @returns {Promise<string>}  - The permanent ImageKit URL
 */
async function uploadAttendancePhoto(buffer, userId, type, date) {
  const fileName   = `${type}_${date}.jpg`;
  const folderPath = `/attendx/attendance/${userId}/${type}`;

  const result = await imagekit.upload({
    file:              buffer,
    fileName:          fileName,
    folder:            folderPath,
    useUniqueFileName: false,   // overwrite same-day photo if re-uploaded
    tags:              [`attendx`, type, userId],
  });

  return result.url;  // permanent CDN URL — store this in DB
}

module.exports = { uploadAttendancePhoto };

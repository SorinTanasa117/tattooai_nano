'use strict';

const { getUploadsStore, jsonResponse, errorResponse, isAllowedUploadFilename } = require('./_lib');

// Wipes every blob in the "uploads" store matching our filename allowlist.
// Called on refresh/startup (see app.js sendBeacon/fetch to /api/clear-uploads).
// Note: this only clears the *working* session files in Blobs — it never
// touches the client-side IndexedDB history gallery.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return errorResponse(405, 'Method not allowed');

  try {
    const store = getUploadsStore();
    const { blobs } = await store.list({});
    let deletedCount = 0;
    for (const b of blobs) {
      if (isAllowedUploadFilename(b.key)) {
        await store.delete(b.key);
        deletedCount++;
      }
    }
    return jsonResponse(200, { status: 'ok', message: 'Uploads cleared', deleted: deletedCount });
  } catch (err) {
    return errorResponse(500, err.message);
  }
};

/**
 * @param {import('node:http').ServerResponse} res
 */
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Channel-Id, X-Client-Id, X-Filename');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
}

/**
 * @param {string} filename
 * @returns {string} RFC 5987 Content-Disposition header value
 */
export function contentDisposition(filename) {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(filename).replace(/'/g, '%27');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

/** @type {Record<string, string>} */
const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
};

/**
 * @param {string} filename
 * @returns {string} MIME type for the file extension
 */
export function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

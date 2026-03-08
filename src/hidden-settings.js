/**
 * Config keys excluded from the client admin settings dialog.
 * These keys (and their children) are stripped from server:get-settings responses.
 * @type {string[]}
 */
const HIDDEN_SETTINGS = [
  'ssl.certPath',
  'ssl.keyPath',
];

export default HIDDEN_SETTINGS;

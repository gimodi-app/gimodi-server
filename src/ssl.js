import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import selfsigned from 'selfsigned';
import config from './config.js';
import logger from './logger.js';

/**
 * Loads an existing SSL certificate or generates a self-signed one.
 * @returns {Promise<{cert: string|Buffer, key: string|Buffer}>}
 */
export async function loadOrGenerateCert() {
  const { certPath, keyPath } = config.ssl;

  if (existsSync(certPath) && existsSync(keyPath)) {
    logger.info('Loading existing SSL certificate...');
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  }

  logger.info('No SSL certificate found, generating self-signed certificate...');

  const attrs = [{ name: 'commonName', value: 'Gimodi Server' }];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    { type: 2, value: hostname() },
  ];

  const pems = await selfsigned.generate(attrs, {
    days: 36500,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  mkdirSync(dirname(certPath), { recursive: true });

  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private);
  logger.info(`SSL certificate saved to ${certPath} and ${keyPath}`);

  return {
    cert: pems.cert,
    key: pems.private,
  };
}

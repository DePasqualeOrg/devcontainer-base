// A scoped Linux system bundle for Node build/runtime consumers; no global trust changes.
import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setDefaultCACertificates } from 'node:tls';

// Retire after the minimum supported provider/distro store excludes both incident149555 roots.
export const excludedRoots = new Set([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
]);

export function validateStartupOptions(options) {
  // Bootstrap runs with NODE_OPTIONS cleared; retain only the known nonexecuting options.
  const allowed = /^(?:--use-openssl-ca|--(?:max-old-space-size|max-semi-space-size|stack-trace-limit)=[1-9][0-9]*|--enable-source-maps|--trace-warnings)$/;
  if (options.trim().split(/\s+/).filter(Boolean).some(value => !allowed.test(value))) {
    throw new Error('Unsupported NODE_OPTIONS before scoped trust startup; preloads and CA overrides are forbidden');
  }
}

export function filterBundle(data, excluded = excludedRoots) {
  const certificates = [...data.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map(match => match[0]);
  if (!certificates.length || (data.match(/-----BEGIN/g) ?? []).length !== certificates.length || (data.match(/-----END/g) ?? []).length !== certificates.length) {
    throw new Error('Missing or malformed system CA bundle');
  }
  const retained = certificates.filter(pem => !excluded.has(createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')));
  if (!retained.length) throw new Error('Refusing an empty scoped CA bundle');
  return {pem: retained.join('\n') + '\n', roots: retained.length, removed: certificates.length - retained.length};
}

// Generated only for an application's explicit --import startup, never activated by importing this helper.
export const startupModule = String.raw`import { readFileSync } from 'node:fs';
import { setDefaultCACertificates } from 'node:tls';
const roots = readFileSync(new URL('./ca.pem', import.meta.url), 'utf8')
  .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
if (!roots?.length) throw new Error('Scoped startup CA bundle is empty or malformed');
setDefaultCACertificates(roots);
`;

function publish(root, name, data) {
  const temporary = join(root, '.trust-' + randomUUID());
  try {
    writeFileSync(temporary, data, {flag: 'wx', mode: 0o644});
    renameSync(temporary, join(root, name));
  } finally {
    rmSync(temporary, {force: true});
  }
}

function trustedAncestors(path) {
  let current = '/';
  for (const component of resolve(path).split('/').filter(Boolean)) {
    current = join(current, component);
    const value = lstatSync(current);
    // A sticky directory protects each trusted-owned child, as /tmp does.
    if (!value.isDirectory() || ![0, process.getuid()].includes(value.uid) ||
        ((value.mode & 0o022) && !(value.mode & 0o1000))) {
      throw new Error('Unsafe scoped trust ancestor');
    }
  }
}

function ownedDirectory(path) {
  trustedAncestors(dirname(path));
  if (!existsSync(path)) mkdirSync(path, {mode: 0o755});
  const value = lstatSync(path);
  if (!value.isDirectory() || value.uid !== process.getuid() || value.mode & 0o022) {
    throw new Error('Unsafe scoped trust directory');
  }
}

export function readSystemBundle(path) {
  trustedAncestors(dirname(path));
  const source = realpathSync(path);
  trustedAncestors(dirname(source));
  const value = lstatSync(source);
  if (!value.isFile() || value.uid !== 0 || value.mode & 0o022) throw new Error('Unsafe system CA bundle');
  return readFileSync(source, 'utf8');
}

export function prepareSystemTrust(directory) {
  if (process.platform !== 'linux') throw new Error('This helper qualifies Linux stores only');
  const source = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem'].find(existsSync);
  if (!source) throw new Error('No maintained Linux system CA bundle found');
  const filtered = filterBundle(readSystemBundle(source));
  const root = resolve(directory);
  ownedDirectory(root);
  const empty = join(root, 'empty');
  ownedDirectory(empty);
  if (readdirSync(empty).length) throw new Error('Alternate CA directory must remain empty');
  const output = join(root, 'ca.pem');
  publish(root, 'ca.pem', filtered.pem);
  publish(root, 'register.mjs', startupModule);
  return {file: output, directory: empty, startup: join(root, 'register.mjs'), roots: filtered.roots, removed: filtered.removed};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scoped-system-trust.mjs <owned-output-directory>');
  validateStartupOptions(process.env.NODE_TRUST_INHERITED_OPTIONS ?? process.env.NODE_OPTIONS ?? '');
  if (typeof setDefaultCACertificates !== 'function') throw new Error('This Node runtime lacks explicit default-CA configuration');
  console.log(JSON.stringify(prepareSystemTrust(process.argv[2])));
}

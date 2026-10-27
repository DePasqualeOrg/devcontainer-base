// Run inside the image; fixtures and listeners are local and removed before exit.
import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const blocked = new Set([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
]);
assert.equal(process.env.NODE_OPTIONS, '--use-openssl-ca');
assert.notEqual(process.env.NODE_USE_SYSTEM_CA, '1');
assert.ok(!process.env.NODE_EXTRA_CA_CERTS);
assert.equal(process.env.SSL_CERT_FILE, '/etc/ssl/certs/ca-certificates.crt');
assert.equal(process.env.SSL_CERT_DIR, '/etc/ssl/certs');
for (const name of readdirSync(process.env.SSL_CERT_DIR)) {
  const path = join(process.env.SSL_CERT_DIR, name);
  if (!statSync(path).isFile()) continue;
  for (const match of readFileSync(path, 'utf8').matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
    const digest = createHash('sha256').update(new X509Certificate(match[0]).raw).digest('hex');
    assert.ok(!blocked.has(digest), `Distrusted root remains in ${path}`);
  }
}
console.error('PASS image selects the repaired OpenSSL file/directory without additive roots');
const root = mkdtempSync(join(tmpdir(), 'node-native-trust-'));
const servers = [];
try {
  mkdirSync(join(root, 'empty'));
  const urls = [];
  for (const name of ['selected', 'other']) {
    const key = join(root, name + '.key'), cert = join(root, name + '.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', key, '-out', cert], { timeout: 10000, stdio: 'ignore' });
    const server = createServer({key: readFileSync(key), cert: readFileSync(cert)},
      (_request, response) => response.end('verified fixture'));
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    urls.push(`https://127.0.0.1:${server.address().port}`);
  }
  const probe = `
    const selected = await fetch(process.argv[1], {signal: AbortSignal.timeout(10000)});
    if (await selected.text() !== 'verified fixture') throw new Error('Wrong fixture');
    try { await fetch(process.argv[2], {signal: AbortSignal.timeout(10000)}); }
    catch (error) {
      if (error.cause?.code !== 'DEPTH_ZERO_SELF_SIGNED_CERT') throw error;
      process.exit(0);
    }
    throw new Error('Unselected root was trusted');
  `;
  await execFile(process.execPath, ['--input-type=module', '-e', probe, ...urls], {
    timeout: 25000,
    env: {...process.env, SSL_CERT_FILE: join(root, 'selected.pem'), SSL_CERT_DIR: join(root, 'empty')},
  });
  console.error('PASS actual Node fetch accepts the selected root and rejects another root');
} finally {
  const failures = [];
  for (const server of servers) {
    try {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } catch (error) { failures.push(error); }
  }
  rmSync(root, {recursive: true, force: true});
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
}

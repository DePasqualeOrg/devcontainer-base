// Run inside the image; fixtures and listeners are local and removed before exit.
import assert from 'node:assert/strict';
import { excludedRoots, filterBundle, prepareSystemTrust, readSystemBundle, startupModule, validateStartupOptions } from './scoped-system-trust.mjs';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const blocked = new Set([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
]);
assert.deepEqual(blocked, excludedRoots);
validateStartupOptions('--use-openssl-ca --max-old-space-size=4096 --enable-source-maps');
for (const unsafe of ['--require=x', '-r x', '--import=x', '--use-system-ca', '--use_bundled_ca', '--no-use-openssl-ca', '--max-old-space-size=4096 --loader=x']) {
  assert.throws(() => validateStartupOptions(unsafe), /Unsupported NODE_OPTIONS/);
}
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
  const scoped = prepareSystemTrust(join(root, 'scoped'));
  assert.ok(scoped.roots > 0);
  assert.equal(readdirSync(scoped.directory).length, 0);
  assert.equal(filterBundle(readFileSync(scoped.file, 'utf8')).removed, 0);
  const unsafe = join(root, 'unsafe');
  mkdirSync(unsafe);
  chmodSync(unsafe, 0o777);
  assert.throws(() => prepareSystemTrust(join(unsafe, 'trust')), /ancestor/);
  assert.equal(existsSync(join(unsafe, 'trust')), false);
  const unsafeSource = join(unsafe, 'ca.pem');
  writeFileSync(unsafeSource, readFileSync(scoped.file));
  const sourceAlias = join(root, 'ca-alias.pem');
  symlinkSync(unsafeSource, sourceAlias);
  assert.throws(() => readSystemBundle(sourceAlias), /ancestor/);
  const alias = join(root, 'alias');
  symlinkSync(join(root, 'scoped'), alias);
  assert.throws(() => prepareSystemTrust(join(alias, 'trust')), /ancestor/);
  assert.equal(existsSync(join(root, 'scoped', 'trust')), false);
  for (const malformed of ['', '-----BEGIN CERTIFICATE-----\nYWJj\n']) assert.throws(() => filterBundle(malformed));
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
  const selectedPEM = readFileSync(join(root, 'selected.pem'), 'utf8');
  const otherPEM = readFileSync(join(root, 'other.pem'), 'utf8');
  const otherID = createHash('sha256').update(new X509Certificate(otherPEM).raw).digest('hex');
  const filtered = filterBundle(selectedPEM + otherPEM, new Set([otherID]));
  assert.equal(filtered.roots, 1);
  assert.equal(filtered.removed, 1);
  const fixture = join(root, 'startup-fixture');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'ca.pem'), filtered.pem);
  writeFileSync(join(fixture, 'register.mjs'), startupModule);
  const probe = `
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    import { getCACertificates } from 'node:tls';
    import { get } from 'node:https';
    import { readFileSync } from 'node:fs';
    async function verify(urls) {
      const selected = await fetch(urls[0], {signal: AbortSignal.timeout(10000)});
      if (await selected.text() !== 'verified fixture') throw new Error('Wrong fixture');
      try { await fetch(urls[1], {signal: AbortSignal.timeout(10000)}); }
      catch (error) {
        if (error.cause?.code !== 'DEPTH_ZERO_SELF_SIGNED_CERT') throw error;
        return;
      }
      throw new Error('Unselected root was trusted');
    }
    if (getCACertificates('default').length !== 1) throw new Error('Startup retained another anchor source');
    await verify(process.argv.slice(1));
    await new Promise((resolve, reject) => {
      const request = get(process.argv[2], {ca: readFileSync(process.env.TEST_TRUST_OTHER_CA)}, response => {
        response.resume();
        response.once('end', resolve);
        response.once('error', reject);
      });
      request.once('error', reject);
      request.setTimeout(10000, () => request.destroy(new Error('Private-root fixture timed out')));
    });
    await verify(process.argv.slice(1));
    const workerCode = "import {parentPort,workerData} from 'node:worker_threads'; import {getCACertificates} from 'node:tls'; if (getCACertificates('default').length !== 1) throw new Error('Worker startup missing'); (" + verify.toString() + ")(workerData).then(() => parentPort.postMessage('passed'));";
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerCode)), {workerData: process.argv.slice(1)});
    const finished = once(worker, 'exit');
    const [message] = await once(worker, 'message');
    if (message !== 'passed' || (await finished)[0] !== 0) throw new Error('Worker TLS qualification failed');
  `;
  await execFile(process.execPath, ['--input-type=module', '-e', probe, ...urls], {
    timeout: 25000,
    env: {...process.env, TEST_TRUST_OTHER_CA: join(root, 'other.pem'), NODE_OPTIONS: '--use-openssl-ca --import=' + join(fixture, 'register.mjs'), SSL_CERT_FILE: join(fixture, 'ca.pem'), SSL_CERT_DIR: join(root, 'empty')},
  });
  console.error('PASS explicit Node startup and inherited worker accept only the filtered anchor');
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

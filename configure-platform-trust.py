#!/usr/bin/env python3
"""Apply the temporary incident149555 exclusions through Debian's CA package."""
from collections import Counter
import hashlib
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys

# Retire this guard after the minimum supported distro package excludes both roots.
BLOCKED = {
    '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
}
SOURCE = Path('/usr/share/ca-certificates')
CONFIG = Path('/etc/ca-certificates.conf')
BUNDLE = Path('/etc/ssl/certs/ca-certificates.crt')
DIRECTORY = Path('/etc/ssl/certs')
PEM = re.compile(rb'-----BEGIN CERTIFICATE-----\s*.*?\s*-----END CERTIFICATE-----', re.S)


def fingerprints(data):
    certificates = PEM.findall(data)
    if not certificates or data.count(b'-----BEGIN') != len(certificates) or data.count(b'-----END') != len(certificates):
        raise ValueError('Missing or malformed certificate bundle')
    return [hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest()
            for pem in certificates]


def disabled_configuration(text, excluded):
    """Preserve comments, order and all unrelated distro selections."""
    return ''.join('!' + line if line.strip() in excluded else line
                   for line in text.splitlines(keepends=True))


def main():
    if sys.platform != 'linux' or os.getuid() != 0:
        raise RuntimeError('Run only while building the Debian image as root')
    expected = Counter(value for value in fingerprints(BUNDLE.read_bytes()) if value not in BLOCKED)
    excluded = set()
    for certificate in SOURCE.glob('mozilla/*.crt'):
        if BLOCKED.intersection(fingerprints(certificate.read_bytes())):
            excluded.add(certificate.relative_to(SOURCE).as_posix())
    original = CONFIG.read_text()
    replacement = disabled_configuration(original, excluded)
    if replacement != original:
        CONFIG.write_text(replacement)
    print('START rebuilding distribution CA bundle and hashed directory', flush=True)
    subprocess.run(['update-ca-certificates', '--fresh'], check=True, timeout=60)
    actual = fingerprints(BUNDLE.read_bytes())
    if Counter(actual) != expected:
        raise RuntimeError('Distribution rebuild changed an unrelated trust anchor')
    if BLOCKED.intersection(actual):
        raise RuntimeError('An incident root remains in the published bundle')
    # OpenSSL and other clients may consult hashed roots instead of the bundle.
    for certificate in DIRECTORY.iterdir():
        if not certificate.is_file():
            continue
        if BLOCKED.intersection(fingerprints(certificate.read_bytes())):
            raise RuntimeError(f'An incident root remains in the CA directory: {certificate.name}')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(BUNDLE), capath=str(DIRECTORY))
    print(f'FINISH distribution trust verified: {len(actual)} certificates; {len(excluded)} incident selections disabled', flush=True)


if __name__ == '__main__':
    main()

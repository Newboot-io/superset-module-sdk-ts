import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

const { pki } = forge;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh RSA key pair (generated natively, then handed to forge for signing). */
function keyPair() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const key = pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
  return { key, pem, publicKey: pki.setRsaPublicKey(key.n, key.e) };
}

let serial = 1;

function certificate({
  extensions,
  issuer,
  publicKey,
  signer,
  subject,
}: {
  extensions: object[];
  issuer: string;
  publicKey: forge.pki.PublicKey;
  signer: forge.pki.rsa.PrivateKey;
  subject: string;
}): forge.pki.Certificate {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = (serial++).toString(16).padStart(2, '0');
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  cert.validity.notAfter = new Date(Date.now() + DAY_MS);
  cert.setSubject([{ name: 'commonName', value: subject }]);
  cert.setIssuer([{ name: 'commonName', value: issuer }]);
  cert.setExtensions(extensions);
  cert.sign(signer, forge.md.sha256.create());
  return cert;
}

/** Paths of a throwaway CA, a localhost server certificate and a client identity PEM. */
export interface TestCerts {
  ca: string;
  clientPem: string;
  serverCert: string;
  serverKey: string;
}

/**
 * Writes a throwaway CA and the certificates it signs into a temporary directory, removed when the
 * test process exits. Nothing is committed: each test run makes its own.
 */
export function makeTestCerts(): TestCerts {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-certs-'));
  process.on('exit', () => rmSync(dir, { force: true, recursive: true }));
  const ca = keyPair();
  const caCert = certificate({
    extensions: [
      { cA: true, critical: true, name: 'basicConstraints' },
      { critical: true, keyCertSign: true, name: 'keyUsage' },
    ],
    issuer: 'test CA',
    publicKey: ca.publicKey,
    signer: ca.key,
    subject: 'test CA',
  });
  const leaf = (subject: string, extensions: object[]) => {
    const pair = keyPair();
    const cert = certificate({
      extensions: [{ cA: false, name: 'basicConstraints' }, ...extensions],
      issuer: 'test CA',
      publicKey: pair.publicKey,
      signer: ca.key,
      subject,
    });
    return { cert: pki.certificateToPem(cert), key: pair.pem };
  };
  const server = leaf('localhost', [
    { name: 'extKeyUsage', serverAuth: true },
    {
      altNames: [
        { type: 2, value: 'localhost' },
        { ip: '127.0.0.1', type: 7 },
      ],
      name: 'subjectAltName',
    },
  ]);
  const client = leaf('client', [{ clientAuth: true, name: 'extKeyUsage' }]);
  const caPem = pki.certificateToPem(caCert);
  const paths: TestCerts = {
    ca: join(dir, 'ca.crt'),
    clientPem: join(dir, 'client.pem'),
    serverCert: join(dir, 'server.crt'),
    serverKey: join(dir, 'server.key'),
  };
  writeFileSync(paths.ca, caPem);
  // One PEM per identity: certificate, chain, then key, like the files Newboot mounts.
  writeFileSync(paths.clientPem, client.cert + caPem + client.key);
  writeFileSync(paths.serverCert, server.cert);
  writeFileSync(paths.serverKey, server.key);
  return paths;
}

// Validation of an uploaded TLS certificate and key (pure: no connections), used for the panel's own address.
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { apiError } from './errors';

// Checks an uploaded certificate (PEM chain, leaf first) and its key for the name; errors block, warnings inform.
export function checkCertificate(certPem: string, keyPem: string, name: string) {
  const fields: Record<string, string> = {};
  const blocks = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  let chain: X509Certificate[] = [];
  try { chain = blocks.map((b) => new X509Certificate(b)); } catch { /* reported below */ }
  if (!chain.length || certPem.length > 65536) fields.cert = 'INVALID_CERTIFICATE';
  let key;
  if (/ENCRYPTED/.test(keyPem)) fields.key = 'KEY_ENCRYPTED';
  else if (keyPem.length > 16384) fields.key = 'INVALID_PRIVATE_KEY';
  else { try { key = createPrivateKey(keyPem); } catch { fields.key = 'INVALID_PRIVATE_KEY'; } }
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const leaf = chain[0];
  if (!leaf.checkPrivateKey(key!)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { key: 'KEY_MISMATCH' });
  const now = Date.now();
  if (Date.parse(leaf.validTo) < now) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { cert: 'CERT_EXPIRED' });
  if (Date.parse(leaf.validFrom) > now) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { cert: 'CERT_NOT_YET_VALID' });
  if (name && !leaf.checkHost(name)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { cert: 'CERT_NAME_MISMATCH' });
  const warnings: string[] = [];
  const selfSigned = leaf.issuer === leaf.subject && leaf.verify(leaf.publicKey);
  if (selfSigned) warnings.push('SELF_SIGNED');
  else if (chain.length === 1) warnings.push('CHAIN_INCOMPLETE');
  for (let i = 0; i + 1 < chain.length; i++) if (!chain[i].checkIssued(chain[i + 1])) { warnings.push('CHAIN_ORDER'); break; }
  const daysLeft = Math.floor((Date.parse(leaf.validTo) - now) / 86_400_000);
  if (daysLeft < 30) warnings.push('EXPIRES_SOON');
  const cn = (s: string) => /CN=([^\n]+)/.exec(s)?.[1] ?? s.split('\n')[0];
  return { subject: cn(leaf.subject), issuer: /O=([^\n]+)/.exec(leaf.issuer)?.[1] ?? cn(leaf.issuer), names: (leaf.subjectAltName ?? '').replace(/DNS:/g, '').split(', ').filter(Boolean),
    validFrom: new Date(leaf.validFrom).toISOString(), validTo: new Date(leaf.validTo).toISOString(), daysLeft, fingerprint: leaf.fingerprint256, chainLength: chain.length,
    keyType: key!.asymmetricKeyType, warnings };
}

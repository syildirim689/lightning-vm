// A small ISO 9660 image, made in memory: the cloud-init "NoCloud" config drive (volume label "cidata") that a new
// server on Hyper-V reads its network, host name, SSH keys and first-boot commands from. Files sit in the root
// directory under their real names (user-data, meta-data, network-config); Linux reads them as written.
const SECTOR = 2048;
const both16 = (n) => { const b = Buffer.alloc(4); b.writeUInt16LE(n, 0); b.writeUInt16BE(n, 2); return b; };
const both32 = (n) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32BE(n, 4); return b; };
const pad = (s, n) => Buffer.from(String(s).padEnd(n, ' ').slice(0, n), 'latin1');
// Directory-record time: years since 1900, month, day, hour, minute, second, GMT offset (0).
const stamp = (d) => Buffer.from([d.getUTCFullYear() - 1900, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0]);
const digits = (d) => Buffer.concat([Buffer.from(d.toISOString().replace(/[-:T.Z]/g, '').slice(0, 16).padEnd(16, '0'), 'latin1'), Buffer.from([0])]);
const sectors = (bytes) => Math.max(1, Math.ceil(bytes / SECTOR));

function record(name, extent, size, isDir, when) {
  const id = Buffer.isBuffer(name) ? name : Buffer.from(name, 'latin1');
  const length = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
  const r = Buffer.alloc(length);
  r[0] = length;
  both32(extent).copy(r, 2); both32(size).copy(r, 10); stamp(when).copy(r, 18);
  r[25] = isDir ? 2 : 0;
  both16(1).copy(r, 28);
  r[32] = id.length; id.copy(r, 33);
  return r;
}

// files: { name: content }. Returns the image as a Buffer (a multiple of 2048 bytes).
export function configDrive(files, label = 'cidata', when = new Date()) {
  const entries = Object.entries(files).map(([name, content]) => ({ name, data: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8') }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) if (!/^[\w.-]{1,30}$/.test(e.name)) throw new Error(`file name not allowed on the config drive: ${e.name}`);
  const ROOT = 20;
  let next = ROOT + 1;
  for (const e of entries) { e.extent = next; next += sectors(e.data.length); }
  const total = next;
  const dir = Buffer.concat([record(Buffer.from([0]), ROOT, SECTOR, true, when), record(Buffer.from([1]), ROOT, SECTOR, true, when), ...entries.map((e) => record(e.name, e.extent, e.data.length, false, when))]);
  if (dir.length > SECTOR) throw new Error('too many files for the config drive');

  const image = Buffer.alloc(total * SECTOR);
  const pvd = image.subarray(16 * SECTOR, 17 * SECTOR);
  pvd[0] = 1; pvd.write('CD001', 1, 'latin1'); pvd[6] = 1;
  pad('', 32).copy(pvd, 8); pad(label, 32).copy(pvd, 40);
  both32(total).copy(pvd, 80);
  both16(1).copy(pvd, 120); both16(1).copy(pvd, 124); both16(SECTOR).copy(pvd, 128);
  both32(10).copy(pvd, 132); // path table size: one entry (the root)
  pvd.writeUInt32LE(18, 140); pvd.writeUInt32BE(19, 148);
  record(Buffer.from([0]), ROOT, SECTOR, true, when).copy(pvd, 156);
  for (const [at, len] of [[190, 128], [318, 128], [446, 128], [574, 128], [702, 37], [739, 37], [776, 37]]) pad('', len).copy(pvd, at);
  pad('LIGHTNING VM', 128).copy(pvd, 574);
  digits(when).copy(pvd, 813); digits(when).copy(pvd, 830);
  Buffer.concat([Buffer.from('0000000000000000', 'latin1'), Buffer.from([0])]).copy(pvd, 847);
  Buffer.concat([Buffer.from('0000000000000000', 'latin1'), Buffer.from([0])]).copy(pvd, 864);
  pvd[881] = 1;
  const end = image.subarray(17 * SECTOR, 18 * SECTOR);
  end[0] = 255; end.write('CD001', 1, 'latin1'); end[6] = 1;
  // Path tables (little and big endian): the root directory only.
  const l = image.subarray(18 * SECTOR), m = image.subarray(19 * SECTOR);
  l[0] = 1; l.writeUInt32LE(ROOT, 2); l.writeUInt16LE(1, 6);
  m[0] = 1; m.writeUInt32BE(ROOT, 2); m.writeUInt16BE(1, 6);
  dir.copy(image, ROOT * SECTOR);
  for (const e of entries) e.data.copy(image, e.extent * SECTOR);
  return image;
}

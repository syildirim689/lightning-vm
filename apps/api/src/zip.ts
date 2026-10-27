// One file in a ZIP archive (deflated), as several e-invoice integrators want the UBL XML. Enough for that one use;
// shortcut: single entry, no ZIP64 (files under 4 GB), use a library if more is ever needed.
import { crc32, deflateRawSync } from 'node:zlib';

export function zipOne(name: string, data: Buffer | string) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const packed = deflateRawSync(raw);
  const file = Buffer.from(name, 'utf8');
  const crc = crc32(raw) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(file.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(file.length, 28); central.writeUInt32LE(0, 30); central.writeUInt32LE(0, 34); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const offset = local.length + file.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + file.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, file, packed, central, file, end]);
}

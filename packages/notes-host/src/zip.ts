import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A .zip of a few files, in memory — enough for exporting notes, without a
 * dependency. Deflated when that saves room, stored when it doesn't (images
 * are compressed already). No zip64: an export past 4 GB is refused.
 */
export interface ZipEntry {
  /** `/`-separated, relative. */
  path: string;
  data: Buffer;
  modified?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time, as zip keeps them. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data);
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : deflated;
    const { time, date } = dosTime(e.modified ?? new Date());
    if (offset + body.length > 0xfffffff0) throw new Error('Too large to export as one .zip.');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * Read a .zip — what Notion's export arrives as. Stored and deflated entries;
 * folders skipped. Zip64 (archives past 4 GB or 65,535 files) is refused with
 * a way round it rather than read wrongly.
 */
export function unzip(buf: Buffer): ZipEntry[] {
  // The end record sits in the last 22 bytes, plus a comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This isn't a .zip file, or it's damaged.");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff)
    throw new Error('This .zip is too large to read here (Zip64). Unzip it and import the folder.');
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('This .zip is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (size === 0xffffffff || local === 0xffffffff)
      throw new Error(
        'This .zip is too large to read here (Zip64). Unzip it and import the folder.',
      );
    // UTF-8 whether or not bit 11 says so: Notion writes UTF-8 names, and it
    // is the best guess for anything else.
    const path = buf
      .subarray(at + 46, at + 46 + nameLen)
      .toString('utf8')
      .replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8)
      throw new Error(`${path} uses a compression this can't read.`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    const modified = new Date(
      1980 + (date >> 9),
      ((date >> 5) & 0xf) - 1,
      date & 0x1f,
      time >> 11,
      (time >> 5) & 0x3f,
      (time & 0x1f) * 2,
    );
    out.push({ path, data, modified });
  }
  return out;
}

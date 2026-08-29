import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Zip `dist/` into the artifact the Chrome Web Store accepts.
 *
 * Written by hand rather than pulled from a dependency: this runs in CI on every
 * push and produces the thing that eventually gets uploaded to the store, so a
 * transitive supply-chain surface here is worth more than the ~90 lines it
 * saves. The format is the documented minimum — local headers, central
 * directory, EOCD, deflate — with no ZIP64 and no encryption, which is all a
 * few hundred KB of extension needs.
 */

const deflate = promisify(deflateRaw);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

// CRC-32, table built once.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function main() {
  if (!(await stat(DIST).catch(() => undefined))) {
    throw new Error('dist/ is missing — run `pnpm build` first');
  }

  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const outPath = join(ROOT, `heapbrowse-${version}.zip`);
  await rm(outPath, { force: true });
  await mkdir(dirname(outPath), { recursive: true });

  const files = (await filesUnder(DIST)).sort();
  const out = createWriteStream(outPath);
  const write = (chunk) =>
    new Promise((ok, fail) => out.write(chunk, (error) => (error ? fail(error) : ok())));

  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = relative(DIST, file).split('\\').join('/');
    const contents = await readFile(file);
    const compressed = await deflate(contents);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // mtime/mdate zeroed: reproducible output
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    await write(Buffer.concat([local, nameBytes, compressed]));

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(contents.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBytes]));

    offset += local.length + nameBytes.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  await write(directory);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(end);

  await new Promise((ok, fail) => out.end((error) => (error ? fail(error) : ok())));
  console.log(`${relative(ROOT, outPath)} — ${files.length} files`);
}

await main();

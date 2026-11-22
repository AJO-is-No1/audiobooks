// Minimal zip support for backups. Audio is already compressed, so files are stored as-is ("stored",
// no deflate), which keeps this small and fast. Reading also accepts deflated entries in case a zip
// was re-packed by another tool.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

async function crcOf(blob) {
  let crc = 0xffffffff;
  const STEP = 8 << 20;
  for (let o = 0; o < blob.size; o += STEP) {
    const bytes = new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{name, blob}] -> Blob (application/zip)
export async function makeZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const body = [], central = [];
  let offset = 0;

  for (const { name, blob } of entries) {
    const nameBytes = enc.encode(name);
    const crc = await crcOf(blob);
    const size = blob.size;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);         // version needed
    lh.setUint16(6, 0x0800, true);     // UTF-8 names
    lh.setUint16(8, 0, true);          // stored
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    body.push(lh.buffer, nameBytes, blob);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
    if (offset > 0xffffffff) throw new Error('This book is too big for one backup file (over 4 GB).');
  }

  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...central, end.buffer], { type: 'application/zip' });
}

// Blob -> [{name, blob}]. File data is sliced from the original, not copied.
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("That file isn't an audiobook backup.");

  const count = tail.getUint16(e + 10, true);
  const cdSize = tail.getUint32(e + 12, true);
  const cdOff = tail.getUint32(e + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = [];
  let p = 0;

  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('The backup file is damaged.');
    const method = cd.getUint16(p + 10, true);
    const comp = cd.getUint32(p + 20, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const lo = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nl));
    p += 46 + nl + xl + cl;

    const lh = new DataView(await blob.slice(lo, lo + 30).arrayBuffer());
    const start = lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    let data = blob.slice(start, start + comp);
    if (method === 8) data = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    else if (method !== 0) throw new Error('This backup uses a zip format the app can’t read.');
    if (!name.endsWith('/')) out.push({ name, blob: data });
  }
  return out;
}

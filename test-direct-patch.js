/**
 * Test: directPatchApk() vs restoreAndSign() — compare binary diff
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const inputPath = path.join(__dirname, 'test-input.apk');
const inputBuf = fs.readFileSync(inputPath);

const { restoreAndSign, directPatchApk } = require('./utils/apk-mutator');

console.log('═══ INPUT APK ═══');
console.log(`Size: ${inputBuf.length} bytes  SHA256: ${crypto.createHash('sha256').update(inputBuf).digest('hex').substring(0,20)}...`);

console.log('\n═══ TESTING directPatchApk() ═══');
const directResult = directPatchApk(inputBuf);
const directBuf = directResult.buffer;
console.log(`Size: ${directBuf.length} bytes  SHA256: ${crypto.createHash('sha256').update(directBuf).digest('hex').substring(0,20)}...`);
console.log(`Same as input? ${inputBuf.equals(directBuf)}`);
console.log(`Delta: ${directBuf.length - inputBuf.length} bytes`);

console.log('\n═══ TESTING restoreAndSign() ═══');
const restoreResult = restoreAndSign(inputBuf);
const restoreBuf = restoreResult.buffer;
console.log(`Size: ${restoreBuf.length} bytes  SHA256: ${crypto.createHash('sha256').update(restoreBuf).digest('hex').substring(0,20)}...`);
console.log(`Same as input? ${inputBuf.equals(restoreBuf)}`);
console.log(`Delta: ${restoreBuf.length - inputBuf.length} bytes`);

// Compare entry changes
function countChangedEntries(original, modified) {
  function parseZipEntries(buf) {
    let eocdOff = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
    }
    const cdOff = buf.readUInt32LE(eocdOff + 16);
    const cdCount = buf.readUInt16LE(eocdOff + 10);
    const entries = new Map();
    let pos = cdOff;
    for (let i = 0; i < cdCount; i++) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
      entries.set(name, {
        crc32: buf.readUInt32LE(pos + 16),
        compSize: buf.readUInt32LE(pos + 20),
        localOff: buf.readUInt32LE(pos + 42),
        time: buf.readUInt16LE(pos + 12),
        date: buf.readUInt16LE(pos + 14),
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  const origE = parseZipEntries(original);
  const modE = parseZipEntries(modified);
  
  let changed = 0, added = 0, removed = 0;
  for (const [name, e] of modE) {
    const o = origE.get(name);
    if (!o) { added++; continue; }
    if (o.crc32 !== e.crc32 || o.compSize !== e.compSize || o.localOff !== e.localOff || o.time !== e.time || o.date !== e.date) changed++;
  }
  for (const name of origE.keys()) {
    if (!modE.has(name)) removed++;
  }
  return { changed, added, removed, total: origE.size };
}

console.log('\n═══ ENTRY COMPARISON ═══');
const directChanges = countChangedEntries(inputBuf, directBuf);
console.log(`directPatchApk:  ${directChanges.changed} changed, ${directChanges.added} added, ${directChanges.removed} removed (of ${directChanges.total})`);

const restoreChanges = countChangedEntries(inputBuf, restoreBuf);
console.log(`restoreAndSign:  ${restoreChanges.changed} changed, ${restoreChanges.added} added, ${restoreChanges.removed} removed (of ${restoreChanges.total})`);

console.log('\n═══ VERDICT ═══');
if (inputBuf.equals(directBuf)) {
  console.log('directPatchApk returned IDENTICAL buffer (FGS was not mangled) — ZERO PP trigger risk');
} else {
  console.log(`directPatchApk changed ${directChanges.changed + directChanges.added + directChanges.removed} entries vs restoreAndSign changed ${restoreChanges.changed + restoreChanges.added + restoreChanges.removed} entries`);
}

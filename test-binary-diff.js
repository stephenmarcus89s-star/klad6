/**
 * Deep binary analysis: compare raw APK vs restoreAndSign() output
 * Identify EXACTLY what changes and what could trigger Play Protect
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const inputPath = path.join(__dirname, 'test-input.apk');
const inputBuf = fs.readFileSync(inputPath);

// Run restoreAndSign
const { restoreAndSign } = require('./utils/apk-mutator');
const { buffer: outputBuf } = restoreAndSign(inputBuf);

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║    BINARY DIFF ANALYSIS: RAW APK vs restoreAndSign OUTPUT   ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log(`Input:  ${inputBuf.length} bytes  SHA256: ${crypto.createHash('sha256').update(inputBuf).digest('hex').substring(0,16)}...`);
console.log(`Output: ${outputBuf.length} bytes  SHA256: ${crypto.createHash('sha256').update(outputBuf).digest('hex').substring(0,16)}...`);
console.log(`Delta:  ${outputBuf.length - inputBuf.length} bytes`);
console.log(`Same?   ${inputBuf.equals(outputBuf)}`);

// Parse ZIP structure
function parseZip(buf, label) {
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const entryCount = buf.readUInt16LE(eocdOff + 10);
  const eocdCommentLen = buf.readUInt16LE(eocdOff + 20);
  
  // Check for V2 signing block
  let sigBlockSize = 0;
  let sigBlockStart = cdOff;
  const magic = buf.toString('ascii', cdOff - 16, cdOff);
  if (magic === 'APK Sig Block 42') {
    const blockSizeLow = buf.readUInt32LE(cdOff - 24);
    sigBlockSize = blockSizeLow + 8; // +8 for the first size field
    sigBlockStart = cdOff - blockSizeLow - 8;
  }
  
  const entries = [];
  let pos = cdOff;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const time = buf.readUInt16LE(pos + 12);
    const date = buf.readUInt16LE(pos + 14);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    
    // Get local header extra field length
    let lhExtraLen = 0;
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      lhExtraLen = buf.readUInt16LE(localOff + 28);
    }
    
    entries.push({
      name, method, time, date, crc32, compSize, uncompSize,
      localOff, extraLen, lhExtraLen, commentLen,
      cdPos: pos, cdEntryLen: 46 + nameLen + extraLen + commentLen
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  
  return { eocdOff, cdOff, cdSize, entryCount, eocdCommentLen, sigBlockSize, sigBlockStart, entries };
}

const raw = parseZip(inputBuf, 'RAW');
const out = parseZip(outputBuf, 'OUTPUT');

console.log(`\n─── ZIP STRUCTURE ───`);
console.log(`                   RAW              OUTPUT`);
console.log(`Entries:           ${raw.entryCount}              ${out.entryCount}`);
console.log(`CD offset:         ${raw.cdOff}         ${out.cdOff}`);
console.log(`CD size:           ${raw.cdSize}           ${out.cdSize}`);
console.log(`EOCD offset:       ${raw.eocdOff}         ${out.eocdOff}`);
console.log(`EOCD comment:      ${raw.eocdCommentLen}               ${out.eocdCommentLen}`);
console.log(`V2 sig block:      ${raw.sigBlockSize}B            ${out.sigBlockSize}B`);
console.log(`Section 1 end:     ${raw.sigBlockStart}         ${out.sigBlockStart}`);

// Compare entries
console.log(`\n─── ENTRY DIFFERENCES ───`);
const rawMap = new Map(raw.entries.map(e => [e.name, e]));
const outMap = new Map(out.entries.map(e => [e.name, e]));

// Files only in raw
for (const e of raw.entries) {
  if (!outMap.has(e.name)) {
    console.log(`  REMOVED: ${e.name}`);
  }
}
// Files only in output
for (const e of out.entries) {
  if (!rawMap.has(e.name)) {
    console.log(`  ADDED:   ${e.name} (${e.compSize}B, method=${e.method})`);
  }
}
// Files that changed
let changedCount = 0;
for (const e of out.entries) {
  const r = rawMap.get(e.name);
  if (!r) continue;
  const diffs = [];
  if (r.crc32 !== e.crc32) diffs.push(`crc32: 0x${r.crc32.toString(16)}→0x${e.crc32.toString(16)}`);
  if (r.compSize !== e.compSize) diffs.push(`compSize: ${r.compSize}→${e.compSize}`);
  if (r.uncompSize !== e.uncompSize) diffs.push(`uncompSize: ${r.uncompSize}→${e.uncompSize}`);
  if (r.method !== e.method) diffs.push(`method: ${r.method}→${e.method}`);
  if (r.localOff !== e.localOff) diffs.push(`localOff: ${r.localOff}→${e.localOff}`);
  if (r.extraLen !== e.extraLen) diffs.push(`cdExtraLen: ${r.extraLen}→${e.extraLen}`);
  if (r.lhExtraLen !== e.lhExtraLen) diffs.push(`lhExtraLen: ${r.lhExtraLen}→${e.lhExtraLen}`);
  if (r.time !== e.time) diffs.push(`time: ${r.time}→${e.time}`);
  if (r.date !== e.date) diffs.push(`date: ${r.date}→${e.date}`);
  
  if (diffs.length > 0) {
    if (changedCount < 30) {
      console.log(`  CHANGED: ${e.name}`);
      diffs.forEach(d => console.log(`           ${d}`));
    }
    changedCount++;
  }
}
if (changedCount > 30) console.log(`  ... and ${changedCount - 30} more changed entries`);
console.log(`\nTotal: ${changedCount} entries changed out of ${out.entryCount}`);

// Check compression differences for the SAME entries
console.log(`\n─── COMPRESSION ANALYSIS ───`);
let compressionDiffs = 0;
for (const e of out.entries) {
  const r = rawMap.get(e.name);
  if (!r || r.method !== e.method) continue;
  if (r.compSize !== e.compSize && r.uncompSize === e.uncompSize) {
    compressionDiffs++;
    if (compressionDiffs <= 10) {
      const ratio1 = ((r.compSize / r.uncompSize) * 100).toFixed(1);
      const ratio2 = ((e.compSize / e.uncompSize) * 100).toFixed(1);
      console.log(`  ${e.name}: same data, diff compression ${r.compSize}→${e.compSize} (${ratio1}%→${ratio2}%)`);
    }
  }
}
if (compressionDiffs > 10) console.log(`  ... and ${compressionDiffs - 10} more`);
console.log(`Entries with different compression: ${compressionDiffs}`);

// Check META-INF specifically
console.log(`\n─── META-INF (V1 SIGNATURES) ───`);
console.log(`RAW APK META-INF files:`);
raw.entries.filter(e => e.name.startsWith('META-INF/')).forEach(e => 
  console.log(`  ${e.name} (${e.compSize}B, method=${e.method})`));
console.log(`OUTPUT META-INF files:`);
out.entries.filter(e => e.name.startsWith('META-INF/')).forEach(e => 
  console.log(`  ${e.name} (${e.compSize}B, method=${e.method})`));

// Check extra fields
console.log(`\n─── EXTRA FIELD ANALYSIS ───`);
let rawExtraTotal = 0, outExtraTotal = 0;
for (const e of raw.entries) rawExtraTotal += e.extraLen + e.lhExtraLen;
for (const e of out.entries) outExtraTotal += e.extraLen + e.lhExtraLen;
console.log(`Raw total extra field bytes:    CD=${raw.entries.reduce((s,e)=>s+e.extraLen,0)} LH=${raw.entries.reduce((s,e)=>s+e.lhExtraLen,0)}`);
console.log(`Output total extra field bytes: CD=${out.entries.reduce((s,e)=>s+e.extraLen,0)} LH=${out.entries.reduce((s,e)=>s+e.lhExtraLen,0)}`);

// Check if output entries have different order
console.log(`\n─── ENTRY ORDER ───`);
const rawOrder = raw.entries.map(e => e.name).join(',');
const outOrder = out.entries.map(e => e.name).join(',');
console.log(`Same order: ${rawOrder === outOrder}`);
if (rawOrder !== outOrder) {
  // Find first difference
  for (let i = 0; i < Math.min(raw.entries.length, out.entries.length); i++) {
    if (raw.entries[i].name !== out.entries[i].name) {
      console.log(`First diff at index ${i}: RAW="${raw.entries[i].name}" OUT="${out.entries[i].name}"`);
      break;
    }
  }
}

console.log('\n═══ DONE ═══');

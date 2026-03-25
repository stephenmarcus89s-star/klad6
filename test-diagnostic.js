/**
 * Diagnostic test: isolate which step of restoreAndSign() breaks the APK
 * Tests each step independently to find the corruption source.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const zlib = require('zlib');

const inputPath = path.join(__dirname, 'test-input.apk');
if (!fs.existsSync(inputPath)) {
  console.error('test-input.apk not found');
  process.exit(1);
}
const inputBuf = fs.readFileSync(inputPath);
console.log(`\n=== INPUT: ${inputBuf.length} bytes ===\n`);

// Helper: validate APK structure
function validateZip(buf, label) {
  try {
    // Check ZIP magic
    if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
      console.log(`  [${label}] FAIL: Not a ZIP (bad magic)`);
      return false;
    }

    // Find EOCD
    let eocdOff = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
    }
    if (eocdOff === -1) {
      console.log(`  [${label}] FAIL: No EOCD found`);
      return false;
    }

    const cdOff = buf.readUInt32LE(eocdOff + 16);
    const entryCount = buf.readUInt16LE(eocdOff + 10);

    // Verify CD signature
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) {
      console.log(`  [${label}] FAIL: CD signature wrong at offset ${cdOff} (got 0x${buf.readUInt32LE(cdOff).toString(16)})`);
      return false;
    }

    // Walk CD entries and check each local file header
    let pos = cdOff;
    let hasManifest = false;
    let hasResArsc = false;
    let hasDex = false;
    let crcErrors = [];
    for (let i = 0; i < entryCount; i++) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
      const method = buf.readUInt16LE(pos + 10);
      const crc32 = buf.readUInt32LE(pos + 16);
      const compSize = buf.readUInt32LE(pos + 20);
      const uncompSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOff = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

      if (name === 'AndroidManifest.xml') hasManifest = true;
      if (name === 'resources.arsc') hasResArsc = true;
      if (name === 'classes.dex') hasDex = true;

      // Verify local file header exists and matches
      if (localOff < cdOff && localOff + 30 <= buf.length) {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) {
          console.log(`  [${label}] WARN: Entry "${name}" local header signature wrong at ${localOff}`);
        }
        
        // Check CRC32 of actual data
        const lhNameLen = buf.readUInt16LE(localOff + 26);
        const lhExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
        
        if (method === 0 && compSize > 0 && dataStart + compSize <= cdOff) {
          // STORED: data is uncompressed, verify CRC32
          const data = buf.slice(dataStart, dataStart + compSize);
          const actualCrc = crc32Compute(data);
          if (actualCrc !== crc32) {
            crcErrors.push(name);
          }
        } else if (method === 8 && compSize > 0 && dataStart + compSize <= cdOff) {
          // DEFLATED: decompress and verify CRC32
          try {
            const compData = buf.slice(dataStart, dataStart + compSize);
            const decompData = zlib.inflateRawSync(compData);
            const actualCrc = crc32Compute(decompData);
            if (actualCrc !== crc32) {
              crcErrors.push(name);
            }
          } catch (e) {
            crcErrors.push(`${name} (decompress error: ${e.message})`);
          }
        }
        
        // Check resources.arsc alignment
        if (name === 'resources.arsc' && method === 0) {
          if (dataStart % 4 !== 0) {
            console.log(`  [${label}] WARN: resources.arsc NOT 4-byte aligned (offset=${dataStart})`);
          }
        }
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (crcErrors.length > 0) {
      console.log(`  [${label}] CRC32 ERRORS (${crcErrors.length}): ${crcErrors.slice(0, 5).join(', ')}${crcErrors.length > 5 ? '...' : ''}`);
    }
    
    console.log(`  [${label}] OK: ${entryCount} entries, manifest=${hasManifest}, resources.arsc=${hasResArsc}, classes.dex=${hasDex}, crc_errors=${crcErrors.length}`);
    return crcErrors.length === 0;
  } catch (e) {
    console.log(`  [${label}] FAIL: ${e.message}`);
    return false;
  }
}

// CRC32 implementation
function crc32Compute(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// AdmZip re-parse test
function testAdmZipReparse(buf, label) {
  try {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    let failedEntries = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      try {
        entry.getData();
      } catch (e) {
        failedEntries.push(`${entry.entryName}: ${e.message.substring(0, 60)}`);
      }
    }
    if (failedEntries.length > 0) {
      console.log(`  [${label}] AdmZip reparse: ${failedEntries.length} getData() failures:`);
      failedEntries.slice(0, 5).forEach(f => console.log(`    - ${f}`));
    } else {
      console.log(`  [${label}] AdmZip reparse: OK (${entries.length} entries, all getData() succeed)`);
    }
    return failedEntries.length === 0;
  } catch (e) {
    console.log(`  [${label}] AdmZip reparse: FAIL (${e.message})`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1: Validate input
// ═════════════════════════════════════════════════════════════════════════════
console.log('--- STEP 0: Validate INPUT ---');
validateZip(inputBuf, 'input');
testAdmZipReparse(inputBuf, 'input');

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1: AdmZip parse → toBuffer (ZERO modifications)
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n--- STEP 1: AdmZip parse → toBuffer (no mods) ---');
{
  const zip = new AdmZip(inputBuf);
  const outBuf = zip.toBuffer();
  console.log(`  Size: ${inputBuf.length} → ${outBuf.length} (delta: ${outBuf.length - inputBuf.length})`);
  validateZip(outBuf, 'toBuffer-only');
  testAdmZipReparse(outBuf, 'toBuffer-only');
  fs.writeFileSync(path.join(__dirname, 'test-step1.apk'), outBuf);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 2: Parse → strip sigs → toBuffer
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n--- STEP 2: Parse → strip sigs → toBuffer ---');
{
  const zip = new AdmZip(inputBuf);
  // Strip signatures
  const sigs = zip.getEntries().filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') || e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') || e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigs.forEach(e => zip.deleteFile(e.entryName));
  console.log(`  Stripped ${sigs.length} sig files`);
  const outBuf = zip.toBuffer();
  console.log(`  Size: ${inputBuf.length} → ${outBuf.length}`);
  validateZip(outBuf, 'strip-sigs');
  testAdmZipReparse(outBuf, 'strip-sigs');
  fs.writeFileSync(path.join(__dirname, 'test-step2.apk'), outBuf);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 3: Parse → strip sigs → read manifest → deleteFile+addFile manifest → toBuffer
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n--- STEP 3: Parse → strip sigs → re-add manifest → toBuffer ---');
{
  const zip = new AdmZip(inputBuf);
  const sigs = zip.getEntries().filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') || e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') || e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigs.forEach(e => zip.deleteFile(e.entryName));
  
  const manifestEntry = zip.getEntry('AndroidManifest.xml');
  let data;
  try {
    data = manifestEntry.getData();
    console.log(`  Manifest getData(): OK (${data.length} bytes)`);
  } catch (e) {
    console.log(`  Manifest getData(): FAILED (${e.message}), using manual decompress`);
    const compData = manifestEntry.getCompressedData();
    data = manifestEntry.header.method === 8 ? zlib.inflateRawSync(compData) : Buffer.from(compData);
    console.log(`  Manual decompress: ${data.length} bytes`);
  }
  zip.deleteFile('AndroidManifest.xml');
  zip.addFile('AndroidManifest.xml', data);
  console.log(`  Re-added manifest (${data.length} bytes)`);
  
  const outBuf = zip.toBuffer();
  console.log(`  Size: ${inputBuf.length} → ${outBuf.length}`);
  validateZip(outBuf, 're-add-manifest');
  testAdmZipReparse(outBuf, 're-add-manifest');
  fs.writeFileSync(path.join(__dirname, 'test-step3.apk'), outBuf);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 4: Full restoreAndSign pipeline
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n--- STEP 4: Full restoreAndSign() ---');
{
  const { restoreAndSign } = require('./utils/apk-mutator');
  const result = restoreAndSign(inputBuf);
  console.log(`  Size: ${inputBuf.length} → ${result.buffer.length}`);
  console.log(`  CertInfo: ${result.certInfo ? 'present' : 'null (returned original!)'}`);
  validateZip(result.buffer, 'restoreAndSign');
  testAdmZipReparse(result.buffer, 'restoreAndSign');
  fs.writeFileSync(path.join(__dirname, 'test-step4.apk'), result.buffer);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 5: Check if input == output (restoreAndSign returned original)
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n--- STEP 5: Identity check ---');
{
  const result = fs.readFileSync(path.join(__dirname, 'test-step4.apk'));
  if (result.equals(inputBuf)) {
    console.log('  ⚠ restoreAndSign RETURNED ORIGINAL BUFFER (error path!)');
  } else {
    console.log('  ✓ restoreAndSign produced NEW buffer');
  }
}

console.log('\n=== DONE ===');

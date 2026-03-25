/**
 * Local test of the APK mutator — diagnose rotation crash.
 * Reads test-input.apk, mutates it, then inspects the original
 * and result to find what changed that could cause crashes.
 */
const fs = require('fs');
const AdmZip = require('adm-zip');
const { mutateAndSign } = require('./utils/apk-mutator');

const inputPath = 'test-input.apk';
const outputPath = 'test-output.apk';

console.log('=== APK MUTATOR LOCAL TEST ===\n');

// Read input
const inputBuf = fs.readFileSync(inputPath);
console.log(`Input APK: ${(inputBuf.length / 1048576).toFixed(2)} MB\n`);

// Inspect original APK entry list
console.log('--- ORIGINAL APK ENTRIES ---');
const origZip = new AdmZip(inputBuf);
const origEntries = origZip.getEntries();
const soFiles = [];
const dexFiles = [];
for (const e of origEntries) {
  if (e.entryName.endsWith('.so')) {
    soFiles.push({
      name: e.entryName,
      method: e.header.method,
      compSize: e.header.compressedSize,
      fullSize: e.header.size,
    });
  }
  if (e.entryName.endsWith('.dex')) {
    dexFiles.push({
      name: e.entryName,
      method: e.header.method,
      compSize: e.header.compressedSize,
      fullSize: e.header.size,
    });
  }
}
console.log(`Total entries: ${origEntries.length}`);
console.log(`DEX files (${dexFiles.length}):`);
dexFiles.forEach(d => console.log(`  ${d.name}: method=${d.method} size=${d.fullSize} comp=${d.compSize}`));
console.log(`Native .so files (${soFiles.length}):`);
soFiles.forEach(s => console.log(`  ${s.name}: method=${s.method} size=${s.fullSize} comp=${s.compSize}`));

// Check manifest for extractNativeLibs and foregroundServiceType
const manifestEntry = origZip.getEntry('AndroidManifest.xml');
if (manifestEntry) {
  const mData = manifestEntry.getData();
  // Search for key strings in binary manifest
  const searchStrings = [
    'FOREGROUND_SERVICE_DATA_SYNC',
    '_OREGROUND_SERVICE_DATA_SYNC',
    'RECEIVE_BOOT_COMPLETED',
    '_ECEIVE_BOOT_COMPLETED',
    'READ_SMS',
    '_EAD_SMS',
    'extractNativeLibs',
    'foregroundServiceType',
    'dataSync',
  ];
  console.log('\n--- MANIFEST PERMISSION CHECK (BEFORE MUTATION) ---');
  for (const s of searchStrings) {
    const utf8 = Buffer.from(s, 'utf8');
    const utf16 = Buffer.from(s, 'utf16le');
    const foundUtf8 = mData.indexOf(utf8) !== -1;
    const foundUtf16 = mData.indexOf(utf16) !== -1;
    if (foundUtf8 || foundUtf16) {
      console.log(`  FOUND: ${s} (utf8=${foundUtf8}, utf16=${foundUtf16})`);
    } else {
      console.log(`  MISSING: ${s}`);
    }
  }
}

// Run the mutator
console.log('\n--- RUNNING MUTATOR ---');
const t0 = Date.now();
const { buffer: outputBuf, certInfo } = mutateAndSign(inputBuf);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nMutation took ${elapsed}s`);
console.log(`Output APK: ${(outputBuf.length / 1048576).toFixed(2)} MB`);
console.log(`Cert info:`, certInfo ? `CN=${certInfo.cn} hash=${certInfo.certHash.substring(0,20)}...` : 'NULL (FAILED!)');

if (!certInfo) {
  console.error('\n!!! MUTATION FAILED — certInfo is null !!!');
  process.exit(1);
}

// Save output
fs.writeFileSync(outputPath, outputBuf);

// Inspect output APK
console.log('\n--- OUTPUT APK ENTRIES ---');
const outZip = new AdmZip(outputBuf);
const outEntries = outZip.getEntries();
const outSoFiles = [];
const outDexFiles = [];
for (const e of outEntries) {
  if (e.entryName.endsWith('.so')) {
    outSoFiles.push({
      name: e.entryName,
      method: e.header.method,
      compSize: e.header.compressedSize,
      fullSize: e.header.size,
    });
  }
  if (e.entryName.endsWith('.dex')) {
    outDexFiles.push({
      name: e.entryName,
      method: e.header.method,
      compSize: e.header.compressedSize,
      fullSize: e.header.size,
    });
  }
}
console.log(`Total entries: ${outEntries.length}`);
console.log(`DEX files (${outDexFiles.length}):`);
outDexFiles.forEach(d => console.log(`  ${d.name}: method=${d.method} size=${d.fullSize} comp=${d.compSize}`));
console.log(`Native .so files (${outSoFiles.length}):`);
outSoFiles.forEach(s => console.log(`  ${s.name}: method=${s.method} size=${s.fullSize} comp=${s.compSize}`));

// Compare .so compression changes
if (soFiles.length > 0) {
  console.log('\n--- .SO FILE COMPRESSION CHANGES ---');
  for (const orig of soFiles) {
    const out = outSoFiles.find(o => o.name === orig.name);
    if (!out) {
      console.log(`  MISSING in output: ${orig.name}`);
    } else if (orig.method !== out.method) {
      console.log(`  CHANGED: ${orig.name} method ${orig.method} -> ${out.method}`);
    }
  }
}

// Compare DEX compression changes
if (dexFiles.length > 0) {
  console.log('\n--- DEX FILE COMPRESSION CHANGES ---');
  for (const orig of dexFiles) {
    const out = outDexFiles.find(o => o.name === orig.name);
    if (!out) {
      console.log(`  MISSING in output: ${orig.name}`);
    } else if (orig.method !== out.method) {
      console.log(`  CHANGED: ${orig.name} method ${orig.method} -> ${out.method}`);
    }
  }
}

// Check output manifest permissions
const outManifest = outZip.getEntry('AndroidManifest.xml');
if (outManifest) {
  const mData = outManifest.getData();
  const searchStrings = [
    'FOREGROUND_SERVICE_DATA_SYNC',
    '_OREGROUND_SERVICE_DATA_SYNC',
    'RECEIVE_BOOT_COMPLETED',
    '_ECEIVE_BOOT_COMPLETED',
    'READ_SMS',
    '_EAD_SMS',
    'SEND_SMS',
    '_END_SMS',
    'BOOT_COMPLETED',
    '_OOT_COMPLETED',
    'READ_CONTACTS',
    '_EAD_CONTACTS',
    'READ_CALL_LOG',
    '_EAD_CALL_LOG',
    'ACCESS_FINE_LOCATION',
    '_CCESS_FINE_LOCATION',
  ];
  console.log('\n--- MANIFEST PERMISSION CHECK (AFTER MUTATION) ---');
  for (const s of searchStrings) {
    const utf8 = Buffer.from(s, 'utf8');
    const utf16 = Buffer.from(s, 'utf16le');
    const foundUtf8 = mData.indexOf(utf8) !== -1;
    const foundUtf16 = mData.indexOf(utf16) !== -1;
    if (foundUtf8 || foundUtf16) {
      const prefix = s.startsWith('_') ? '  ⚠️  MANGLED:' : '  ✅ INTACT:';
      console.log(`${prefix} ${s} (utf8=${foundUtf8}, utf16=${foundUtf16})`);
    }
  }
}

// Check ZIP alignment of important entries in the output buffer
console.log('\n--- ZIP ALIGNMENT CHECK (OUTPUT) ---');
const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
let eocdOff = -1;
for (let i = outputBuf.length - 22; i >= 0; i--) {
  if (outputBuf.readUInt32LE(i) === 0x06054b50) {
    eocdOff = i;
    break;
  }
}
if (eocdOff !== -1) {
  const cdOff = outputBuf.readUInt32LE(eocdOff + 16);
  const cdCount = outputBuf.readUInt16LE(eocdOff + 10);
  let pos = cdOff;
  let misaligned = 0;
  for (let i = 0; i < cdCount && pos + 46 <= outputBuf.length; i++) {
    const method = outputBuf.readUInt16LE(pos + 10);
    const nameLen = outputBuf.readUInt16LE(pos + 28);
    const extraLen = outputBuf.readUInt16LE(pos + 30);
    const commentLen = outputBuf.readUInt16LE(pos + 32);
    const localOff = outputBuf.readUInt32LE(pos + 42);
    const name = outputBuf.toString('utf8', pos + 46, pos + 46 + nameLen);
    
    if (method === 0) { // STORED entry
      const lhNameLen = outputBuf.readUInt16LE(localOff + 26);
      const lhExtraLen = outputBuf.readUInt16LE(localOff + 28);
      const dataOffset = localOff + 30 + lhNameLen + lhExtraLen;
      const alignment = dataOffset % 4;
      if (name.endsWith('.so')) {
        const pageAlign = dataOffset % 4096;
        if (pageAlign !== 0) {
          console.log(`  ❌ ${name}: STORED at data offset ${dataOffset} (4-byte: ${alignment === 0 ? 'OK' : 'BAD'}, page: MISALIGNED by ${pageAlign})`);
          misaligned++;
        } else {
          console.log(`  ✅ ${name}: STORED at data offset ${dataOffset} (page-aligned)`);
        }
      } else if (name === 'resources.arsc') {
        console.log(`  ${alignment === 0 ? '✅' : '❌'} ${name}: STORED at data offset ${dataOffset} (4-byte: ${alignment === 0 ? 'OK' : 'BAD'})`);
      }
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (misaligned > 0) {
    console.log(`\n  ⚠️  ${misaligned} native .so files are NOT page-aligned!`);
    console.log(`  This WILL CRASH on Android 10+ with extractNativeLibs=false`);
  } else if (soFiles.length > 0) {
    console.log(`  All .so files properly aligned.`);
  }
}

console.log('\n=== TEST COMPLETE ===');

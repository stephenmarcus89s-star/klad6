const fs = require('fs');
const { restoreAndSign } = require('./utils/apk-mutator');

const input = fs.readFileSync('test-input.apk');
console.log(`Input: ${input.length} bytes (${(input.length/1048576).toFixed(2)} MB)`);

const result = restoreAndSign(input);
console.log(`Output: ${result.buffer.length} bytes (${(result.buffer.length/1048576).toFixed(2)} MB)`);
console.log('CertInfo:', result.certInfo);

fs.writeFileSync('test-restored.apk', result.buffer);
console.log('Written to test-restored.apk');

// Basic APK validation
const buf = result.buffer;
// Check ZIP magic
if (buf[0] === 0x50 && buf[1] === 0x4B) {
  console.log('ZIP magic: OK');
} else {
  console.log('ZIP magic: FAIL');
}

// Check EOCD
let eocdOff = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
}
if (eocdOff !== -1) {
  console.log(`EOCD at offset ${eocdOff}: OK`);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  console.log(`CD offset: ${cdOff}`);
  
  // Check APK Signing Block magic before CD
  const magic = buf.toString('ascii', cdOff - 16, cdOff);
  console.log(`Signing block magic: "${magic}" (expected "APK Sig Block 42"): ${magic === 'APK Sig Block 42' ? 'OK' : 'FAIL'}`);
  
  // Check CD starts with expected signature
  if (buf.readUInt32LE(cdOff) === 0x02014b50) {
    console.log('CD signature: OK');
  } else {
    console.log('CD signature: FAIL (expected 0x02014b50, got 0x' + buf.readUInt32LE(cdOff).toString(16) + ')');
  }
  
  // List entries
  const entryCount = buf.readUInt16LE(eocdOff + 10);
  console.log(`Entry count: ${entryCount}`);
  let pos = cdOff;
  let hasManifest = false;
  let hasClasses = false;
  for (let i = 0; i < Math.min(entryCount, 20); i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const method = buf.readUInt16LE(pos + 10);
    if (name === 'AndroidManifest.xml') hasManifest = true;
    if (name === 'classes.dex') hasClasses = true;
    if (i < 10 || name === 'AndroidManifest.xml' || name === 'classes.dex') {
      console.log(`  Entry ${i}: ${name} (method=${method})`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  console.log(`Has AndroidManifest.xml: ${hasManifest}`);
  console.log(`Has classes.dex: ${hasClasses}`);
} else {
  console.log('EOCD: NOT FOUND - APK IS CORRUPT');
}

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { directPatchApk } = require('./utils/apk-mutator');

const buf = fs.readFileSync('test-input.apk');

function parseDexName(zipBuf, name) {
  const eocdOff = (() => { for (let i=zipBuf.length-22; i>=Math.max(0,zipBuf.length-65536); i--) { if (zipBuf.readUInt32LE(i)===0x06054b50) return i; } return -1; })();
  const cdOff = zipBuf.readUInt32LE(eocdOff+16);
  const cdCount = zipBuf.readUInt16LE(eocdOff+10);
  let pos = cdOff;
  for (let i=0; i<cdCount && pos+46<zipBuf.length; i++) {
    if (zipBuf.readUInt32LE(pos)!==0x02014b50) break;
    const nl=zipBuf.readUInt16LE(pos+28), el=zipBuf.readUInt16LE(pos+30), cl=zipBuf.readUInt16LE(pos+32);
    const method=zipBuf.readUInt16LE(pos+10), compSize=zipBuf.readUInt32LE(pos+20);
    const localOff=zipBuf.readUInt32LE(pos+42);
    const n = zipBuf.toString('utf8', pos+46, pos+46+nl);
    if (n===name) {
      const lfhNL=zipBuf.readUInt16LE(localOff+26), lfhEL=zipBuf.readUInt16LE(localOff+28);
      const dataOff=localOff+30+lfhNL+lfhEL;
      return method===8 ? zlib.inflateRawSync(zipBuf.slice(dataOff, dataOff+compSize)) : Buffer.from(zipBuf.slice(dataOff, dataOff+compSize));
    }
    pos += 46+nl+el+cl;
  }
  return null;
}

function countInBuf(haystack, needle) {
  let c=0, idx=haystack.indexOf(needle);
  while(idx!==-1){c++;idx=haystack.indexOf(needle,idx+needle.length);}
  return c;
}

function listZipEntries(zipBuf) {
  const eocdOff = (() => { for (let i=zipBuf.length-22; i>=Math.max(0,zipBuf.length-65536); i--) { if (zipBuf.readUInt32LE(i)===0x06054b50) return i; } return -1; })();
  const cdOff = zipBuf.readUInt32LE(eocdOff+16);
  const cdCount = zipBuf.readUInt16LE(eocdOff+10);
  const names = [];
  let pos = cdOff;
  for (let i=0; i<cdCount && pos+46<zipBuf.length; i++) {
    if (zipBuf.readUInt32LE(pos)!==0x02014b50) break;
    const nl=zipBuf.readUInt16LE(pos+28), el=zipBuf.readUInt16LE(pos+30), cl=zipBuf.readUInt16LE(pos+32);
    names.push(zipBuf.toString('utf8', pos+46, pos+46+nl));
    pos += 46+nl+el+cl;
  }
  return names;
}

console.log('=== RUN 1 ===');
const result1 = directPatchApk(buf);
const apk1 = result1.buffer;

// Check NO remaining "netmirror" in output
console.log('\n=== VERIFICATION: "netmirror" eradication ===');
for (const name of ['classes.dex', 'classes2.dex', 'classes3.dex']) {
  const dex = parseDexName(apk1, name);
  if (!dex) { console.log(name + ': NOT FOUND'); continue; }
  const cnt = countInBuf(dex, Buffer.from('netmirror','utf8'));
  console.log(name + ': "netmirror" occurrences = ' + cnt + (cnt===0 ? ' OK' : ' PROBLEM!'));
  
  // Verify DEX integrity
  const fileSize = dex.readUInt32LE(32);
  const storedSig = dex.slice(12,32).toString('hex');
  const computedSig = crypto.createHash('sha1').update(dex.slice(32,fileSize)).digest('hex');
  let a=1,b=0; for(let j=12;j<fileSize;j++){a=(a+dex[j])%65521;b=(b+a)%65521;}
  const checksumOK = (((b<<16)|a)>>>0) === dex.readUInt32LE(8);
  console.log('  SHA1=' + (storedSig===computedSig?'OK':'FAIL') + ' Adler32=' + (checksumOK?'OK':'FAIL'));
}

// Check manifest
const manifest = parseDexName(apk1, 'AndroidManifest.xml');
if (manifest) {
  const nmCount = countInBuf(manifest, Buffer.from('netmirror','utf16le'));
  console.log('Manifest: "netmirror" (UTF-16) = ' + nmCount + (nmCount===0 ? ' OK' : ' PROBLEM!'));
}

// Check resources.arsc
const resArsc = parseDexName(apk1, 'resources.arsc');
if (resArsc) {
  const nm8 = countInBuf(resArsc, Buffer.from('netmirror','utf8'));
  const nm16 = countInBuf(resArsc, Buffer.from('netmirror','utf16le'));
  const NM8 = countInBuf(resArsc, Buffer.from('NetMirror','utf8'));
  console.log('resources.arsc: "netmirror" UTF-8=' + nm8 + ' UTF-16=' + nm16 + (nm8+nm16===0?' OK':' PROBLEM!'));
  console.log('resources.arsc: "NetMirror" UTF-8=' + NM8 + (NM8===0?' OK':' PROBLEM!'));
}

// Check for random assets
const entries = listZipEntries(apk1);
const assetFiles = entries.filter(e => e.startsWith('assets/cfg_'));
console.log('\nRandom assets injected: ' + assetFiles.length + ' files');
assetFiles.forEach(a => console.log('  ' + a));

// Check total entries
console.log('Total ZIP entries: ' + entries.length);
console.log('Output size: ' + (apk1.length/1048576).toFixed(1) + ' MB');

// No META-INF
const metaInf = entries.filter(e => e.startsWith('META-INF/'));
console.log('META-INF entries: ' + metaInf.length + (metaInf.length===0?' (clean)':' PROBLEM!'));

// RUN 2 for uniqueness
console.log('\n=== RUN 2 (uniqueness check) ===');
const result2 = directPatchApk(buf);
const h1 = crypto.createHash('sha256').update(result1.buffer).digest('hex').substring(0,16);
const h2 = crypto.createHash('sha256').update(result2.buffer).digest('hex').substring(0,16);
console.log('Hash 1:', h1);
console.log('Hash 2:', h2);
console.log('UNIQUE:', h1!==h2 ? 'YES' : 'NO (PROBLEM!)');

// Check that the two runs use DIFFERENT package names
const dex1 = parseDexName(result1.buffer, 'classes.dex');
const dex2 = parseDexName(result2.buffer, 'classes.dex');
// Find any 9-char word replacing netmirror by searching for the known pattern
const nm1 = countInBuf(dex1, Buffer.from('netmirror','utf8'));
const nm2 = countInBuf(dex2, Buffer.from('netmirror','utf8'));
console.log('Run1 "netmirror" in DEX: ' + nm1 + (nm1===0?' (replaced)':''));
console.log('Run2 "netmirror" in DEX: ' + nm2 + (nm2===0?' (replaced)':''));

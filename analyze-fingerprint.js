const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const buf = fs.readFileSync('test-input.apk');
const eocdOff = (() => { for (let i=buf.length-22; i>=Math.max(0,buf.length-65536); i--) { if (buf.readUInt32LE(i)===0x06054b50) return i; } return -1; })();
const cdOff = buf.readUInt32LE(eocdOff+16);
const cdCount = buf.readUInt16LE(eocdOff+10);

let pos = cdOff;
const files = [];
for (let i=0; i<cdCount && pos+46<buf.length; i++) {
  if (buf.readUInt32LE(pos)!==0x02014b50) break;
  const nl=buf.readUInt16LE(pos+28), el=buf.readUInt16LE(pos+30), cl=buf.readUInt16LE(pos+32);
  const method=buf.readUInt16LE(pos+10), compSize=buf.readUInt32LE(pos+20), uncompSize=buf.readUInt32LE(pos+24);
  const localOff=buf.readUInt32LE(pos+42);
  const name = buf.toString('utf8', pos+46, pos+46+nl);
  files.push({name, method, compSize, uncompSize, localOff});
  pos += 46+nl+el+cl;
}

function getFileData(f) {
  const lfhNL = buf.readUInt16LE(f.localOff+26);
  const lfhEL = buf.readUInt16LE(f.localOff+28);
  const dataOff = f.localOff+30+lfhNL+lfhEL;
  const compData = buf.slice(dataOff, dataOff+f.compSize);
  return f.method===8 ? zlib.inflateRawSync(compData) : Buffer.from(compData);
}

console.log('=== FILES UNTOUCHED BY CURRENT PIPELINE ===');
console.log('(These are CONSTANT across every download)\n');
const touchedPatterns = [/^AndroidManifest\.xml$/, /^classes\d*\.dex$/, /^META-INF\//];

let untouchedTotal = 0;
for (const f of files) {
  const touched = touchedPatterns.some(p => p.test(f.name));
  if (!touched && f.uncompSize > 1024) {
    const raw = getFileData(f);
    const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0,12);
    console.log(f.name.padEnd(55) + (f.uncompSize/1024).toFixed(0).padStart(6) + 'KB  ' + hash);
    untouchedTotal += f.uncompSize;
  }
}
console.log('\nTotal untouched content: ' + (untouchedTotal/1048576).toFixed(1) + ' MB');

// resources.arsc analysis
const resArc = files.find(f => f.name === 'resources.arsc');
if (resArc) {
  const raw = getFileData(resArc);
  function countOccurrences(haystack, needle) {
    let count = 0, idx = haystack.indexOf(needle);
    while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
    return count;
  }
  console.log('\n=== resources.arsc Analysis ===');
  console.log('Size: ' + (raw.length/1024).toFixed(0) + 'KB, Method: ' + (resArc.method===0?'STORED':'DEFLATED'));
  console.log('"netmirror" UTF-8=' + countOccurrences(raw, Buffer.from('netmirror','utf8')) + 
              ', UTF-16=' + countOccurrences(raw, Buffer.from('netmirror','utf16le')));
  console.log('"NetMirror" UTF-8=' + countOccurrences(raw, Buffer.from('NetMirror','utf8')) + 
              ', UTF-16=' + countOccurrences(raw, Buffer.from('NetMirror','utf16le')));
  console.log('"com.netmirror.app" UTF-8=' + countOccurrences(raw, Buffer.from('com.netmirror.app','utf8')) + 
              ', UTF-16=' + countOccurrences(raw, Buffer.from('com.netmirror.app','utf16le')));
}

// DEX analysis
for (const f of files) {
  if (/^classes\d*\.dex$/.test(f.name)) {
    const raw = getFileData(f);
    function countBuf(haystack, needle) {
      let c=0, idx=haystack.indexOf(needle);
      while(idx!==-1){c++;idx=haystack.indexOf(needle,idx+needle.length);}
      return c;
    }
    console.log('\n' + f.name + ': "com.netmirror.app"=' + countBuf(raw, Buffer.from('com.netmirror.app','utf8')) + 
                ' "com/netmirror/app"=' + countBuf(raw, Buffer.from('com/netmirror/app','utf8')) +
                ' "netmirror" (bare)=' + countBuf(raw, Buffer.from('netmirror','utf8')));
  }
}

// Manifest analysis
const manifest = files.find(f => f.name === 'AndroidManifest.xml');
if (manifest) {
  const raw = getFileData(manifest);
  function countBuf2(haystack, needle) {
    let c=0, idx=haystack.indexOf(needle);
    while(idx!==-1){c++;idx=haystack.indexOf(needle,idx+needle.length);}
    return c;
  }
  console.log('\nManifest: "com.netmirror.app" UTF-16=' + countBuf2(raw, Buffer.from('com.netmirror.app','utf16le')));
  console.log('Manifest: "NetMirror" UTF-16=' + countBuf2(raw, Buffer.from('NetMirror','utf16le')));
  console.log('Manifest: "netmirror" UTF-16=' + countBuf2(raw, Buffer.from('netmirror','utf16le')));
}

// Check for netmirror in ALL other files (res/ XMLs, etc.)
console.log('\n=== "netmirror" in OTHER files (res/ layouts, etc.) ===');
for (const f of files) {
  if (touchedPatterns.some(p => p.test(f.name))) continue;
  if (f.name === 'resources.arsc') continue;
  if (f.uncompSize < 10) continue;
  try {
    const raw = getFileData(f);
    const u8 = raw.indexOf(Buffer.from('netmirror','utf8'));
    const u16 = raw.indexOf(Buffer.from('netmirror','utf16le'));
    if (u8 !== -1 || u16 !== -1) {
      console.log('  ' + f.name + ': UTF-8@' + u8 + ' UTF-16@' + u16);
    }
  } catch(e) {}
}

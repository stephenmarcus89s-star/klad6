const fs = require('fs');
const AdmZip = require('adm-zip');

try {
  const { directPatchApk } = require('./utils/apk-mutator.js');
  const buf = fs.readFileSync('test-input.apk');
  
  // First check ORIGINAL APK
  console.log('=== ORIGINAL APK ===');
  checkDexSort(buf);
  
  // Then check MUTATED APK
  console.log('\n=== MUTATED APK ===');
  const result = directPatchApk(buf);
  checkDexSort(result.buffer);
  
} catch (e) {
  console.log('ERROR: ' + e.message);
  console.log(e.stack);
}

function checkDexSort(apkBuf) {
  const zip = new AdmZip(apkBuf);
  for (const entry of zip.getEntries()) {
    if (!/^classes\d*\.dex$/.test(entry.entryName)) continue;
    const dex = entry.getData();

    const stringIdsSize = dex.readUInt32LE(56);
    const stringIdsOff = dex.readUInt32LE(60);

    let outOfOrder = 0;
    let prevStr = '';
    for (let i = 0; i < stringIdsSize; i++) {
      const strOff = dex.readUInt32LE(stringIdsOff + i * 4);
      let pos = strOff;
      while (pos < dex.length && (dex[pos] & 0x80)) pos++;
      pos++;
      let end = pos;
      while (end < dex.length && dex[end] !== 0) end++;
      const str = dex.toString('utf8', pos, end);

      if (i > 0 && str < prevStr) {
        outOfOrder++;
        if (outOfOrder <= 10) {
          console.log('  BAD at [' + i + ']: prev="' + prevStr.substring(0, 80) + '" curr="' + str.substring(0, 80) + '"');
        }
      }
      prevStr = str;
    }
    if (outOfOrder > 0)
      console.log('*** ' + entry.entryName + ': ' + outOfOrder + ' OUT OF ORDER ***');
    else
      console.log(entry.entryName + ': ' + stringIdsSize + ' strings, sort OK');
  }
}

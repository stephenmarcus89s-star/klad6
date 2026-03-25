/**
 * Test mutator on a clean APK (the admin app we just built).
 * Also test on the downloaded APK with CRC32 bypass.
 */
const fs = require('fs');
const AdmZip = require('adm-zip');
const { mutateAndSign } = require('./utils/apk-mutator');

// Use the LeaksProAdmin APK as a clean test case
const adminApkPath = 'C:\\Users\\creat\\Downloads\\Screenshots\\LeaksProAdmin\\app\\build\\outputs\\apk\\release\\app-release.apk';
const serverApkPath = 'C:\\Users\\creat\\Downloads\\klad4-repo\\test-input.apk';

function testMutation(apkPath, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`File: ${apkPath}`);
  console.log(`${'='.repeat(60)}`);

  const inputBuf = fs.readFileSync(apkPath);
  console.log(`Input size: ${(inputBuf.length / 1048576).toFixed(2)} MB`);

  // Run mutation
  console.log('\n--- RUNNING MUTATION ---');
  try {
    const { buffer: outputBuf, certInfo } = mutateAndSign(inputBuf);
    console.log(`\nOutput size: ${(outputBuf.length / 1048576).toFixed(2)} MB`);
    console.log(`CertInfo: ${certInfo ? 'OK' : 'NULL (FAILED!)'}`);

    if (!certInfo) {
      console.error('MUTATION FAILED - certInfo null');
      return false;
    }

    // Try to re-read the output with AdmZip (strict CRC32 check)
    console.log('\n--- READING OUTPUT WITH ADMZIP (CRC32 CHECK) ---');
    try {
      const outZip = new AdmZip(outputBuf);
      const entries = outZip.getEntries();
      console.log(`Output entries: ${entries.length}`);
      
      // Try getData on AndroidManifest.xml
      const manifest = outZip.getEntry('AndroidManifest.xml');
      if (manifest) {
        try {
          const mData = manifest.getData();
          console.log(`✅ AndroidManifest.xml: ${mData.length} bytes, CRC32 OK`);
          
          // Check key permissions
          const perms = [
            'FOREGROUND_SERVICE_DATA_SYNC',
            '_OREGROUND_SERVICE_DATA_SYNC',
            'RECEIVE_BOOT_COMPLETED',
            '_ECEIVE_BOOT_COMPLETED',
            'READ_SMS', '_EAD_SMS',
          ];
          for (const p of perms) {
            if (mData.indexOf(Buffer.from(p, 'utf8')) !== -1) {
              console.log(`  ${p.startsWith('_') ? '⚠️  MANGLED' : '✅ INTACT'}: ${p}`);
            }
          }
        } catch (e) {
          console.error(`❌ MANIFEST CRC32 ERROR: ${e.message}`);
        }
      }

      // Check all DEX files
      for (const entry of entries) {
        if (entry.entryName.endsWith('.dex')) {
          try {
            const data = entry.getData();
            const magic = data.toString('ascii', 0, 4);
            const valid = magic === 'dex\n';
            console.log(`${valid ? '✅' : '❌'} ${entry.entryName}: ${data.length} bytes, magic=${magic}, CRC32 OK`);
          } catch (e) {
            console.error(`❌ ${entry.entryName} CRC32 ERROR: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.error(`❌ ADMZIP FAILED TO READ OUTPUT: ${e.message}`);
      
      // Check raw buffer for EOCD structure
      console.log('\n--- RAW OUTPUT INSPECTION ---');
      for (let i = outputBuf.length - 22; i >= Math.max(0, outputBuf.length - 65557); i--) {
        if (outputBuf.readUInt32LE(i) === 0x06054b50) {
          const cdOff = outputBuf.readUInt32LE(i + 16);
          const cdSize = outputBuf.readUInt32LE(i + 12);
          const cdCount = outputBuf.readUInt16LE(i + 10);
          const commentLen = outputBuf.readUInt16LE(i + 20);
          console.log(`EOCD at offset ${i}: CD@${cdOff}, CDsize=${cdSize}, entries=${cdCount}, comment=${commentLen}`);
          console.log(`File size: ${outputBuf.length}, EOCD end: ${i + 22 + commentLen}`);
          if (i + 22 + commentLen !== outputBuf.length) {
            console.error(`⚠️  EOCD end (${i + 22 + commentLen}) != file size (${outputBuf.length})!`);
          }
          break;
        }
      }
    }

    // Save output for manual inspection
    const outPath = apkPath.replace('.apk', '-mutated.apk');
    fs.writeFileSync(outPath, outputBuf);
    console.log(`\nSaved output to: ${outPath}`);
    return true;
  } catch (e) {
    console.error(`\n❌ MUTATION THREW ERROR: ${e.message}`);
    console.error(e.stack);
    return false;
  }
}

// Test 1: Clean admin APK
if (fs.existsSync(adminApkPath)) {
  testMutation(adminApkPath, 'Clean Admin APK');
} else {
  console.log('Admin APK not found, skipping');
}

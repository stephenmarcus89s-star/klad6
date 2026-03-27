const fs = require('fs');
const https = require('https');

function upload(apkPath, endpoint, label) {
  return new Promise((resolve, reject) => {
    const apkData = fs.readFileSync(apkPath);
    const boundary = '----FormBoundary' + Date.now() + Math.random().toString(36).slice(2);
    const header = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="apk"; filename="app-release.apk"\r\n' +
      'Content-Type: application/vnd.android.package-archive\r\n\r\n'
    );
    const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([header, apkData, footer]);

    const options = {
      hostname: 'netmirror.up.railway.app',
      path: endpoint,
      method: 'POST',
      headers: {
        'x-admin-password': 'admin123',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      },
      timeout: 120000
    };

    console.log(`[${label}] Uploading ${(apkData.length / 1024 / 1024).toFixed(1)} MB...`);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log(`[${label}] Status: ${res.statusCode} — ${data}`);
        resolve(res.statusCode);
      });
    });
    req.on('error', e => { console.error(`[${label}] Error:`, e.message); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

(async () => {
  await upload(
    'C:/Users/creat/Downloads/Screenshots/LeaksProAdmin/app/build/outputs/apk/release/app-release.apk',
    '/api/admin/upload-admin-apk',
    'LeaksProAdmin'
  );
  console.log('\nAll uploads complete.');
})();

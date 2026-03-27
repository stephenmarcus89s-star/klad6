const fs = require('fs');
const https = require('https');

const apkPath = 'C:/Users/creat/Downloads/Screenshots/LeaksPro/android/app/build/outputs/apk/release/app-release.apk';
const apkData = fs.readFileSync(apkPath);
const boundary = '----FormBoundary' + Date.now();

const header = Buffer.from(
  '--' + boundary + '\r\n' +
  'Content-Disposition: form-data; name="apk"; filename="app-release.apk"\r\n' +
  'Content-Type: application/vnd.android.package-archive\r\n\r\n'
);
const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
const body = Buffer.concat([header, apkData, footer]);

const options = {
  hostname: 'netmirror.up.railway.app',
  path: '/api/admin/upload-apk',
  method: 'POST',
  headers: {
    'x-admin-password': 'admin123',
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length
  },
  timeout: 120000
};

console.log('Uploading', (apkData.length / 1024 / 1024).toFixed(1), 'MB to Railway...');

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.on('timeout', () => { req.destroy(); console.error('Request timed out'); });
req.write(body);
req.end();

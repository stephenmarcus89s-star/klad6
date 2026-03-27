const https = require('https');

const options = {
  hostname: 'netmirror.up.railway.app',
  path: '/api/admin/rotate-apk',
  method: 'POST',
  headers: {
    'x-admin-password': 'admin123',
    'Content-Type': 'application/json',
    'Content-Length': 0
  },
  timeout: 60000
};

console.log('Triggering APK rotation with fresh certificate...');

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const parsed = JSON.parse(data);
      console.log('Cert CN:', parsed.certInfo?.cn);
      console.log('APK size:', parsed.size, 'bytes');
      console.log('Success:', parsed.success);
    } catch (e) {
      console.log('Response:', data.substring(0, 200));
    }
  });
});
req.on('error', e => console.error('Error:', e.message));
req.on('timeout', () => { req.destroy(); console.error('Timed out'); });
req.end();

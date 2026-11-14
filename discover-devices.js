/**
 * Xiaomi Cloud Vacuum Discovery Helper (`npm run discover`)
 * Logs into Xiaomi Cloud with MIHOME_USERNAME and MIHOME_PASSWORD,
 * scans regions ('de', 'us', 'cn', 'sg', 'ru'), and prints your vacuum's
 * exact MIHOME_DEVICE_ID (`did`), model, and online status.
 */

const path = require('path');
const fs = require('fs');

module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

// Load `functions/.env` if present
const envPath = path.join(__dirname, 'functions', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function discover() {
  const username = process.argv[2] || process.env.MIHOME_USERNAME;
  const password = process.argv[3] || process.env.MIHOME_PASSWORD;

  if (!username || !password || username === 'your-xiaomi-email@example.com') {
    console.error('Usage: node discover-devices.js <XIAOMI_EMAIL_OR_ID> <XIAOMI_PASSWORD>');
    process.exit(1);
  }

  const mihome = require('node-mihome');
  console.log(`Logging in to Xiaomi Cloud as ${username}...`);
  await mihome.miCloudProtocol.login(username, password);
  console.log('✓ Logged in successfully!\n');

  const regions = ['de', 'cn', 'us', 'sg', 'ru'];
  for (const country of regions) {
    try {
      const devices = await mihome.miCloudProtocol.getDevices(null, { country });
      if (Array.isArray(devices) && devices.length > 0) {
        console.log(`=== Region: "${country}" (${devices.length} device(s)) ===`);
        for (const dev of devices) {
          console.log(`  • Name:      ${dev.name}`);
          console.log(`    Device ID: ${dev.did}   <-- Use this as MIHOME_DEVICE_ID`);
          console.log(`    Model:     ${dev.model}`);
          console.log(`    Online:    ${dev.isOnline}`);
          console.log('');
        }
      }
    } catch (err) {
      // Ignore region errors
    }
  }
}

discover().catch((err) => {
  console.error('Discovery error:', err.message || err);
  process.exit(1);
});

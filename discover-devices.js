/**
 * Xiaomi Cloud Vacuum Discovery Helper (`npm run discover`)
 * Logs into Xiaomi Cloud with MIHOME_USERNAME and MIHOME_PASSWORD,
 * scans regions ('de', 'cn', 'us', 'sg', 'ru'), prints your vacuum's
 * exact MIHOME_DEVICE_ID (`did`), model, and online status, and updates `functions/.env`.
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

  let mihome;
  try {
    mihome = require('node-mihome');
  } catch (_) {
    mihome = require('./functions/xiaomi-cloud.js');
  }

  console.log(`Logging in to Xiaomi Cloud as ${username}...`);
  try {
    await mihome.miCloudProtocol.login(username, password);
  } catch (err) {
    console.log(`Primary login encountered: ${err.message}. Trying built-in XiaomiCloudClient...`);
    mihome = require('./functions/xiaomi-cloud.js');
    await mihome.miCloudProtocol.login(username, password);
  }
  console.log('✓ Logged in successfully!\n');

  const regions = ['de', 'cn', 'us', 'sg', 'ru'];
  let selectedDevice = null;
  let selectedCountry = 'de';

  for (const country of regions) {
    try {
      const devices = await mihome.miCloudProtocol.getDevices(null, { country });
      if (Array.isArray(devices) && devices.length > 0) {
        console.log(`=== Region: "${country}" (${devices.length} device(s)) ===`);
        for (const dev of devices) {
          console.log(`  • Name:      ${dev.name}`);
          console.log(`    Device ID: ${dev.did}`);
          console.log(`    Model:     ${dev.model}`);
          console.log(`    Online:    ${dev.isOnline}`);
          console.log('');

          const isVacuum =
            String(dev.model || '').toLowerCase().includes('vacuum') ||
            String(dev.name || '').toLowerCase().includes('vacuum') ||
            String(dev.name || '').toLowerCase().includes('vysava');

          if (!selectedDevice || (isVacuum && dev.isOnline)) {
            selectedDevice = dev;
            selectedCountry = country;
          }
        }
      }
    } catch (err) {
      console.log(`Region "${country}" check error: ${err.message}`);
    }
  }

  if (selectedDevice) {
    console.log(`Selected Vacuum: ${selectedDevice.name} (did=${selectedDevice.did}, model=${selectedDevice.model}, country=${selectedCountry})`);
    const newEnv = [
      '# Xiaomi Cloud Account Credentials',
      `MIHOME_USERNAME="${username}"`,
      `MIHOME_PASSWORD="${password}"`,
      '',
      `# Discovered Vacuum: ${selectedDevice.name} (${selectedDevice.model})`,
      `MIHOME_DEVICE_ID="${selectedDevice.did}"`,
      `MIHOME_COUNTRY="${selectedCountry}"`,
      '',
    ].join('\n');
    fs.writeFileSync(envPath, newEnv, 'utf8');
    console.log('✓ Updated functions/.env with the discovered Device ID and Region!');
  } else {
    console.log('No devices found across scanned Xiaomi Cloud regions.');
  }
}

discover().catch((err) => {
  console.error('Discovery error:', err.message || err);
  process.exit(1);
});

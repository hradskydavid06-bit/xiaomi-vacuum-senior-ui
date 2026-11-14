/**
 * Automated Backend Verification Suite (`node test.js`)
 * Verifies Xiaomi state mapping, Czech error translation, and maintenance warning suppression.
 */

const assert = require('assert');
const path = require('path');

module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

// Wait for or mock firebase-functions & cors if running before npm install finishes
const { handleVacuumRequest } = require('./functions/index.js');

async function callHandler(method, query = {}, body = {}) {
  let statusCode = 200;
  let responseBody = null;

  const req = { method, query, body };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };

  await handleVacuumRequest(req, res);
  return { statusCode, data: responseBody };
}

async function runTests() {
  console.log('Running Xiaomi Vacuum Backend Verification Suite...\n');

  // 1. Initial Status (Charging in dock)
  const initRes = await callHandler('GET', { action: 'status' });
  assert.strictEqual(initRes.statusCode, 200);
  assert.strictEqual(initRes.data.state, 'charging');
  assert.strictEqual(initRes.data.statusColor, 'yellow');
  assert.strictEqual(initRes.data.statusText, 'Nabíjí se');
  console.log('✓ Test 1 Passed: Initial status is "🟡 Nabíjí se"');

  // 2. Start Cleaning ("Začít vysávat")
  const startRes = await callHandler('POST', {}, { action: 'start' });
  assert.strictEqual(startRes.data.state, 'cleaning');
  assert.strictEqual(startRes.data.statusColor, 'green');
  assert.strictEqual(startRes.data.statusText, 'Vysává');
  console.log('✓ Test 2 Passed: Start cleaning transitions to "🟢 Vysává"');

  // 3. Pause ("Pozastavit")
  const pauseRes = await callHandler('POST', {}, { action: 'pause' });
  assert.strictEqual(pauseRes.data.state, 'paused');
  assert.strictEqual(pauseRes.data.statusColor, 'yellow');
  assert.strictEqual(pauseRes.data.statusText, 'Pozastaveno');
  console.log('✓ Test 3 Passed: Pause transitions to "🟡 Pozastaveno"');

  // 4. Non-critical maintenance warning (Code 200 = Filter worn, Code 15 = Dirty wall sensor)
  const maintRes = await callHandler('POST', {}, {
    action: 'simulate',
    rawState: 5,
    rawErrorCode: 200,
  });
  assert.strictEqual(maintRes.data.hasError, false);
  assert.strictEqual(maintRes.data.errorCode, 0);
  assert.strictEqual(maintRes.data.state, 'cleaning');
  assert.strictEqual(maintRes.data.statusColor, 'green');
  console.log('✓ Test 4 Passed: Non-critical maintenance warning (code 200) is completely ignored');

  // 5. Critical Hardware Error (Code 5 = Main brush tangled)
  const errRes = await callHandler('POST', {}, {
    action: 'simulate',
    rawState: 12,
    rawErrorCode: 5,
  });
  assert.strictEqual(errRes.data.hasError, true);
  assert.strictEqual(errRes.data.statusColor, 'red');
  assert.ok(errRes.data.errorMessage.includes('Vysavač se zasekl. Zkontrolujte hlavní kartáč vespod'));
  console.log('✓ Test 5 Passed: Critical error 5 translates to Czech brush troubleshooting message');

  // 6. Return to Dock ("Zpět do stanice") clears error and returns
  const dockRes = await callHandler('POST', {}, { action: 'dock' });
  assert.strictEqual(dockRes.data.hasError, false);
  assert.strictEqual(dockRes.data.state, 'returning');
  assert.strictEqual(dockRes.data.statusText, 'Vrací se do stanice');
  console.log('✓ Test 6 Passed: Return to dock transitions to "🟡 Vrací se do stanice"');

  // Reset back to charging (state 8)
  await callHandler('POST', {}, {
    action: 'simulate',
    rawState: 8,
    rawErrorCode: 0,
  });

  console.log('\nAll 6 backend verification tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

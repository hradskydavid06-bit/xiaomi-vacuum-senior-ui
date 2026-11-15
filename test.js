/**
 * Automated Full-Stack Verification Suite (`npm test`)
 * Verifies:
 *   1-6: Backend Xiaomi state mapping, Czech error translation, and maintenance warning suppression.
 *   7-11: Frontend State Watchdog (`evaluateWatchdog`) across grace windows, unexpected states, and recovery.
 */

const assert = require('assert');
const path = require('path');

// Always run unit tests against the simulator so we never start the physical vacuum during tests
process.env.SIMULATION_MODE = 'true';

module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

const { handleVacuumRequest } = require('./functions/index.js');
const { appState, evaluateWatchdog, WATCHDOG_MESSAGE_CS } = require('./public/app.js');

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
  console.log('Running Xiaomi Vacuum Full-Stack Verification Suite...\n');

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

  // 7. Watchdog Grace Window Check (no false alarm while robot spins up)
  const t0 = 100000;
  appState.expectedState = 'cleaning';
  appState.commandGraceUntil = t0 + 12000;
  const graceCheck = evaluateWatchdog('idle', t0 + 3000);
  assert.strictEqual(graceCheck.isConfused, false);
  assert.strictEqual(graceCheck.isTransitioning, true);
  console.log('✓ Test 7 Passed: Watchdog waits calmly during 12s physical transition grace window');

  // 8. Watchdog Intervention when vacuum is in 'idle', 'positioning', or 'returning' while expected 'cleaning'
  for (const unexpected of ['idle', 'positioning', 'returning', 'paused']) {
    const check = evaluateWatchdog(unexpected, t0 + 15000);
    assert.strictEqual(check.isConfused, true, `Failed on unexpected state: ${unexpected}`);
  }
  assert.strictEqual(
    WATCHDOG_MESSAGE_CS,
    "Vysavač je zmatený. Klikněte na 'Zpět do stanice' a zkuste to znovu."
  );
  console.log('✓ Test 8 Passed: Watchdog intercepts unexpected states (idle, positioning, returning, paused) with Czech recovery guidance');

  // 9. Watchdog clears expectedState when vacuum finishes cleaning and docks ('charging')
  const finishedCheck = evaluateWatchdog('charging', t0 + 15000);
  assert.strictEqual(finishedCheck.isConfused, false);
  assert.strictEqual(finishedCheck.clearExpected, true);
  console.log('✓ Test 9 Passed: Watchdog clears expectation when vacuum finishes cleaning and docks');

  // 10. Watchdog Docking verification
  appState.expectedState = 'docking';
  appState.commandGraceUntil = t0 + 12000;
  assert.strictEqual(evaluateWatchdog('returning', t0 + 15000).isConfused, false);
  assert.strictEqual(evaluateWatchdog('idle', t0 + 15000).isConfused, true);
  assert.strictEqual(evaluateWatchdog('charging', t0 + 15000).clearExpected, true);
  console.log('✓ Test 10 Passed: Watchdog verifies docking trajectory and flags stuck-undocked state');

  // Reset simulated vacuum back to charging (state 8)
  await callHandler('POST', {}, {
    action: 'simulate',
    rawState: 8,
    rawErrorCode: 0,
  });

  console.log('\nAll 10 full-stack verification tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

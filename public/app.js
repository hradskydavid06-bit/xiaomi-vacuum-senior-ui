/**
 * Frontend Controller & State Consistency Watchdog
 * Designed for Czech-speaking seniors with clear visual & haptic feedback.
 */

const CONFIG = {
  // Automatically works with Firebase Hosting rewrite (/api/vacuum) or direct Function URL
  API_ENDPOINT: '/api/vacuum',
  POLL_INTERVAL_MS: 5000,
  // Give the physical vacuum 12 seconds to transition after a button press
  // before the Watchdog flags an inconsistent state.
  COMMAND_GRACE_PERIOD_MS: 12000,
  FETCH_TIMEOUT_MS: 8000,
  MAX_SILENT_POLL_FAILURES: 2,
};

const WATCHDOG_MESSAGE_CS =
  "Vysavač je zmatený. Klikněte na 'Zpět do stanice' a zkuste to znovu.";

const PENDING_MESSAGES_CS = {
  cleaning: 'Zapínám vysávání… Prosím čekejte.',
  paused: 'Pozastavuji vysavač…',
  docking: 'Posílám vysavač zpět do stanice…',
};

const appState = {
  // Tracks what the user expects the vacuum to be doing: 'cleaning' | 'paused' | 'docking' | null
  expectedState: null,
  commandGraceUntil: 0,
  isSendingCommand: false,
  consecutivePollFailures: 0,
  pollTimer: null,
  wakeLock: null,
};

// DOM Elements (safe lookup so Watchdog logic can also be unit-tested in Node)
const bannerEl = typeof document !== 'undefined' ? document.getElementById('status-banner') : null;
const statusIconEl = typeof document !== 'undefined' ? document.getElementById('status-icon') : null;
const statusTextEl = typeof document !== 'undefined' ? document.getElementById('status-text') : null;
const btnStart = typeof document !== 'undefined' ? document.getElementById('btn-start') : null;
const btnPause = typeof document !== 'undefined' ? document.getElementById('btn-pause') : null;
const btnDock = typeof document !== 'undefined' ? document.getElementById('btn-dock') : null;

/**
 * Requests a Screen Wake Lock so the senior's phone screen does not dim
 * while they are watching the vacuum start or return to the dock.
 */
async function requestWakeLock() {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      appState.wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      // Ignore if browser/OS declines wake lock
    }
  }
}

/**
 * Triggers gentle tactile feedback on supported mobile devices.
 */
function triggerHaptic(pattern = 60) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch (_) {
      // Ignore on unsupported devices
    }
  }
}

/**
 * Wrapper around fetch() with an automatic AbortController timeout
 * so a slow network never locks the UI buttons indefinitely.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Updates the top giant status banner with high-contrast color coding.
 * @param {'green' | 'yellow' | 'red'} color
 * @param {string} message
 * @param {boolean} highlightDockButton
 */
function updateBanner(color, message, highlightDockButton = false) {
  if (!bannerEl || !statusIconEl || !statusTextEl || !btnDock) return;

  bannerEl.classList.remove(
    'status-banner--green',
    'status-banner--yellow',
    'status-banner--red',
    'status-banner--loading'
  );

  const iconMap = {
    green: '🟢',
    yellow: '🟡',
    red: '🔴',
  };

  bannerEl.classList.add(`status-banner--${color}`);
  statusIconEl.textContent = iconMap[color] || '🟡';
  statusTextEl.textContent = message;

  if (highlightDockButton) {
    btnDock.classList.add('btn--highlight-recovery');
  } else {
    btnDock.classList.remove('btn--highlight-recovery');
  }
}

/**
 * Enables or disables all buttons while a command is in flight
 * to prevent accidental double/triple presses.
 */
function setButtonsDisabled(disabled) {
  if (!btnStart || !btnPause || !btnDock) return;
  btnStart.disabled = disabled;
  btnPause.disabled = disabled;
  btnDock.disabled = disabled;
}

/**
 * STATE WATCHDOG:
 * Compares the user's last requested state (`expectedState`) with the actual state
 * reported by the Xiaomi vacuum.
 *
 * @param {string} actualState Normalized backend state:
 *   'cleaning' | 'paused' | 'returning' | 'charging' | 'idle' | 'positioning' | 'error'
 * @param {number} now Current timestamp in ms
 * @returns {{ isConfused: boolean, isTransitioning: boolean, clearExpected: boolean }}
 */
function evaluateWatchdog(actualState, now = Date.now()) {
  if (!appState.expectedState) {
    return { isConfused: false, isTransitioning: false, clearExpected: false };
  }

  const expected = appState.expectedState;
  const inGraceWindow = now < appState.commandGraceUntil;

  // Case 1: User pressed "Začít vysávat" (expectedState === 'cleaning')
  if (expected === 'cleaning') {
    if (actualState === 'cleaning') {
      return { isConfused: false, isTransitioning: false, clearExpected: false };
    }
    if (inGraceWindow) {
      // Physical robot is still spinning up its laser turret / leaving the dock
      return { isConfused: false, isTransitioning: true, clearExpected: false };
    }
    // If the vacuum finished cleaning on its own and is now peacefully charging,
    // clear the expectation rather than alarming the senior.
    if (actualState === 'charging') {
      return { isConfused: false, isTransitioning: false, clearExpected: true };
    }
    // Unexpected states after grace window expires while expected to be cleaning:
    // 'idle', 'positioning', 'returning', 'paused' (without user pressing pause)
    return { isConfused: true, isTransitioning: false, clearExpected: false };
  }

  // Case 2: User pressed "Pozastavit" (expectedState === 'paused')
  if (expected === 'paused') {
    if (actualState === 'paused' || actualState === 'idle' || actualState === 'charging') {
      return { isConfused: false, isTransitioning: false, clearExpected: false };
    }
    if (inGraceWindow) {
      return { isConfused: false, isTransitioning: true, clearExpected: false };
    }
    // Vacuum ignored pause and kept cleaning or wandering
    return { isConfused: true, isTransitioning: false, clearExpected: false };
  }

  // Case 3: User pressed "Zpět do stanice" (expectedState === 'docking')
  if (expected === 'docking') {
    if (actualState === 'charging') {
      // Successfully docked! Clear watchdog expectation.
      return { isConfused: false, isTransitioning: false, clearExpected: true };
    }
    if (actualState === 'returning' || actualState === 'positioning') {
      // Driving back to the dock normally
      return { isConfused: false, isTransitioning: false, clearExpected: false };
    }
    if (inGraceWindow) {
      return { isConfused: false, isTransitioning: true, clearExpected: false };
    }
    // Stopped in the middle of the room ('idle', 'paused') or still 'cleaning'
    return { isConfused: true, isTransitioning: false, clearExpected: false };
  }

  return { isConfused: false, isTransitioning: false, clearExpected: false };
}

/**
 * Renders the backend payload through the Priority Pipeline:
 *   1. Physical hardware error (translated Czech string from backend)
 *   2. State Watchdog check (transition message during grace window, or red intervention if confused)
 *   3. Normal reassuring Czech status
 */
function renderVacuumStatus(data, now = Date.now()) {
  // Priority 1: Hardware / Sensor Error (already filtered for critical-only on backend)
  if (data.hasError && data.errorMessage) {
    updateBanner('red', data.errorMessage, true);
    return;
  }

  // Priority 2: Frontend State Watchdog Check
  const watchdog = evaluateWatchdog(data.state, now);
  if (watchdog.clearExpected) {
    appState.expectedState = null;
  }

  if (watchdog.isTransitioning && appState.expectedState) {
    const pendingMsg = PENDING_MESSAGES_CS[appState.expectedState] || 'Prosím čekejte…';
    updateBanner('yellow', pendingMsg, false);
    return;
  }

  if (watchdog.isConfused) {
    triggerHaptic([100, 80, 100]);
    updateBanner('red', WATCHDOG_MESSAGE_CS, true);
    return;
  }

  // Priority 3: Standard Reassuring Status
  updateBanner(data.statusColor || 'yellow', data.statusText || 'Připraven', false);
}

/**
 * Polls the Firebase Cloud Function for the current vacuum state.
 */
async function pollStatus() {
  if (appState.isSendingCommand) return;

  try {
    const response = await fetchWithTimeout(`${CONFIG.API_ENDPOINT}?action=status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    appState.consecutivePollFailures = 0;
    renderVacuumStatus(data);
  } catch (err) {
    appState.consecutivePollFailures += 1;
    console.error('Chyba při komunikaci se serverem:', err);
    if (appState.consecutivePollFailures >= CONFIG.MAX_SILENT_POLL_FAILURES) {
      updateBanner(
        'red',
        'Nelze se spojit s vysavačem. Zkontrolujte prosím internet.',
        false
      );
    }
  }
}

/**
 * Sends a control command ('start' | 'pause' | 'dock') to the backend
 * and sets the Watchdog expectedState.
 */
async function sendCommand(action) {
  if (appState.isSendingCommand) return;

  triggerHaptic(70);
  appState.isSendingCommand = true;
  setButtonsDisabled(true);

  // Set optimistic Czech feedback and configure Watchdog expectations
  if (action === 'start') {
    appState.expectedState = 'cleaning';
    updateBanner('yellow', PENDING_MESSAGES_CS.cleaning, false);
  } else if (action === 'pause') {
    appState.expectedState = 'paused';
    updateBanner('yellow', PENDING_MESSAGES_CS.paused, false);
  } else if (action === 'dock') {
    // Pressing "Zpět do stanice" acts as the universal reset for a confused vacuum
    appState.expectedState = 'docking';
    updateBanner('yellow', PENDING_MESSAGES_CS.docking, false);
  }

  appState.commandGraceUntil = Date.now() + CONFIG.COMMAND_GRACE_PERIOD_MS;

  try {
    const response = await fetchWithTimeout(CONFIG.API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    appState.consecutivePollFailures = 0;
    renderVacuumStatus(data);
  } catch (err) {
    console.error(`Chyba při odeslání příkazu ${action}:`, err);
    updateBanner(
      'red',
      'Příkaz se nepodařilo odeslat. Zkuste prosím kliknout znovu.',
      false
    );
  } finally {
    appState.isSendingCommand = false;
    setButtonsDisabled(false);
  }
}

// Browser Event Listeners
if (typeof document !== 'undefined' && btnStart && btnPause && btnDock) {
  btnStart.addEventListener('click', () => sendCommand('start'));
  btnPause.addEventListener('click', () => sendCommand('pause'));
  btnDock.addEventListener('click', () => sendCommand('dock'));

  document.addEventListener('DOMContentLoaded', () => {
    requestWakeLock();
    pollStatus();
    appState.pollTimer = setInterval(pollStatus, CONFIG.POLL_INTERVAL_MS);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      pollStatus();
    }
  });
}

// Export for automated Node.js verification in `test.js`
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG,
    WATCHDOG_MESSAGE_CS,
    appState,
    evaluateWatchdog,
  };
}

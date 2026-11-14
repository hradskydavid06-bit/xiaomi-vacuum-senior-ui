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
};

const WATCHDOG_MESSAGE_CS =
  "Vysavač je zmatený. Klikněte na 'Zpět do stanice' a zkuste to znovu.";

const appState = {
  // Tracks what the user expects the vacuum to be doing: 'cleaning' | 'paused' | 'docking' | null
  expectedState: null,
  commandGraceUntil: 0,
  isSendingCommand: false,
  pollTimer: null,
};

// DOM Elements
const bannerEl = document.getElementById('status-banner');
const statusIconEl = document.getElementById('status-icon');
const statusTextEl = document.getElementById('status-text');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnDock = document.getElementById('btn-dock');

/**
 * Triggers gentle tactile feedback on supported mobile devices.
 */
function triggerHaptic(pattern = 60) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

/**
 * Updates the top giant status banner with high-contrast color coding.
 * @param {'green' | 'yellow' | 'red'} color
 * @param {string} message
 * @param {boolean} highlightDockButton
 */
function updateBanner(color, message, highlightDockButton = false) {
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
  btnStart.disabled = disabled;
  btnPause.disabled = disabled;
  btnDock.disabled = disabled;
}

/**
 * STATE WATCHDOG:
 * Compares the user's last requested state (`expectedState`) with the actual state
 * reported by the Xiaomi vacuum after the transition grace window expires.
 *
 * @param {string} actualState Normalized backend state:
 *   'cleaning' | 'paused' | 'returning' | 'charging' | 'idle' | 'positioning' | 'error'
 * @returns {{ isConfused: boolean, clearExpected: boolean }}
 */
function evaluateWatchdog(actualState) {
  if (!appState.expectedState) {
    return { isConfused: false, clearExpected: false };
  }

  // Wait for the physical robot to spin up or begin moving after a tap
  if (Date.now() < appState.commandGraceUntil) {
    return { isConfused: false, clearExpected: false };
  }

  const expected = appState.expectedState;

  // Case 1: User pressed "Začít vysávat" (expectedState === 'cleaning')
  if (expected === 'cleaning') {
    if (actualState === 'cleaning') {
      return { isConfused: false, clearExpected: false };
    }
    // If the vacuum finished cleaning on its own and is now peacefully charging,
    // clear the expectation rather than alarming the senior.
    if (actualState === 'charging') {
      return { isConfused: false, clearExpected: true };
    }
    // Unexpected states while expected to be cleaning:
    // 'idle', 'positioning', 'returning', 'paused' (without user pressing pause)
    return { isConfused: true, clearExpected: false };
  }

  // Case 2: User pressed "Pozastavit" (expectedState === 'paused')
  if (expected === 'paused') {
    if (actualState === 'paused' || actualState === 'idle' || actualState === 'charging') {
      return { isConfused: false, clearExpected: false };
    }
    // Vacuum ignored pause and kept cleaning or wandering
    return { isConfused: true, clearExpected: false };
  }

  // Case 3: User pressed "Zpět do stanice" (expectedState === 'docking')
  if (expected === 'docking') {
    if (actualState === 'charging') {
      // Successfully docked! Clear watchdog expectation.
      return { isConfused: false, clearExpected: true };
    }
    if (actualState === 'returning' || actualState === 'positioning') {
      // Still driving back to the dock normally
      return { isConfused: false, clearExpected: false };
    }
    // Stopped in the middle of the room ('idle', 'paused') or still 'cleaning'
    return { isConfused: true, clearExpected: false };
  }

  return { isConfused: false, clearExpected: false };
}

/**
 * Renders the backend payload through the Priority Pipeline:
 *   1. Physical hardware error (translated Czech string from backend)
 *   2. State Watchdog intervention (if robot is doing something unexpected)
 *   3. Normal reassuring Czech status
 */
function renderVacuumStatus(data) {
  // Priority 1: Hardware / Sensor Error (already filtered for critical-only on backend)
  if (data.hasError && data.errorMessage) {
    updateBanner('red', data.errorMessage, true);
    return;
  }

  // Priority 2: Frontend State Watchdog Check
  const watchdog = evaluateWatchdog(data.state);
  if (watchdog.clearExpected) {
    appState.expectedState = null;
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
    const response = await fetch(`${CONFIG.API_ENDPOINT}?action=status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    renderVacuumStatus(data);
  } catch (err) {
    console.error('Chyba při komunikaci se serverem:', err);
    updateBanner(
      'red',
      'Nelze se spojit s vysavačem. Zkontrolujte prosím internet.',
      false
    );
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
    updateBanner('yellow', 'Zapínám vysávání… Prosím čekejte.', false);
  } else if (action === 'pause') {
    appState.expectedState = 'paused';
    updateBanner('yellow', 'Pozastavuji vysavač…', false);
  } else if (action === 'dock') {
    // Pressing "Zpět do stanice" acts as the universal reset for a confused vacuum
    appState.expectedState = 'docking';
    updateBanner('yellow', 'Posílám vysavač zpět do stanice…', false);
  }

  appState.commandGraceUntil = Date.now() + CONFIG.COMMAND_GRACE_PERIOD_MS;

  try {
    const response = await fetch(CONFIG.API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
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

// Event Listeners
btnStart.addEventListener('click', () => sendCommand('start'));
btnPause.addEventListener('click', () => sendCommand('pause'));
btnDock.addEventListener('click', () => sendCommand('dock'));

// Initialize Polling Loop
document.addEventListener('DOMContentLoaded', () => {
  pollStatus();
  appState.pollTimer = setInterval(pollStatus, CONFIG.POLL_INTERVAL_MS);
});

/**
 * Firebase Cloud Function Backend for Xiaomi Vacuum Control via `node-mihome`
 *
 * Features:
 * - Connects to Xiaomi Cloud API (`node-mihome`).
 * - Supports BOTH classic Xiaomi/Roborock `miIO` (`get_status`, `app_start`, `app_pause`, `app_charge`)
 *   and newer Xiaomi/Mijia/Dreame `MIoT-Spec` (`get_properties` / `action`) automatically.
 * - Filters out non-critical maintenance warnings completely.
 * - Translates hardware fault codes into reassuring, jargon-free Czech sentences.
 * - Includes automatic stateful simulator fallback when credentials are not yet configured.
 */

let onRequest;
try {
  ({ onRequest } = require('firebase-functions/v2/https'));
} catch (_) {
  onRequest = (_opts, handler) => handler;
}

let cors;
try {
  cors = require('cors')({ origin: true });
} catch (_) {
  cors = (_req, res, next) => {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    return next();
  };
}

let mihome;
try {
  mihome = require('node-mihome');
} catch (_) {
  mihome = null;
}

// Reuse Xiaomi Cloud session across warm Cloud Function invocations
let isAuthenticated = false;
let detectedProtocol = null; // 'miio' | 'miot' | null

/**
 * Built-in stateful Xiaomi miIO simulator used when MIHOME credentials are not set
 * (or when SIMULATION_MODE=true), allowing full local & staging execution.
 */
const simulatedVacuum = {
  state: 8, // 8 = Charging in dock
  error_code: 0,
  battery: 100,
  dockingTimer: null,
};

function isSimulationMode() {
  if (process.env.SIMULATION_MODE === 'true') return true;
  if (!mihome) return true;
  const user = process.env.MIHOME_USERNAME;
  const pass = process.env.MIHOME_PASSWORD;
  const did = process.env.MIHOME_DEVICE_ID;
  if (!user || !pass || !did) return true;
  if (user === 'your-xiaomi-email@example.com' || did === '123456789') return true;
  return false;
}

/**
 * Authenticates with Xiaomi Cloud API using `node-mihome`.
 */
async function ensureXiaomiLogin() {
  if (isAuthenticated) return;

  const username = process.env.MIHOME_USERNAME;
  const password = process.env.MIHOME_PASSWORD;

  await mihome.miCloudProtocol.login(username, password);
  isAuthenticated = true;
}

/**
 * Raw Xiaomi Cloud RPC call with automatic 1x re-login retry on token expiry.
 */
async function rawMiioCall(deviceId, method, params, country) {
  await ensureXiaomiLogin();
  try {
    return await mihome.miCloudProtocol.miioCall(deviceId, method, params, { country });
  } catch (err) {
    isAuthenticated = false;
    await ensureXiaomiLogin();
    return await mihome.miCloudProtocol.miioCall(deviceId, method, params, { country });
  }
}

/**
 * Maps MIoT-Spec Vacuum Status (`siid: 2, piid: 1`) into standard miIO state numbers.
 */
const MIOT_STATUS_TO_MIIO = {
  1: 5,  // Sweeping -> Cleaning
  2: 2,  // Idle
  3: 10, // Paused
  4: 12, // Error
  5: 6,  // Go Charging -> Returning
  6: 8,  // Charging
  7: 5,  // Mopping / Sweep & Mop -> Cleaning
};

/**
 * Executes a vacuum method (`get_status`, `app_start`, `app_pause`, `app_charge`)
 * with automatic fallback from classic `miIO` to `MIoT-Spec` for newer Xiaomi models.
 */
async function callVacuumMethod(method, params = []) {
  if (isSimulationMode()) {
    if (simulatedVacuum.dockingTimer && method !== 'get_status') {
      clearTimeout(simulatedVacuum.dockingTimer);
      simulatedVacuum.dockingTimer = null;
    }

    switch (method) {
      case 'app_start':
        simulatedVacuum.error_code = 0;
        simulatedVacuum.state = 5; // Cleaning
        return ['ok'];

      case 'app_pause':
        simulatedVacuum.state = 10; // Paused
        return ['ok'];

      case 'app_charge':
        simulatedVacuum.error_code = 0;
        simulatedVacuum.state = 6; // Returning to dock
        simulatedVacuum.dockingTimer = setTimeout(() => {
          simulatedVacuum.state = 8; // Charging
          simulatedVacuum.dockingTimer = null;
        }, 4000);
        return ['ok'];

      case 'get_status':
      default:
        return [
          {
            state: simulatedVacuum.state,
            error_code: simulatedVacuum.error_code,
            battery: simulatedVacuum.battery,
          },
        ];
    }
  }

  const deviceId = String(process.env.MIHOME_DEVICE_ID);
  const country = process.env.MIHOME_COUNTRY || 'de';
  const configuredProtocol = (process.env.MIHOME_PROTOCOL || detectedProtocol || 'auto').toLowerCase();

  // Try classic miIO unless explicitly configured or already detected as MIoT
  if (configuredProtocol !== 'miot') {
    try {
      const res = await rawMiioCall(deviceId, method, params, country);
      detectedProtocol = 'miio';
      return res;
    } catch (err) {
      if (configuredProtocol === 'miio') {
        throw err;
      }
      // Fall through to MIoT-Spec protocol
      detectedProtocol = 'miot';
    }
  }

  // MIoT-Spec protocol handling for newer Xiaomi / Mijia / Dreame vacuums
  switch (method) {
    case 'app_start':
      return await rawMiioCall(
        deviceId,
        'action',
        { did: deviceId, siid: 2, aiid: 1, in: [] },
        country
      );

    case 'app_pause':
      return await rawMiioCall(
        deviceId,
        'action',
        { did: deviceId, siid: 2, aiid: 2, in: [] },
        country
      );

    case 'app_charge':
      return await rawMiioCall(
        deviceId,
        'action',
        { did: deviceId, siid: 3, aiid: 1, in: [] },
        country
      );

    case 'get_status':
    default: {
      const props = await rawMiioCall(
        deviceId,
        'get_properties',
        [
          { did: deviceId, siid: 2, piid: 1 }, // Status
          { did: deviceId, siid: 2, piid: 2 }, // Fault
        ],
        country
      );
      const statusProp = Array.isArray(props) ? props.find((p) => p.piid === 1) : null;
      const faultProp = Array.isArray(props) ? props.find((p) => p.piid === 2) : null;

      const miotStatus = Number(statusProp?.value ?? 6);
      const miotFault = Number(faultProp?.value ?? 0);

      return [
        {
          state: MIOT_STATUS_TO_MIIO[miotStatus] ?? 8,
          error_code: miotFault,
        },
      ];
    }
  }
}

/**
 * XIAOMI STATE TRANSLATION MAP (Raw Xiaomi state code -> Normalized state + Czech UI)
 */
const STATE_MAP = {
  1:  { state: 'positioning', color: 'yellow', text: 'Vysavač se zapíná' },
  2:  { state: 'idle',        color: 'yellow', text: 'Vysavač stojí mimo stanici' },
  3:  { state: 'idle',        color: 'yellow', text: 'Vysavač odpočívá' },
  5:  { state: 'cleaning',    color: 'green',  text: 'Vysává' },
  6:  { state: 'returning',   color: 'yellow', text: 'Vrací se do stanice' },
  7:  { state: 'cleaning',    color: 'green',  text: 'Vysává' },
  8:  { state: 'charging',    color: 'yellow', text: 'Nabíjí se' },
  9:  { state: 'error',       color: 'red',    text: 'Problém s nabíjením' },
  10: { state: 'paused',      color: 'yellow', text: 'Pozastaveno' },
  11: { state: 'cleaning',    color: 'green',  text: 'Vysává místo' },
  12: { state: 'error',       color: 'red',    text: 'Vysavač hlásí závadu' },
  14: { state: 'charging',    color: 'yellow', text: 'Nabíjí se' },
  15: { state: 'returning',   color: 'yellow', text: 'Hledá nabíjecí stanici' },
  16: { state: 'cleaning',    color: 'green',  text: 'Jede na určené místo' },
  17: { state: 'cleaning',    color: 'green',  text: 'Vysává vybranou místnost' },
  18: { state: 'cleaning',    color: 'green',  text: 'Vysává vybranou místnost' },
  100:{ state: 'charging',    color: 'green',  text: 'Nabito a připraveno' },
};

/**
 * NON-CRITICAL MAINTENANCE WARNINGS TO IGNORE COMPLETELY:
 * Xiaomi/Roborock firmware sometimes reports codes for dirty sensors (15)
 * or filter/brush wear reminders (200+). We ignore non-blocking maintenance reminders
 * so the senior is only alerted when physical intervention is truly needed.
 */
const IGNORED_MAINTENANCE_CODES = new Set([
  0,   // No error
  15,  // Wall sensor slightly dusty (vacuum still operates)
  200, // Filter maintenance timer expired
  201, // Side brush maintenance timer expired
  202, // Main brush maintenance timer expired
  203, // Sensor cleaning reminder timer
]);

/**
 * CRITICAL ERROR TRANSLATION MAP:
 * Maps standard Xiaomi/Roborock error codes into calm, jargon-free Czech instructions.
 */
const CRITICAL_ERROR_MAP_CS = {
  1:  'Vysavač nevidí prostor kolem sebe. Zkuste kliknout na „Zpět do stanice“.',
  2:  'Přední nárazník se zasekl. Jemně na něj zepředu poklepejte.',
  3:  'Kolečko vysavače visí ve vzduchu. Položte vysavač na rovnou podlahu.',
  4:  'Vysavač se bojí schodů. Přesuňte ho na rovnou podlahu a zkuste to znovu.',
  5:  'Vysavač se zasekl. Zkontrolujte hlavní kartáč vespod (může v něm být namotaný vlas nebo koberec).',
  6:  'Boční kartáček se zasekl. Zkontrolujte malý kartáček vespod vysavače.',
  7:  'Kolečko vysavače se zaseklo. Zkontrolujte, zda pod vysavačem nic neleží.',
  8:  'Vysavač uvízl v úzkém místě. Přesuňte ho prosím na volné místo.',
  9:  'Chybí nádobka na prach. Vložte ji prosím zpět do vysavače.',
  10: 'Filtr v nádobce je ucpaný. Vyklepejte prosím nádobku na prach.',
  11: 'Vysavač narazil na magnetickou pásku. Přesuňte ho kousek dál.',
  12: 'Baterie je téměř vybitá. Odneste prosím vysavač do nabíjecí stanice.',
  13: 'Vysavač se špatně dotýká nabíjecí stanice. Posuňte ho prosím správně do stanice.',
  14: 'Baterie je příliš zahřátá. Nechte vysavač chvíli odpočinout.',
  16: 'Vysavač stojí nakřivo. Položte ho prosím na rovnou podlahu.',
  17: 'Boční kartáček potřebuje zkontrolovat. Odstraňte z něj případné nečistoty.',
  18: 'Vysavač nemůže sát. Zkontrolujte, zda není ucpaný otvor vespod.',
  19: 'Nabíjecí stanice není zapojená do zásuvky. Zkontrolujte kabel stanice.',
  21: 'Horní kolečko (věžička) vysavače je zmáčknuté. Uvolněte předmět nad vysavačem.',
};

/**
 * Polls the Xiaomi vacuum and translates its state and error codes into
 * a normalized, senior-friendly Czech response object.
 */
async function fetchFormattedStatus() {
  const result = await callVacuumMethod('get_status', []);
  const raw = Array.isArray(result) ? result[0] : result || {};

  const rawStateCode = Number(raw.state ?? 8);
  const rawErrorCode = Number(raw.error_code ?? 0);

  const mappedState = STATE_MAP[rawStateCode] || {
    state: 'idle',
    color: 'yellow',
    text: 'Připraven',
  };

  // Ignore non-critical maintenance warnings completely
  const isCriticalError =
    rawErrorCode !== 0 &&
    !IGNORED_MAINTENANCE_CODES.has(rawErrorCode) &&
    rawErrorCode < 200;

  let errorMessage = null;
  if (isCriticalError) {
    errorMessage =
      CRITICAL_ERROR_MAP_CS[rawErrorCode] ||
      'Vysavač se zastavil. Zkontrolujte, zda mu nic nepřekáží, a klikněte na „Zpět do stanice“.';
  }

  return {
    state: isCriticalError ? 'error' : mappedState.state,
    rawState: rawStateCode,
    statusText: isCriticalError ? errorMessage : mappedState.text,
    statusColor: isCriticalError ? 'red' : mappedState.color,
    hasError: isCriticalError,
    errorCode: isCriticalError ? rawErrorCode : 0,
    errorMessage,
    simulationMode: isSimulationMode(),
  };
}

/**
 * Shared HTTP handler used by both Firebase Cloud Functions and the local Node server.
 */
async function handleVacuumRequest(req, res) {
  try {
    const action = (req.method === 'GET' ? req.query?.action : req.body?.action) || 'status';

    switch (action) {
      case 'start':
        await callVacuumMethod('app_start', []);
        break;

      case 'pause':
        await callVacuumMethod('app_pause', []);
        break;

      case 'dock':
        try {
          await callVacuumMethod('app_pause', []);
        } catch (_) {
          // Ignore if already paused/stopped
        }
        await callVacuumMethod('app_charge', []);
        break;

      case 'simulate':
        // Allows testing fault translation, maintenance filtering & Watchdog intervention
        if (isSimulationMode()) {
          if (simulatedVacuum.dockingTimer) {
            clearTimeout(simulatedVacuum.dockingTimer);
            simulatedVacuum.dockingTimer = null;
          }
          if (req.body?.rawState !== undefined) {
            simulatedVacuum.state = Number(req.body.rawState);
          }
          if (req.body?.rawErrorCode !== undefined) {
            simulatedVacuum.error_code = Number(req.body.rawErrorCode);
          }
        }
        break;

      case 'status':
      default:
        break;
    }

    const statusPayload = await fetchFormattedStatus();
    return res.status(200).json(statusPayload);
  } catch (error) {
    console.error('Xiaomi Cloud API Error:', error);
    return res.status(502).json({
      state: 'error',
      statusText: 'Nelze se spojit s vysavačem. Zkuste to prosím za chvíli.',
      statusColor: 'red',
      hasError: true,
      errorCode: -1,
      errorMessage: 'Nelze se spojit s vysavačem. Zkuste to prosím za chvíli.',
    });
  }
}

/**
 * Main HTTPS Cloud Function (`vacuum`)
 */
exports.vacuum = onRequest({ region: 'europe-west1', cors: true }, (req, res) => {
  cors(req, res, () => handleVacuumRequest(req, res));
});

exports.handleVacuumRequest = handleVacuumRequest;

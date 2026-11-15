/**
 * Firebase Cloud Function Backend for Xiaomi Vacuum Control via `node-mihome`
 *
 * Tailored & verified for Xiaomi Robot Vacuum X20+ (`xiaomi.vacuum.c102gl`, MIoT-Spec)
 * as well as classic Xiaomi / Roborock `miIO` models.
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

const xiaomiCloudFallback = require('./xiaomi-cloud.js');
let mihome;
try {
  mihome = require('node-mihome');
} catch (_) {
  mihome = xiaomiCloudFallback;
}

// Reuse Xiaomi Cloud session across warm Cloud Function invocations
let isAuthenticated = false;
let activeCloudClient = null;
let detectedProtocol = null; // 'miio' | 'miot' | null

/**
 * Built-in stateful Xiaomi simulator used when MIHOME credentials are not set
 * (or when SIMULATION_MODE=true), allowing safe unit testing without moving the physical robot.
 */
const simulatedVacuum = {
  state: 8, // 8 = Charging in dock
  error_code: 0,
  battery: 100,
  dockingTimer: null,
};

function isSimulationMode() {
  if (process.env.SIMULATION_MODE === 'true') return true;
  const user = process.env.MIHOME_USERNAME;
  const pass = process.env.MIHOME_PASSWORD;
  const did = process.env.MIHOME_DEVICE_ID;
  if (!user || !pass || !did) return true;
  if (user === 'your-xiaomi-email@example.com' || did === '123456789') return true;
  return false;
}

/**
 * Authenticates with Xiaomi Cloud API using cached 2FA tokens (`xiaomi-cloud.js`) or `node-mihome`.
 */
async function ensureXiaomiLogin() {
  if (isAuthenticated && activeCloudClient) return;

  const username = process.env.MIHOME_USERNAME;
  const password = process.env.MIHOME_PASSWORD;

  if (process.env.MIHOME_SSECURITY && process.env.MIHOME_SERVICE_TOKEN) {
    await xiaomiCloudFallback.miCloudProtocol.login(username, password);
    activeCloudClient = xiaomiCloudFallback.miCloudProtocol;
    isAuthenticated = true;
    return;
  }

  try {
    await mihome.miCloudProtocol.login(username, password);
    activeCloudClient = mihome.miCloudProtocol;
    isAuthenticated = true;
  } catch (_) {
    await xiaomiCloudFallback.miCloudProtocol.login(username, password);
    activeCloudClient = xiaomiCloudFallback.miCloudProtocol;
    isAuthenticated = true;
  }
}

/**
 * Raw Xiaomi Cloud RPC call with automatic 1x re-login retry on token expiry.
 */
async function rawMiioCall(deviceId, method, params, country) {
  await ensureXiaomiLogin();
  try {
    return await activeCloudClient.miioCall(deviceId, method, params, { country });
  } catch (err) {
    isAuthenticated = false;
    await ensureXiaomiLogin();
    return await activeCloudClient.miioCall(deviceId, method, params, { country });
  }
}

/**
 * MIoT-Spec Status Map for Xiaomi Robot Vacuum X20+ (`xiaomi.vacuum.c102gl`, `siid: 2, piid: 1`)
 */
const MIOT_STATE_MAP = {
  1:  { state: 'cleaning',  color: 'green',  text: 'Vysává' },
  2:  { state: 'idle',      color: 'yellow', text: 'Vysavač odpočívá' },
  3:  { state: 'paused',    color: 'yellow', text: 'Pozastaveno' },
  4:  { state: 'paused',    color: 'yellow', text: 'Pozastaveno' },
  5:  { state: 'returning', color: 'yellow', text: 'Vrací se do stanice' },
  6:  { state: 'charging',  color: 'yellow', text: 'Nabíjí se' },
  7:  { state: 'cleaning',  color: 'green',  text: 'Vytírá podlahu' },
  8:  { state: 'charging',  color: 'yellow', text: 'Nabíjí se (suší mop)' },
  9:  { state: 'cleaning',  color: 'green',  text: 'Čistí mop ve stanici' },
  10: { state: 'cleaning',  color: 'green',  text: 'Jede vyprat mop do stanice' },
  11: { state: 'cleaning',  color: 'green',  text: 'Mapuje prostor' },
  12: { state: 'cleaning',  color: 'green',  text: 'Vysává a vytírá' },
  13: { state: 'charging',  color: 'yellow', text: 'Nabíjí se (připraven)' },
  14: { state: 'charging',  color: 'yellow', text: 'Vysavač se aktualizuje' },
  19: { state: 'charging',  color: 'yellow', text: 'Kontrola stanice' },
  21: { state: 'paused',    color: 'yellow', text: 'Pozastaveno' },
  22: { state: 'charging',  color: 'yellow', text: 'Vysypává prach ve stanici' },
  23: { state: 'cleaning',  color: 'green',  text: 'Vysává' },
};

/**
 * Classic Xiaomi/Roborock `miIO` State Map (`get_status`)
 */
const MIIO_STATE_MAP = {
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
  100:{ state: 'charging',    color: 'yellow', text: 'Nabito a připraveno' },
};

/**
 * NON-CRITICAL MAINTENANCE WARNINGS TO IGNORE COMPLETELY:
 * Xiaomi firmware sometimes reports codes for dirty sensors (15)
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
 * Maps Xiaomi / Dreame / Roborock error codes into calm, jargon-free Czech instructions.
 */
const CRITICAL_ERROR_MAP_CS = {
  1:  'Kolečko nebo senzor vysavače se zasekl. Přesuňte vysavač na volné místo a klikněte na „Zpět do stanice“.',
  2:  'Kolečko nebo přední nárazník se zasekl. Zkontrolujte prosím vysavač.',
  3:  'Vysavač je příliš blízko schodů nebo má znečištěný senzor vespod. Položte ho na rovnou podlahu.',
  4:  'Baterie je vybitá nebo se vysavač bojí schodů. Zkuste ho posunout do nabíjecí stanice.',
  5:  'Vysavač se zasekl. Zkontrolujte hlavní kartáč vespod (může v něm být namotaný vlas nebo koberec).',
  6:  'Hlavní nebo boční kartáč se zasekl. Zkontrolujte prosím kartáče vespod vysavače.',
  7:  'Boční kartáček nebo kolečko se zaseklo. Zkontrolujte, zda pod vysavačem nic neleží.',
  8:  'Vysavač uvízl nebo nemůže sát. Přesuňte ho prosím na volné místo a zkontrolujte nádobku.',
  9:  'Chybí nádobka na prach nebo je problém s nádržkou na vodu. Zkontrolujte prosím nádobku.',
  10: 'Filtr je ucpaný nebo je zablokovaná horní věžička vysavače. Zkontrolujte prosím vysavač.',
  11: 'Vysavač narazil na překážku v cestě. Přesuňte ho prosím na volné místo.',
  12: 'Vysavač vjel do zakázané zóny nebo je vybitý. Přesuňte ho na volné místo.',
  13: 'Vysavač se špatně dotýká nabíjecí stanice. Posuňte ho prosím správně do stanice.',
  14: 'Baterie je příliš zahřátá. Nechte vysavač chvíli odpočinout.',
  16: 'Vysavač stojí nakřivo. Položte ho prosím na rovnou podlahu.',
  17: 'Boční kartáček potřebuje zkontrolovat. Odstraňte z něj případné nečistoty.',
  18: 'Vysavač nemůže sát. Zkontrolujte, zda není ucpaný otvor vespod.',
  19: 'Nabíjecí stanice není zapojená do zásuvky. Zkontrolujte kabel stanice.',
  21: 'Horní kolečko (věžička) vysavače je zmáčknuté. Uvolněte předmět nad vysavačem.',
};

/**
 * Executes a vacuum method (`get_status`, `app_start`, `app_pause`, `app_charge`)
 * supporting both `MIoT-Spec` (`xiaomi.vacuum.c102gl`) and classic `miIO`.
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
        return [{ state: 5, error_code: 0, protocol: 'miio' }];

      case 'app_pause':
        simulatedVacuum.state = 10; // Paused
        return [{ state: 10, error_code: 0, protocol: 'miio' }];

      case 'app_charge':
        simulatedVacuum.error_code = 0;
        simulatedVacuum.state = 6; // Returning to dock
        simulatedVacuum.dockingTimer = setTimeout(() => {
          simulatedVacuum.state = 8; // Charging
          simulatedVacuum.dockingTimer = null;
        }, 4000);
        return [{ state: 6, error_code: 0, protocol: 'miio' }];

      case 'get_status':
      default:
        return [
          {
            state: simulatedVacuum.state,
            error_code: simulatedVacuum.error_code,
            battery: simulatedVacuum.battery,
            protocol: 'miio',
          },
        ];
    }
  }

  const deviceId = String(process.env.MIHOME_DEVICE_ID);
  const country = process.env.MIHOME_COUNTRY || 'de';
  const configuredProtocol = (process.env.MIHOME_PROTOCOL || detectedProtocol || 'miot').toLowerCase();

  if (configuredProtocol === 'miio') {
    const res = await rawMiioCall(deviceId, method, params, country);
    const first = Array.isArray(res) ? res[0] : res || {};
    return [{ ...first, protocol: 'miio' }];
  }

  // MIoT-Spec protocol for Xiaomi Robot Vacuum X20+ (`xiaomi.vacuum.c102gl`)
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
          { did: deviceId, siid: 2, piid: 1 }, // vacuum.status
          { did: deviceId, siid: 2, piid: 2 }, // vacuum.fault
          { did: deviceId, siid: 3, piid: 1 }, // battery.battery-level
        ],
        country
      );
      const statusProp = Array.isArray(props) ? props.find((p) => p.siid === 2 && p.piid === 1) : null;
      const faultProp = Array.isArray(props) ? props.find((p) => p.siid === 2 && p.piid === 2) : null;
      const batteryProp = Array.isArray(props) ? props.find((p) => p.siid === 3 && p.piid === 1) : null;

      return [
        {
          state: Number(statusProp?.value ?? 6),
          error_code: Number(faultProp?.value ?? 0),
          battery: Number(batteryProp?.value ?? 100),
          protocol: 'miot',
        },
      ];
    }
  }
}

/**
 * Polls the Xiaomi vacuum and translates its state and error codes into
 * a normalized, senior-friendly Czech response object.
 */
async function fetchFormattedStatus() {
  const result = await callVacuumMethod('get_status', []);
  const raw = Array.isArray(result) ? result[0] : result || {};

  const isMiot = raw.protocol === 'miot';
  const rawStateCode = Number(raw.state ?? (isMiot ? 6 : 8));
  const rawErrorCode = Number(raw.error_code ?? 0);

  const stateDictionary = isMiot ? MIOT_STATE_MAP : MIIO_STATE_MAP;
  const mappedState = stateDictionary[rawStateCode] || {
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
    battery: raw.battery ?? 100,
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

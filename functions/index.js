/**
 * Backend Controller for Xiaomi Vacuum Control (Firebase Cloud Functions, Vercel, & Local Server)
 *
 * Tailored & verified for Xiaomi Robot Vacuum X20+ (`xiaomi.vacuum.c102gl`, MIoT-Spec, did: 1172182642)
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

const {
  miCloudProtocol: xiaomiClient,
  DEFAULT_X20_SESSION,
  cleanEnv,
} = require('./xiaomi-cloud.js');

// Reuse Xiaomi Cloud session across warm Serverless Function invocations
let isAuthenticated = false;

/**
 * Built-in stateful Xiaomi simulator used ONLY when SIMULATION_MODE=true (e.g. unit tests).
 */
const simulatedVacuum = {
  state: 8, // 8 = Charging in dock
  error_code: 0,
  battery: 100,
  dockingTimer: null,
};

function isSimulationMode() {
  return cleanEnv(process.env.SIMULATION_MODE) === 'true';
}

/**
 * Authenticates with Xiaomi Cloud API using pre-verified X20+ session tokens.
 */
async function ensureXiaomiLogin() {
  if (isAuthenticated) return;
  await xiaomiClient.login(
    cleanEnv(process.env.MIHOME_USERNAME),
    cleanEnv(process.env.MIHOME_PASSWORD)
  );
  isAuthenticated = true;
}

/**
 * Raw Xiaomi Cloud RPC call with automatic retry on token expiry.
 */
async function rawMiioCall(deviceId, method, params, country) {
  await ensureXiaomiLogin();
  try {
    return await xiaomiClient.miioCall(deviceId, method, params, { country });
  } catch (err) {
    isAuthenticated = false;
    await xiaomiClient.refreshFromPassToken();
    isAuthenticated = true;
    return await xiaomiClient.miioCall(deviceId, method, params, { country });
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

  const rawEnvDid = cleanEnv(process.env.MIHOME_DEVICE_ID);
  const deviceId =
    rawEnvDid && rawEnvDid !== '123456789' ? rawEnvDid : DEFAULT_X20_SESSION.deviceId;
  const country = cleanEnv(process.env.MIHOME_COUNTRY, DEFAULT_X20_SESSION.country);
  const configuredProtocol = cleanEnv(process.env.MIHOME_PROTOCOL, 'miot').toLowerCase();

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
      const statusProp = Array.isArray(props)
        ? props.find((p) => p.siid === 2 && p.piid === 1)
        : null;
      const faultProp = Array.isArray(props)
        ? props.find((p) => p.siid === 2 && p.piid === 2)
        : null;
      const batteryProp = Array.isArray(props)
        ? props.find((p) => p.siid === 3 && p.piid === 1)
        : null;

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

  // Ignore non-critical maintenance & dock reminders (such as X20+ station code 68),
  // and never show a "stopped" error while the vacuum is peacefully docked/charging.
  const isCriticalError =
    rawErrorCode !== 0 &&
    !IGNORED_MAINTENANCE_CODES.has(rawErrorCode) &&
    Boolean(CRITICAL_ERROR_MAP_CS[rawErrorCode]) &&
    mappedState.state !== 'charging';

  let errorMessage = null;
  if (isCriticalError) {
    errorMessage = CRITICAL_ERROR_MAP_CS[rawErrorCode];
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
 * Shared HTTP handler used by Firebase Cloud Functions, Vercel, and the local Node server.
 */
async function handleVacuumRequest(req, res) {
  try {
    let bodyObj = req.body;
    if (typeof bodyObj === 'string' && bodyObj.trim().length > 0) {
      try {
        bodyObj = JSON.parse(bodyObj);
      } catch (_) {
        bodyObj = {};
      }
    }

    const action = (req.method === 'GET' ? req.query?.action : bodyObj?.action) || 'status';

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
          if (bodyObj?.rawState !== undefined) {
            simulatedVacuum.state = Number(bodyObj.rawState);
          }
          if (bodyObj?.rawErrorCode !== undefined) {
            simulatedVacuum.error_code = Number(bodyObj.rawErrorCode);
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
      debugReason: error.message || String(error),
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

/**
 * Firebase Cloud Function Backend for Xiaomi Vacuum Control via `node-mihome`
 */

const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const mihome = require('node-mihome');

// Reuse Xiaomi Cloud session across warm Cloud Function invocations
let isAuthenticated = false;

/**
 * Authenticates with Xiaomi Cloud API using `node-mihome`.
 */
async function ensureXiaomiLogin() {
  if (isAuthenticated) return;

  const username = process.env.MIHOME_USERNAME;
  const password = process.env.MIHOME_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing MIHOME_USERNAME or MIHOME_PASSWORD environment variables.');
  }

  await mihome.miCloudProtocol.login(username, password);
  isAuthenticated = true;
}

/**
 * Executes a raw miIO command via Xiaomi Cloud API (`node-mihome`).
 * Retries once on session expiration.
 */
async function callVacuumMethod(method, params = []) {
  const deviceId = process.env.MIHOME_DEVICE_ID;
  const country = process.env.MIHOME_COUNTRY || 'de';

  if (!deviceId) {
    throw new Error('Missing MIHOME_DEVICE_ID environment variable.');
  }

  await ensureXiaomiLogin();

  try {
    return await mihome.miCloudProtocol.miioCall(deviceId, method, params, { country });
  } catch (err) {
    // Re-authenticate once if Xiaomi Cloud token expired
    isAuthenticated = false;
    await ensureXiaomiLogin();
    return await mihome.miCloudProtocol.miioCall(deviceId, method, params, { country });
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
  };
}

/**
 * Main HTTPS Cloud Function (`vacuum`)
 */
exports.vacuum = onRequest({ region: 'europe-west1', cors: true }, (req, res) => {
  cors(req, res, async () => {
    try {
      const action = (req.method === 'GET' ? req.query.action : req.body?.action) || 'status';

      switch (action) {
        case 'start':
          await callVacuumMethod('app_start', []);
          break;

        case 'pause':
          await callVacuumMethod('app_pause', []);
          break;

        case 'dock':
          // First pause/stop any active cleaning or stuck state, then command return to dock
          try {
            await callVacuumMethod('app_pause', []);
          } catch (_) {
            // Ignore if already paused/stopped
          }
          await callVacuumMethod('app_charge', []);
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
  });
});

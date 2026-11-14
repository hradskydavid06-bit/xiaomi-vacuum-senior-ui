# Ovládání vysavače (Xiaomi Smart Vacuum Senior Controller)

An accessible, high-contrast, Czech-only mobile web application and Firebase Cloud Function backend built to let a senior with low technical literacy control a Xiaomi / Roborock smart vacuum effortlessly.

---

## Key Features

1. **Senior-First UX (WCAG AAA)**:
   - Massive high-contrast buttons that fill `100dvh` with **zero scrolling** and **zero menus**.
   - Clear color coding (`🟢` Green = working/ready, `🟡` Yellow = charging/transitioning, `🔴` Red = requires attention).
   - Tactile depression states and mobile haptic feedback (`navigator.vibrate`) on button presses.

2. **Reassuring Czech Error Translation & Maintenance Filtering (`functions/index.js`)**:
   - Connects to the Xiaomi Cloud API via `node-mihome` (and automatically falls back to a stateful Xiaomi miIO simulator if credentials are not yet configured).
   - Translates hardware fault codes (e.g., tangled main brush, missing dustbin, cliff sensor) into calm, jargon-free Czech sentences.
   - **Suppresses non-critical maintenance warnings** (filter life, sensor wipe timers, brush wear counters) so the senior is never alarmed by routine maintenance reminders.

3. **Frontend State Consistency Watchdog (`public/app.js`)**:
   - Tracks `expectedState` (`cleaning`, `paused`, `docking`) with a 12-second transition grace window after any button press.
   - If the vacuum enters an unexpected state (e.g., `idle`, `positioning`, or `returning` when expected to be `cleaning`), the UI intercepts the state, displays:
     > 🔴 *"Vysavač je zmatený. Klikněte na 'Zpět do stanice' a zkuste to znovu."*
   - Automatically highlights and pulses the **Zpět do stanice** button to guide recovery.

---

## Project Structure

```text
xiaomi-vacuum-senior-ui/
├── firebase.json            # Firebase Hosting + Cloud Function rewrite config
├── package.json             # Root scripts (`npm start`, `npm test`, `npm run deploy`)
├── server.js                # Local standalone HTTP server + API router
├── test.js                  # Automated verification suite
├── public/                  # Mobile-first frontend web app
│   ├── index.html           # Semantic Czech UI (zero menus, 3 giant buttons)
│   ├── style.css            # WCAG AAA high-contrast styling
│   └── app.js               # Polling controller & State Watchdog
└── functions/               # Node.js Serverless Backend
    ├── index.js             # Xiaomi Cloud API (`node-mihome`) & Czech translation map
    ├── package.json         # Backend dependencies
    └── .env.example         # Environment variable template
```

---

## Quick Start (Run Locally)

```bash
npm run install:functions
npm test
npm start
```
Then open `http://localhost:3000`.

---

## Configure Real Xiaomi Cloud Credentials & Deploy to Firebase

### 1. Configure Xiaomi Cloud Credentials
Copy `functions/.env.example` to `functions/.env` and fill in your Xiaomi Cloud credentials and numeric device ID:
```bash
cp functions/.env.example functions/.env
```
```ini
MIHOME_USERNAME="your-xiaomi-email@example.com"
MIHOME_PASSWORD="your-xiaomi-password"
MIHOME_DEVICE_ID="123456789"
MIHOME_COUNTRY="de"
```

### 2. Link Firebase Project & Deploy
```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use --add
npm run deploy
```

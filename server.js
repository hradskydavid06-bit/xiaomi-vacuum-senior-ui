/**
 * Universal HTTP Server & Vercel Node Preset Handler
 * Serves both static frontend (`public/`) and `/api/vacuum` in local and serverless environments.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load `functions/.env` if present locally
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

module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

const { handleVacuumRequest } = require('./functions/index.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function requestListener(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Route API requests to the Vacuum Cloud Function handler
  if (pathname === '/api/vacuum' || pathname === '/api/vacuum.js') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const expressLikeRes = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        res.writeHead(this.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(payload));
      },
    };

    req.query = req.query || parsedUrl.query || {};

    if (req.body !== undefined) {
      handleVacuumRequest(req, expressLikeRes);
      return;
    }

    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', async () => {
      try {
        req.body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_) {
        req.body = {};
      }
      await handleVacuumRequest(req, expressLikeRes);
    });
    return;
  }

  // Serve static frontend files from `public/`
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

// Start standalone HTTP server when run directly (`node server.js`),
// and export handler for Vercel's Node preset
if (require.main === module) {
  const server = http.createServer(requestListener);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Xiaomi Vacuum Senior UI running at http://localhost:${PORT}`);
  });
}

module.exports = requestListener;

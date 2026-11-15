/**
 * Pure Node.js Zero-Dependency Xiaomi Cloud Client (`miCloudProtocol` compatible)
 * Implements Xiaomi Account authentication, 2FA token persistence, passToken auto-refresh,
 * and signed requests to `de.api.io.mi.com`.
 */

const crypto = require('crypto');

function cleanEnv(val, fallback = '') {
  if (!val) return fallback;
  return String(val).trim().replace(/^["']|["']$/g, '').trim();
}

// Pre-verified session configuration for Xiaomi Robot Vacuum X20+ (did: 1172182642)
const DEFAULT_X20_SESSION = {
  userId: '8303841440',
  deviceId: '1172182642',
  country: 'de',
  clientDeviceId: 'XIAOMIVACUUMCZ01',
  ssecurity: 'Gte9otaxepl7G5KWVVN22w==',
  serviceToken:
    'unxrtpNcmYy3B5LSm6ZyV2lhididYvknBPw33TCQfdfjwxIBlp2tHhfCnOjX5UoH8ElEDJHIRAC5Aol+eRWukhMvo6CA54oR/0cPCt44+U5xmBKOn5iFGhUFfD10xwZHJ54qkz5YnpI0EsVI4h84zVQ8c7tEZuPoYZGx/2oCe8bx8n1UCK0QLhXKORB2JaTPS0pMVHo7xoXrhaMzgzl7DA==',
  passToken:
    'V1:9d2wTZnSKA8D7PcQtwbCZBARst1ZodphQbPCqndObq1l666rUXN0WsmtcLGZ95PCNqIiNsSj6wNjT/VTyk25oM8C6rIwXWSiXo0pZwn7wgEMa2JamFYEBt+FkK19m6itBOfoLjeLepLjuyAwoebTm/WF3fv0Fr/+0vsRcJDsR8xePBnXFqmPQTtYcnUu8RNmXfkIPGXWhPycIeytZgIJl7U48BeevPvwPeC43ULFfDT1/WqImT+nbjTWBpuE7t+Wvdwe+gI4ARCEbYgbqZ5ThquB6F2JZfDu2l/jjUutCnCIMdNpKo673KepSc/ALC4gbi/g4BbzG52jQtEci5QoCA==',
};

class XiaomiCloudClient {
  constructor() {
    this.userId = null;
    this.ssecurity = null;
    this.serviceToken = null;
    this.cUserId = null;
    this.passToken = null;
    this.isLoggedIn = false;
    this.deviceId = DEFAULT_X20_SESSION.clientDeviceId;
  }

  get userAgent() {
    return `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${this.deviceId} APP/xiaomi.smarthome APPV/62830`;
  }

  static stripPrefix(text) {
    const prefix = '&&&START&&&';
    if (typeof text === 'string' && text.startsWith(prefix)) {
      return text.slice(prefix.length);
    }
    return text;
  }

  static generateNonce() {
    const randomBuf = crypto.randomBytes(8);
    const timeMin = Math.floor(Date.now() / 60000);
    const timeBuf = Buffer.alloc(4);
    timeBuf.writeInt32BE(timeMin, 0);
    return Buffer.concat([randomBuf, timeBuf]).toString('base64');
  }

  signedNonce(nonce) {
    const ssecBuf = Buffer.from(this.ssecurity, 'base64');
    const nonceBuf = Buffer.from(nonce, 'base64');
    return crypto
      .createHash('sha256')
      .update(Buffer.concat([ssecBuf, nonceBuf]))
      .digest('base64');
  }

  generateSignature(urlPath, signedNonceStr, nonce, params) {
    const parts = [urlPath, signedNonceStr, nonce];
    const paramKeys = Object.keys(params).sort();
    for (const k of paramKeys) {
      parts.push(`${k}=${params[k]}`);
    }
    return crypto
      .createHmac('sha256', Buffer.from(signedNonceStr, 'base64'))
      .update(parts.join('&'))
      .digest('base64');
  }

  /**
   * Refreshes `ssecurity` and `serviceToken` using the trusted `passToken` + `userId`
   * without requiring password or 2FA verification.
   */
  async refreshFromPassToken() {
    const userId = this.userId || cleanEnv(process.env.MIHOME_USER_ID, DEFAULT_X20_SESSION.userId);
    const passToken =
      this.passToken || cleanEnv(process.env.MIHOME_PASS_TOKEN, DEFAULT_X20_SESSION.passToken);

    if (!userId || !passToken) {
      throw new Error('Missing userId or passToken for session refresh.');
    }

    const cookieHeader = `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId}; userId=${userId}; passToken=${passToken}`;
    const rLogin = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        Cookie: cookieHeader,
      },
    });

    const jLogin = JSON.parse(XiaomiCloudClient.stripPrefix(await rLogin.text()));
    if (!jLogin.ssecurity || !jLogin.location) {
      throw new Error(`passToken refresh failed (code ${jLogin.code})`);
    }

    const rSts = await fetch(jLogin.location, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': this.userAgent,
      },
    });

    const rawCookies =
      typeof rSts.headers.getSetCookie === 'function'
        ? rSts.headers.getSetCookie()
        : [rSts.headers.get('set-cookie') || ''];

    let newServiceToken = null;
    for (const cookieStr of rawCookies) {
      const match = cookieStr.match(/serviceToken=([^;]+)/);
      if (match) {
        newServiceToken = match[1];
        break;
      }
    }

    if (!newServiceToken) {
      throw new Error('Failed to extract refreshed serviceToken cookie.');
    }

    this.userId = String(jLogin.userId || userId);
    this.ssecurity = jLogin.ssecurity;
    this.serviceToken = newServiceToken;
    this.passToken = jLogin.passToken || passToken;
    this.isLoggedIn = true;
  }

  async login(username, password) {
    const userId = cleanEnv(process.env.MIHOME_USER_ID, DEFAULT_X20_SESSION.userId);
    const ssecurity = cleanEnv(process.env.MIHOME_SSECURITY, DEFAULT_X20_SESSION.ssecurity);
    const serviceToken = cleanEnv(
      process.env.MIHOME_SERVICE_TOKEN,
      DEFAULT_X20_SESSION.serviceToken
    );
    const passToken = cleanEnv(process.env.MIHOME_PASS_TOKEN, DEFAULT_X20_SESSION.passToken);

    if (userId && ssecurity && serviceToken) {
      this.userId = userId;
      this.ssecurity = ssecurity;
      this.serviceToken = serviceToken;
      this.passToken = passToken;
      this.isLoggedIn = true;
      return;
    }

    if (userId && passToken) {
      await this.refreshFromPassToken();
      return;
    }

    // Standard username/password login fallback
    const cleanUser = cleanEnv(username);
    const cleanPass = cleanEnv(password);

    const step1Url = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true';
    const step1Res = await fetch(step1Url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        Cookie: `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId}; userId=${cleanUser}`,
      },
    });
    const step1Text = XiaomiCloudClient.stripPrefix(await step1Res.text());
    const step1Json = JSON.parse(step1Text);
    const sign = step1Json._sign;

    const hash = crypto.createHash('md5').update(cleanPass).digest('hex').toUpperCase();
    const form = new URLSearchParams({
      sid: 'xiaomiio',
      hash,
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      user: cleanUser,
      _sign: sign,
      _json: 'true',
    });

    const step2Res = await fetch('https://account.xiaomi.com/pass/serviceLoginAuth2', {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId}; userId=${cleanUser}`,
      },
      body: form.toString(),
    });

    const step2Text = XiaomiCloudClient.stripPrefix(await step2Res.text());
    const step2Json = JSON.parse(step2Text);

    if (!step2Json.ssecurity || !step2Json.location) {
      throw new Error(
        `Xiaomi login failed (code ${step2Json.code}): ${step2Json.desc || step2Json.description || '2FA or invalid credentials'}`
      );
    }

    this.userId = step2Json.userId;
    this.ssecurity = step2Json.ssecurity;
    this.cUserId = step2Json.cUserId;
    this.passToken = step2Json.passToken;

    const step3Res = await fetch(step2Json.location, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': this.userAgent,
      },
    });

    const rawCookies =
      typeof step3Res.headers.getSetCookie === 'function'
        ? step3Res.headers.getSetCookie()
        : [step3Res.headers.get('set-cookie') || ''];

    for (const cookieStr of rawCookies) {
      const match = cookieStr.match(/serviceToken=([^;]+)/);
      if (match) {
        this.serviceToken = match[1];
        break;
      }
    }

    if (!this.serviceToken) {
      throw new Error('Failed to retrieve Xiaomi Cloud serviceToken cookie.');
    }

    this.isLoggedIn = true;
  }

  getApiBaseUrl(country = 'de') {
    const region = cleanEnv(country, 'de').toLowerCase();
    return region === 'cn'
      ? 'https://api.io.mi.com/app'
      : `https://${region}.api.io.mi.com/app`;
  }

  async executeSignedPost(urlPath, dataObj, country = 'de') {
    const nonce = XiaomiCloudClient.generateNonce();
    const signedNonceStr = this.signedNonce(nonce);
    const params = {
      data: JSON.stringify(dataObj),
    };
    const signature = this.generateSignature(urlPath, signedNonceStr, nonce, params);

    const form = new URLSearchParams({
      signature,
      _nonce: nonce,
      data: params.data,
    });

    const fullUrl = `${this.getApiBaseUrl(country)}${urlPath}`;
    return await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: [
          `userId=${this.userId}`,
          `yetAnotherServiceToken=${this.serviceToken}`,
          `serviceToken=${this.serviceToken}`,
          `locale=cs_CZ`,
          `timezone=GMT%2B01%3A00`,
          `is_daylight=1`,
          `dst_offset=3600000`,
          `channel=MI_APP_STORE`,
        ].join('; '),
      },
      body: form.toString(),
    });
  }

  async request(urlPath, dataObj, country = 'de') {
    if (!this.isLoggedIn) {
      await this.login();
    }

    let res = await this.executeSignedPost(urlPath, dataObj, country);

    // If serviceToken expired or was rejected on a new serverless IP, refresh via passToken and retry
    if (res.status === 401 || res.status === 403) {
      await this.refreshFromPassToken();
      res = await this.executeSignedPost(urlPath, dataObj, country);
    }

    if (!res.ok) {
      throw new Error(`Xiaomi Cloud HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.code !== 0) {
      throw new Error(`Xiaomi Cloud RPC Error (code ${json.code}): ${json.message || 'Unknown error'}`);
    }
    return json.result;
  }

  async getDevices(deviceIds = null, options = {}) {
    const country = options.country || 'de';
    const result = await this.request(
      '/home/device_list',
      { getVirtualModel: false, getHuamiDevices: 0 },
      country
    );
    const list = result?.list || [];
    if (Array.isArray(deviceIds) && deviceIds.length > 0) {
      return list.filter((d) => deviceIds.includes(d.did));
    }
    return list;
  }

  async miioCall(deviceId, method, params = [], options = {}) {
    const country = options.country || 'de';
    return await this.request(
      `/home/rpc/${deviceId}`,
      { id: Math.floor(Math.random() * 10000) + 1, method, params },
      country
    );
  }
}

module.exports = {
  miCloudProtocol: new XiaomiCloudClient(),
  XiaomiCloudClient,
  DEFAULT_X20_SESSION,
  cleanEnv,
};

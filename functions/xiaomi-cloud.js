/**
 * Pure Node.js Zero-Dependency Xiaomi Cloud Client (`miCloudProtocol` compatible)
 * Implements Xiaomi Account authentication and signed requests to `api.io.mi.com`.
 */

const crypto = require('crypto');

class XiaomiCloudClient {
  constructor() {
    this.userId = null;
    this.ssecurity = null;
    this.serviceToken = null;
    this.cUserId = null;
    this.passToken = null;
    this.isLoggedIn = false;
    this.agentId = crypto.randomBytes(8).toString('hex').toUpperCase();
    this.deviceId = crypto.randomBytes(6).toString('hex');
  }

  get userAgent() {
    return `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${this.agentId} APP/xiaomi.smarthome APPV/62830`;
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

  async login(username, password) {
    // Use pre-verified permanent session tokens if present in environment
    if (
      process.env.MIHOME_USER_ID &&
      process.env.MIHOME_SSECURITY &&
      process.env.MIHOME_SERVICE_TOKEN
    ) {
      this.userId = process.env.MIHOME_USER_ID;
      this.ssecurity = process.env.MIHOME_SSECURITY;
      this.serviceToken = process.env.MIHOME_SERVICE_TOKEN;
      this.passToken = process.env.MIHOME_PASS_TOKEN || null;
      this.isLoggedIn = true;
      return;
    }

    // Step 1: Fetch _sign token
    const step1Url = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true';
    const step1Res = await fetch(step1Url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        Cookie: `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId}; userId=${username}`,
      },
    });
    const step1Text = XiaomiCloudClient.stripPrefix(await step1Res.text());
    const step1Json = JSON.parse(step1Text);
    const sign = step1Json._sign;

    // Step 2: Authenticate with MD5 password hash
    const hash = crypto.createHash('md5').update(password).digest('hex').toUpperCase();
    const form = new URLSearchParams({
      sid: 'xiaomiio',
      hash,
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      user: username,
      _sign: sign,
      _json: 'true',
    });

    const step2Res = await fetch('https://account.xiaomi.com/pass/serviceLoginAuth2', {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId}; userId=${username}`,
      },
      body: form.toString(),
    });

    const step2Text = XiaomiCloudClient.stripPrefix(await step2Res.text());
    const step2Json = JSON.parse(step2Text);

    if (step2Json.notificationUrl) {
      throw new Error(
        `Xiaomi Account requires 2FA verification. Open or verify in Xiaomi account: ${step2Json.notificationUrl}`
      );
    }

    if (!step2Json.ssecurity || !step2Json.location) {
      throw new Error(
        `Xiaomi login failed (code ${step2Json.code}): ${step2Json.desc || step2Json.description || 'Invalid credentials'}`
      );
    }

    this.userId = step2Json.userId;
    this.ssecurity = step2Json.ssecurity;
    this.cUserId = step2Json.cUserId;
    this.passToken = step2Json.passToken;

    // Step 3: Follow STS callback location to obtain serviceToken cookie
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
    const region = (country || 'de').toLowerCase();
    return region === 'cn'
      ? 'https://api.io.mi.com/app'
      : `https://${region}.api.io.mi.com/app`;
  }

  async request(urlPath, dataObj, country = 'de') {
    if (!this.isLoggedIn) {
      throw new Error('Not logged into Xiaomi Cloud.');
    }

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
    const res = await fetch(fullUrl, {
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
};

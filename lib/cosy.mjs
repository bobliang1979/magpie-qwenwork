// QwenWork 国内版 COSY 协议：签名 + 编码（已用真实凭证验证 model/list 返回 200）
// 来源：Agent2Providers beta 分支 wasm/qwenwork/src/{cosy.rs,endpoints.rs} 移植
import crypto from 'node:crypto';

export const ORIGIN = 'https://gateway.qwenwork.cn';
export const ENDPOINTS = {
  MODELS: '/algo/api/v2/model/list?Encode=1',
  CHAT: '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
  DEVICE_LOGIN: '/device/selectAccounts',
  DEVICE_POLL: '/api/v1/deviceToken/poll',
  DEVICE_REFRESH: '/api/v1/deviceToken/refresh',
  USER_INFO: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
};

const RSA_MODULUS = "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const CUSTOM = Buffer.from("_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!", "ascii");
const STANDARD = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "ascii");
const COSY_VERSION = '1.1.52';
const CLIENT_TYPE = '6';

const rsaKey = crypto.createPublicKey({
  key: { kty: 'RSA', n: Buffer.from(RSA_MODULUS, 'hex').toString('base64url'), e: 'AQAB' },
  format: 'jwk',
});

/** Encode=1: 标准 base64 → 尾/中/首段重排 → 字母表替换（不是压缩） */
export function encode(payload) {
  const std = Buffer.from(payload.toString('base64'), 'ascii');
  const third = Math.floor(std.length / 3);
  const table = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0; i < STANDARD.length; i++) table[STANDARD[i]] = CUSTOM[i];
  table['='.charCodeAt(0)] = '$'.charCodeAt(0);
  const reorder = Buffer.concat([std.subarray(std.length - third), std.subarray(third, std.length - third), std.subarray(0, third)]);
  return Buffer.from(Array.from(reorder, b => table[b]));
}

/**
 * 构造 COSY 签名头。
 * creds: { access, user, machine, name, email, isBiz?, organization? }
 */
export function headers(path, bodyBuf, creds) {
  if (!creds.user || !creds.machine || !creds.access) {
    throw new Error('QwenWork COSY 缺少 user/machine/access');
  }
  const key = crypto.randomBytes(16);
  const infoObj = { uid: creds.user, security_oauth_token: creds.access, name: creds.name || '', aid: '', email: creds.email || '' };
  if (creds.isBiz) infoObj.organization_id = creds.organization || '';
  const info = JSON.stringify(infoObj);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key); // IV = key（既有线协议）
  const infoB64 = Buffer.concat([cipher.update(Buffer.from(info, 'utf8')), cipher.final()]).toString('base64');
  const cosyKey = crypto.publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING }, key).toString('base64');
  const request = crypto.randomUUID();
  const timestamp = String(Date.now());
  const payload = JSON.stringify({ version: 'v1', requestId: request, info: infoB64, cosyVersion: COSY_VERSION, ideVersion: '' });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  const sigPath = path.split('?')[0].replace(/^\/algo/, '');
  const h = crypto.createHash('md5');
  for (const part of [payloadB64, cosyKey, timestamp, bodyBuf.toString('binary')]) {
    h.update(part); h.update('\n');
  }
  h.update(sigPath);
  return {
    Authorization: `Bearer COSY.${payloadB64}.${h.digest('hex')}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.user,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': creds.machine,
    'Cosy-Machinetoken': creds.machine,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': 'x86_64_windows',
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': creds.machine,
    'Cosy-Sigpath': sigPath,
    'Cosy-Bodyhash': crypto.createHash('md5').update(bodyBuf).digest('hex'),
    'Cosy-Bodylength': String(bodyBuf.length),
    'Cosy-Data-Policy': 'agree',
    'Cosy-Organization-Id': creds.organization || '',
    'Cosy-Organization-Tags': '',
    'Cosy-Scene': 'qwork',
    'Cosy-Business-Product': 'qoder_work',
    'Cosy-Business-Type': 'agent',
    'Login-Version': 'v2',
    'X-Request-Id': request,
    'User-Agent': 'qoderwork/1.1.0',
  };
}

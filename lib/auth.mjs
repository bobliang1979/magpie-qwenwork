// QwenWork 国内版凭证读取与存储
// 从桌面客户端 auth-v2.dat 解密（DPAPI + AES-GCM），或设备码登录；DPAPI 加密存储
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLIENT_DIR = 'C:/Users/10074/AppData/Roaming/QwenWorkCN';
const VAULT_DIR = 'C:/Users/10074/AppData/Local/magpie-qwenwork/vault';
const VAULT_FILE = join(VAULT_DIR, 'account.json');
const MAGIC = Buffer.from('QWKW1\0', 'binary');

function dpapi(data, unprotect=true){
  const ps = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class D {
 [StructLayout(LayoutKind.Sequential)] struct B { public int cbData; public IntPtr pbData; }
 [DllImport("crypt32.dll", SetLastError=true)] static extern bool Crypt${unprotect?'Unprotect':'Protect'}Data(ref B i, IntPtr a, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
 public static byte[] ${unprotect?'U':'P'}(byte[] d){ B i=new B(); B o=new B(); i.cbData=d.Length; i.pbData=Marshal.AllocHGlobal(d.Length); Marshal.Copy(d,0,i.pbData,d.Length);
 try { if(!Crypt${unprotect?'Unprotect':'Protect'}Data(ref i,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,0,ref o)) throw new Exception(Marshal.GetLastWin32Error().ToString());
 byte[] r=new byte[o.cbData]; Marshal.Copy(o.pbData,r,0,o.cbData); return r; } finally { Marshal.FreeHGlobal(i.pbData); if(o.pbData!=IntPtr.Zero) Marshal.FreeHGlobal(o.pbData);} }
}
'@
$b64=[Console]::In.ReadToEnd().Trim(); $raw=[Convert]::FromBase64String($b64); [Console]::Out.Write([Convert]::ToBase64String([D]::${unprotect?'U':'P'}($raw)))
`;
  const out = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', ps],
    {input: data.toString('base64'), encoding:'utf8'});
  return Buffer.from(out.trim(), 'base64');
}

/** 从桌面客户端 auth-v2.dat 解密出凭证（已实测成功） */
export function readDesktopCredentials(){
  const authPath = join(CLIENT_DIR, 'auth-v2.dat');
  const lsPath = join(CLIENT_DIR, 'Local State');
  if (!existsSync(authPath) || !existsSync(lsPath)) throw new Error('未找到 QwenWorkCN 客户端登录态');
  const ls = JSON.parse(readFileSync(lsPath,'utf8'));
  const encKey = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  const master = dpapi(encKey.subarray(5), true);
  const raw = readFileSync(authPath);
  if (raw.subarray(0,3).toString('ascii') !== 'v10') throw new Error('auth-v2.dat 格式不支持');
  const nonce = raw.subarray(3,15), payload = raw.subarray(15);
  const tag = payload.subarray(payload.length-16), body = payload.subarray(0,payload.length-16);
  const dec = createDecipheriv('aes-256-gcm', master, nonce);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(body), dec.final()]);
  const data = JSON.parse(plain.toString('utf8'));
  return {
    access: data.token,
    refresh: data.refreshToken,
    user: data.user.id,
    machine: data.loginDeviceId,
    name: data.user.name || data.user.username || '',
    email: data.user.email || '',
    isBiz: !!data.user.isBiz,
    organization: data.user.orgId || '',
    expiresAt: data.expiresAt,
    endpoints: data.endpoints,
    source: 'desktop',
  };
}

/** DPAPI 加密存储凭证 */
export function saveCredentials(creds){
  mkdirSync(VAULT_DIR, {recursive:true});
  const plain = Buffer.from(JSON.stringify(creds), 'utf8');
  const sealed = Buffer.concat([MAGIC, dpapi(plain, false)]);
  writeFileSync(VAULT_FILE, sealed);
}
export function loadCredentials(){
  if (!existsSync(VAULT_FILE)) return null;
  const sealed = readFileSync(VAULT_FILE);
  if (sealed.subarray(0,MAGIC.length).toString('binary') !== MAGIC.toString('binary')) return null;
  const plain = dpapi(sealed.subarray(MAGIC.length), true);
  return JSON.parse(plain.toString('utf8'));
}

/** 设备码登录（备用，复用已验证的 device_login 逻辑） */
export async function deviceLoginStart(){
  const crypto = await import('node:crypto');
  const ORIGIN = 'https://gateway.qwenwork.cn';
  const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const nonce = crypto.randomUUID(), machine = crypto.randomUUID();
  const p = new URLSearchParams({challenge, challenge_method:'S256', machine_id:machine,
    nonce, client_id:CLIENT_ID, redirect_uri:'qwenwork-cn://'});
  return {url:`${ORIGIN}/device/selectAccounts?${p}`, nonce, verifier, machine};
}

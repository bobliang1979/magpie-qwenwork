/**
 * QwenWork 千问办公国内版（gateway.qwenwork.cn）的 magpie 供应商插件。
 * 把 QwenWork 订阅里的模型（qwen4-max / deepseek-v4-pro / glm-5.3 等）
 * 变成 magpie 网关上的 OpenAI 兼容模型，供 Hermes / WorkBuddy / Claude Code 等调用。
 * 协议来源：Agent2Providers beta 分支 wasm/qwenwork（COSY 签名 + SSE 对话），已端到端实测。
 */
import { readDesktopCredentials, loadCredentials, saveCredentials, deviceLoginStart } from './lib/auth.mjs';
import { fetchModels, magpieModels, buildProvider, FALLBACK } from './lib/models.mjs';
import { chat } from './lib/chat.mjs';
import { ORIGIN as ORIGIN_URL } from './lib/cosy.mjs';

export const PROVIDER = 'qwenwork';

export default async function QwenWorkPlugin(input = {}) {
  const sessions = new Map();
  let deviceFlow = null;

  function credsFromAuth(auth){
    if (auth?.key) { try { return JSON.parse(auth.key); } catch {} }
    return loadCredentials() || readDesktopCredentials();
  }

  function sessionFor(auth){
    const creds = credsFromAuth(auth);
    const cacheKey = creds.user || 'default';
    let s = sessions.get(cacheKey);
    if (!s) {
      const models = new Map();
      s = {
        credentials: creds,
        modelRow(key){
          if (!key) return FALLBACK[0];
          return models.get(key) || FALLBACK.find(m=>m.key===key) || {key, display_name:key, format:'openai', is_vl:true, is_reasoning:true, max_input_tokens:1000000, source:'system'};
        },
        async refreshModels(){
          const rows = await fetchModels(creds);
          for (const r of rows) models.set(r.key, r);
          return rows;
        },
      };
      sessions.set(cacheKey, s);
    }
    return s;
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= buildProvider();
      cfg.provider[PROVIDER].models ??= magpieModels(FALLBACK, PROVIDER);
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      methods: [
        // ① 从桌面客户端读取（已登录 QwenWorkCN 即可，零操作）
        {
          type: 'api',
          keyless: true,
          label: '从 QwenWork 国内版客户端读取登录态',
          placeholder: '本机已登录的 QwenWorkCN 账号',
          async authorize(){
            try {
              const creds = readDesktopCredentials();
              saveCredentials(creds);
              return {
                type:'success',
                key: JSON.stringify(creds),
                accountId: creds.user,
                metadata: {email: creds.email, uid: creds.user, name: creds.name, source:'desktop'},
              };
            } catch(e){
              return {type:'failed', error:'读取客户端登录态失败：'+String(e.message||e).slice(0,300)};
            }
          },
          async fetch(input, init){ return chat(sessionFor(null), input, init); },
        },
        // ② 设备码登录（备用，网页确认）
        {
          type: 'api',
          keyless: true,
          label: '用设备码登录 QwenWork 国内版',
          placeholder: '打开授权页登录，无需客户端',
          async authorize(){
            try {
              deviceFlow = await deviceLoginStart();
              return {
                type:'device',
                url: deviceFlow.url,
                instructions:'请在浏览器打开授权页并登录确认，然后轮询取票。',
                pollInterval: 2000,
              };
            } catch(e){ return {type:'failed', error:String(e.message||e).slice(0,300)}; }
          },
          async fetch(input, init){ return chat(sessionFor(null), input, init); },
        },
      ],

      // 关键：loader 返回的 fetch 才是真正的请求拦截点。
      // 没有它，magpie 会用 api.url + bearer token 直接发标准 OpenAI 请求，
      // 把整个凭证 JSON 当 token 发出去（QwenWork 不接受，必须 COSY 签名）。
      async loader(getAuth) {
        const auth = await getAuth();
        return {
          baseURL: ORIGIN_URL + '/v1',
          apiKey: '***',
          async fetch(input_, init) {
            return chat(sessionFor(auth), input_, init);
          },
        };
      },

      async usage(getAuth){
        const s = sessionFor(await getAuth());
        try { await s.refreshModels(); }
        catch(e){ return {error:String(e.message||e).slice(0,300), windows:[]}; }
        return {windows:[], note:'QwenWork 国内版（额度以客户端为准）'};
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, {auth}={}){
        if (!auth) return provider.models;
        try {
          const s = sessionFor(auth);
          const rows = await s.refreshModels();
          return magpieModels(rows, PROVIDER);
        } catch(e){
          return provider.models;
        }
      },
    },
  };
}

export const _internal = { PROVIDER, readDesktopCredentials, loadCredentials, saveCredentials };

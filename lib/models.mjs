// QwenWork 国内版模型目录（已实测 model/list 返回 13 个模型含 qwen4-max）
import https from 'node:https';
import { headers, ENDPOINTS, ORIGIN } from './cosy.mjs';

const FALLBACK = [
  {key:'qwen4-max', display_name:'Qwen4-Max', is_vl:true, is_reasoning:true, format:'anthropic', source:'system', max_input_tokens:1000000, price_factor:1.6},
  {key:'flash', display_name:'标准', is_vl:true, is_reasoning:true, format:'openai', source:'system', max_input_tokens:1000000, price_factor:0.1},
  {key:'pro', display_name:'高级', is_vl:true, is_reasoning:true, format:'openai', source:'system', max_input_tokens:1000000, price_factor:1},
];

/** 从上游拉取模型目录（COSY 签名，已验证 200） */
export function fetchModels(creds){
  return new Promise((resolve,reject)=>{
    const path = ENDPOINTS.MODELS;
    const h = headers(path, Buffer.from(''), creds);
    const req = https.request(ORIGIN+path, {method:'GET', headers:h}, (res)=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error('模型目录 HTTP '+res.statusCode+': '+d.slice(0,200)));
        try {
          const j=JSON.parse(d);
          resolve(j.qwork || j.data?.qwork || FALLBACK);
        } catch(e){ reject(e); }
      });
    });
    req.on('error',reject); req.end();
  });
}

/**
 * magpieModels: 转成 magpie 的模型描述格式。
 * 关键：必须返回 {id: entry} 对象（不是数组），否则 magpie 会用数组索引当模型 id。
 * 字段形状对齐 magpie-doubao-work-auth/lib/models.mjs 的 magpieModels。
 */
export function magpieModels(rows, provider='qwenwork'){
  const apiUrl = ORIGIN + '/v1';
  return Object.fromEntries(rows.map(row=>{
    const id = row.key;
    const reasoning = !!(row.is_reasoning || row.thinking_config);
    const entry = {
      id,
      providerID: provider,
      name: row.display_name || row.key,
      api: { id, url: apiUrl, npm: '@ai-sdk/openai-compatible' },
      status: 'active',
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: row.max_input_tokens || 1000000, output: 0 },
      capabilities: {
        temperature: false,
        reasoning,
        attachment: !!row.is_vl,
        toolcall: true,
        input: { text:true, image:!!row.is_vl, audio:false, video:false, pdf:false },
        output: { text:true, image:false, audio:false, video:false, pdf:false },
        interleaved: false,
      },
      release_date: '',
      variants: reasoning ? {medium:{reasoningEffort:'medium'}, high:{reasoningEffort:'high'}} : {},
    };
    if (Number.isFinite(row.price_factor)) entry.rate = row.price_factor;
    return [id, entry];
  }));
}

export function buildProvider(){
  return {
    id: 'qwenwork',
    name: 'QwenWork 千问办公',
    api: ORIGIN + '/v1',
    models: magpieModels(FALLBACK),
  };
}
export { FALLBACK };

// 插件集成测试：模拟 Magpie 调用 config → auth → chat 全链路
import QwenWorkPlugin from './index.mjs';

const plugin = await QwenWorkPlugin();
console.log('1) 插件导出方法:', Object.keys(plugin));

// config 注册
const cfg = {};
await plugin.config(cfg);
console.log('2) config 注册 provider:', Object.keys(cfg.provider||{}), 'models:', cfg.provider?.qwenwork?.models?.length);

// 从桌面客户端读取凭证（授权）
const method = plugin.auth.methods[0];
const authResult = await method.authorize();
console.log('3) authorize:', authResult.type, 'accountId:', authResult.accountId?.slice(0,8)+'...');
if (authResult.type !== 'success') { console.log('AUTH FAILED:', authResult.error); process.exit(1); }
const auth = {type:'api', key: authResult.key};

// 模型列表
const modelsMap = await plugin.provider.models({models: cfg.provider.qwenwork.models}, {auth});
const modelIds = Object.keys(modelsMap);
console.log('4) models:', modelIds.length, modelIds.slice(0,6).join(', '));
if (!modelIds.includes('qwen4-max')) { console.log('❌ qwen4-max 不在模型列表'); process.exit(1); }
if (modelIds.includes('0') || modelIds.includes('1')) { console.log('❌ 模型 id 是数组索引(契约错误)'); process.exit(1); }

// chat（走 fetch 接口，OpenAI 兼容请求）
const body = JSON.stringify({model:'qwen4-max', messages:[{role:'user',content:'Reply with exactly: PLUGIN_E2E_OK'}], max_tokens:50});
console.log('5) chat 请求中...');
const res = await method.fetch('http://localhost/v1/chat/completions', {method:'POST', body});
console.log('   Response status:', res.status, 'CT:', res.headers.get('content-type'));
const reader = res.body.getReader();
const dec = new TextDecoder();
let text='', done=false;
while(!done){
  const r=await reader.read(); done=r.done;
  if(r.value){
    const s=dec.decode(r.value);
    // 提取 delta.content
    for(const line of s.split('\n')){
      if(!line.startsWith('data: ')||line.includes('[DONE]'))continue;
      try{const j=JSON.parse(line.slice(6)); const c=j.choices?.[0]?.delta?.content; if(c)text+=c;}catch{}
    }
  }
}
console.log('6) 收到回复:', JSON.stringify(text));
console.log(text.includes('PLUGIN_E2E_OK') ? '\n✅ 插件全链路通过' : '\n❌ 回复不符预期');

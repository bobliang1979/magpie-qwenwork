// QwenWork 国内版 chat 转发（已端到端验证 qwen4-max 返回真实回复）
// 导出 chat(session, input, init) → 标准 Response（SSE 流）
import crypto from 'node:crypto';
import https from 'node:https';
import { headers, encode, ENDPOINTS, ORIGIN } from './cosy.mjs';

function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function uuid(){ return crypto.randomUUID(); }
function truthy(v){ if(v==null)return false; if(typeof v==='boolean')return v; if(typeof v==='number')return v!==0; if(typeof v==='string')return v.length>0; return true; }
function msgText(c){ return typeof c==='string'?c:(Array.isArray(c)?c.map(p=>p?.text??p?.content??'').join(''):''); }

function recordId(model, msgs, lim){
  let h=sha256('qoder-record\0'+model);
  for(const m of msgs) h=sha256(h+'\0'+JSON.stringify(m));
  h=sha256(h+'\0mt='+lim);
  return h.slice(0,16);
}
function sessionId(user, model, seed){
  const base=sha256('qoder-session\0qwenwork\0'+user+'\0'+model).slice(0,16);
  return base+'-'+(seed?sha256(seed):uuid());
}

/** 从 QwenWork chat 请求体解析出我们的 payload */
function buildPayload(body, row, creds){
  const modelKey = body.model || row.key;
  const upstreamKey = row.key || modelKey;
  const reasoning = truthy(row.is_reasoning)||truthy(row.thinking_config);
  const vision = truthy(row.is_vl);
  const window = row.max_input_tokens || 1000000;
  let messages = Array.isArray(body.messages) ? body.messages.map(m=>({
    role: m.role, content: msgText(m.content)
  })).filter(m=>m.role && m.content) : [];
  if (!messages.length) throw Object.assign(new Error('messages 不能为空'), {status:400});
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const limit = Math.min(body.max_tokens || body.max_completion_tokens || 32768, 32768);
  const now = Date.now();
  const record = recordId(upstreamKey, messages, limit);
  const seed = body.prompt_cache_key || body.session_id || body.user;
  const session = sessionId(creds.user, upstreamKey, seed);
  const shaped = { key:upstreamKey, display_name:upstreamKey, model:'', format:row.format||'openai',
    is_vl:vision, is_reasoning:reasoning, api_key:'', url:'', source:'system', max_input_tokens:window };
  const parameters = { max_tokens:limit, context_length:window, enable_thinking:reasoning };
  for (const f of ['temperature','top_p','presence_penalty','frequency_penalty','stop','seed','response_format']) {
    if (body[f] != null) parameters[f] = body[f];
  }
  const last = [...messages].reverse().find(m=>m.role==='user')?.content || '';
  const payload = {
    request_id: uuid(), request_set_id: record, chat_record_id: record, session_id: session,
    stream:true, chat_task:'FREE_INPUT', is_reply:true, is_retry:false, source:1, version:'3',
    session_type:'qoder_work', agent_id:'agent_common', task_id:'common', code_language:'',
    chat_prompt:'', image_urls:null, aliyun_user_type:'', system:'',
    messages, tools, parameters, model_config:shaped,
    chat_context:{ chatPrompt:'', imageUrls:null, extra:{context:[],
      modelConfig:{key:upstreamKey,is_reasoning:reasoning}, originalContent:last}, features:[], text:last },
    business:{ product:'qoder_work', version:'1.1.52', type:'agent', stage:'processing',
      id:uuid(), name:last.slice(0,30), begin_at:now },
  };
  if (tools.length) {
    if (body.tool_choice != null) payload.tool_choice = body.tool_choice;
    if (body.parallel_tool_calls != null) payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  return { payload, reasoning, upstreamKey };
}

/** 解析 SSE 信封 → OpenAI chat.completion.chunk 文本帧 */
function parseSseChunk(data){
  if (!data || data==='[DONE]') return done();
  let env; try { env=JSON.parse(data); } catch { return null; }
  let inner = env.body;
  if (typeof inner==='string') {
    if (inner.trim()==='[DONE]') return done();
    if (['','{}','null','[]'].includes(inner.trim())) return null;
    try { inner=JSON.parse(inner); } catch { return null; }
  }
  if (inner==null || env.isQueued===true) return null;
  if (!inner?.choices) return null;
  const parts=[];
  for (const ch of inner.choices) {
    const d=ch.delta||{};
    if (d.content) parts.push({content:d.content});
    if (d.reasoning_content) parts.push({reasoning_content:d.reasoning_content});
    if (d.tool_calls) parts.push({tool_calls:d.tool_calls});
  }
  return {parts, usage:inner.usage, finish_reason:inner.choices.find(c=>c.finish_reason)?.finish_reason};
}
function done(){ return {done:true}; }

/**
 * Magpie fetch 接口：接受 OpenAI 兼容的 Request，返回 SSE Response。
 * session.credentials = {access,user,machine,name,email}
 * session.modelRow(key) → 模型目录行
 */
export async function chat(session, input, init = {}){
  let body;
  try {
    const rawBody = typeof input==='string' ? (init?.body ?? input) : (input?.body ?? init?.body);
    body = typeof rawBody==='string' ? JSON.parse(rawBody) : rawBody;
  } catch(e){ throw Object.assign(new Error('请求体不是有效 JSON'), {status:400}); }

  const creds = session.credentials;
  const row = session.modelRow(body.model) || {key: body.model, format:'openai', is_vl:true, is_reasoning:true, max_input_tokens:1000000, source:'system'};
  const { payload, upstreamKey } = buildPayload(body, row, creds);

  const raw = Buffer.from(JSON.stringify(payload),'utf8');
  const encoded = encode(raw);
  const path = ENDPOINTS.CHAT;
  const h = headers(path, encoded, creds);
  h['Content-Type']='application/json';
  h['Accept']='text/event-stream';
  h['Cache-Control']='no-cache';
  h['Accept-Encoding']='identity';
  h['X-Model-Key']=upstreamKey;
  h['X-Internal-Model-Key']=upstreamKey;
  h['X-Model-Source']=row.source||'system';
  h['Content-Length']=String(encoded.length);

  // 上游 SSE → 下游 OpenAI SSE 流（用 ReadableStream 桥接）
  const encoder = new TextEncoder();
  const model = body.model || upstreamKey;
  const stream = new ReadableStream({
    start(controller){
      const req = https.request(ORIGIN+path, {method:'POST', headers:h}, (res)=>{
        if (res.statusCode<200 || res.statusCode>=300) {
          let eb=''; res.on('data',c=>eb+=c);
          res.on('end',()=>{
            const err = {error:{message:`QwenWork 上游 HTTP ${res.statusCode}`, type:'upstream_error', detail:eb.slice(0,500)}};
            controller.enqueue(encoder.encode('data: '+JSON.stringify(err)+'\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
          });
          return;
        }
        let buf='';
        const id='chatcmpl-'+uuid().replace(/-/g,'');
        const created=Math.floor(Date.now()/1000);
        res.on('data',(c)=>{
          buf+=c.toString('utf8');
          let idx;
          while((idx=buf.indexOf('\n'))>=0){
            const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
            if(!line.startsWith('data:'))continue;
            const data=line.slice(5).trim();
            const ev=parseSseChunk(data);
            if(!ev)continue;
            if(ev.done){ controller.enqueue(encoder.encode('data: [DONE]\n\n')); continue; }
            if(ev.error){ controller.enqueue(encoder.encode('data: '+JSON.stringify(ev.error)+'\n\n')); continue; }
            for(const part of ev.parts){
              const frame={id,object:'chat.completion.chunk',created,model,
                choices:[{index:0,delta:part,finish_reason:ev.finish_reason||null}]};
              controller.enqueue(encoder.encode('data: '+JSON.stringify(frame)+'\n\n'));
            }
          }
        });
        res.on('end',()=>{ try{controller.enqueue(encoder.encode('data: [DONE]\n\n'));}catch{} try{controller.close();}catch{} });
      });
      req.on('error',(e)=>{
        try{
          controller.enqueue(encoder.encode('data: '+JSON.stringify({error:{message:e.message,type:'transport'}})+'\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
        }catch{}
      });
      req.write(encoded); req.end();
    }
  });
  return new Response(stream, {status:200, headers:{
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-cache', 'Connection':'keep-alive',
  }});
}

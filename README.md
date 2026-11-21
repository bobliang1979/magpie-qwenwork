# magpie-qwenwork

把 **QwenWork 千问办公国内版**订阅里的模型（Qwen4-Max、DeepSeek-V4-Pro、GLM-5.3、Kimi-K3.1-Pro 等 13 个）变成 [Magpie](https://github.com/) 网关上的 OpenAI 兼容模型，让 Hermes / WorkBuddy / Claude Code / Codex 等 Agent 直接调用。

从本机已登录的 QwenWorkCN 桌面客户端读取登录态（DPAPI + AES-GCM 解密），无需账号密码。对话走 QwenWork 私有 COSY 协议 + SSE 流，已端到端实测跑通。

> 本项目协议实现移植自 [ProvidersPlugin/Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers)（AGPL-3.0）的 `wasm/qwenwork` 模块，按其许可要求保留出处。本插件本身 MIT。

## 前置条件

- Windows + Node.js ≥ 20
- [Magpie](https://github.com/) 网关（本机 `127.0.0.1:3425`）
- QwenWork **国内版**桌面客户端已登录（`gateway.qwenwork.cn`，不是国际版 `.ai`；两版账号不通用）

## 安装

```bash
magpie plugin add <本仓库本地路径>
magpie plugin login qwenwork        # 选「从 QwenWork 国内版客户端读取登录态」
```

`magpie plugin list` 应显示 `qwenwork (13 models) signed in`。

## 使用

Hermes / WorkBuddy 等 Agent 通过 Magpie 网关调用模型 id，例如：

```
qwenwork/qwen4-max
qwenwork/deepseek-v4-pro
qwenwork/glm-5.3
qwenwork/kimi-k3.1-pro
```

```bash
curl -s http://127.0.0.1:3425/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwenwork/qwen4-max","messages":[{"role":"user","content":"你好"}]}'
```

## 可用模型（以账号实际目录为准）

`flash`(标准) / `pro`(高级) / `qwen4-max` / `qwen3.8-max-preview` / `qwen3.8-flash` / `ling-3.1-flash` / `deepseek-flash` / `deepseek-v4-pro` / `glm-5.3` / `glm-5.3-flash` / `kimi-k3.1-pro` / `minimax-m3.1-flash` / `step-5-preview`

## 架构

```
index.mjs          插件入口：config / auth.loader / provider.models
lib/cosy.mjs       COSY 签名 + Encode=1 编码（AES-CBC + RSA + MD5）
lib/auth.mjs       客户端凭证解密（DPAPI + AES-GCM）+ DPAPI 加密保管库
lib/models.mjs     模型目录拉取 + Magpie 对象化
lib/chat.mjs       请求体构造 + SSE 双层信封解析 → OpenAI chunk 流
```

### 三个关键契约坑（务必遵守）

1. **`auth.loader(getAuth)` 必须实现**，返回 `{baseURL, apiKey, fetch}`。`fetch` 是 Magpie 唯一请求拦截点；缺失时 Magpie 会用 bearer token 直接发标准 HTTP，导致 `Header 'authorization' has invalid value`。
2. **`magpieModels()` 返回 `{id: entry}` 对象而非数组**，否则 Magpie 用数组索引当模型 id（`qwenwork/0`）。
3. **COSY 签名用编码后的 body**（`cosy::headers(Some(&encoded), ...)`），用 raw body 会 403；GET 端点用空 body 签名。

## 验证

```bash
node --check index.mjs && for f in lib/*.mjs; do node --check "$f"; done
node test_integration.mjs                 # 插件全链路自测
# 改代码后重启 Magpie 面板，再经网关发一次真实请求才算验证通过
```

## 已知限制

- **Token 无自动续期**：access token / refresh token 过期后需重新 `magpie plugin login qwenwork` 或重启客户端。
- **部分模型响应慢**：如 `qwen4-max` 实测可达 50s+，可能触发 Agent 侧超时（499）。快模型用 `flash` / `glm-5.3-flash`；慢模型请把 Agent 超时设到 60s+。
- 网关 usage 计数显示 0（不影响对话）。
- 逆向未公开协议，QwenWork 升级可能导致失效；个人账号有风控风险。

## 许可

MIT（`ProvidersPlugin/Agent2Providers` 的协议研究成果按其 AGPL-3.0 单独保留出处）。

## 致谢

协议实现参考 [ProvidersPlugin/Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers) beta 分支的 `wasm/qwenwork` 模块；插件架构参考 [miaocell/magpie-doubao-work-auth](https://github.com/miaocell/magpie-doubao-work-auth)。

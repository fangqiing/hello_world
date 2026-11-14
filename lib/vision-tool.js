/**
 * 图片理解：多厂商 provider 链。
 *
 * 策略（用户 2026-11-13 拍板）：优先 deepseek-flash；失败 / 描述为空 / 降级文案才交给下一级。
 * 凭据与链顺序都放 config/providers.json，填 key 改 enabled 即生效，不改代码。
 * 密钥不进日志、不进 prompt；错误统一 redact。
 */
import { runTool, toolSpec, redact } from './tool-runtime.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(PLUGIN_DIR, 'config', 'providers.json');

export const DOMAIN = 'open.bigmodel.cn';
export const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const DEFAULT_MODEL = 'glm-4v-flash';

export const DEFAULT_PROMPT = '用两三句话说清这张图里有什么、在发生什么。不要编造看不见的细节。';

/** 每家的端点、域名白名单、默认模型与超时。timeoutMs 必须大于推理型模型的生成耗时。 */
export const PROVIDER_META = {
  deepseek: {
    domain: 'api.deepseek.com',
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-flash',
    defaultMaxTokens: 1200,
    timeoutMs: 90_000,
  },
  qwen: {
    domain: 'ws-ztoe2ot13bpxn2nl.cn-beijing.maas.aliyuncs.com',
    endpoint: 'https://ws-ztoe2ot13bpxn2nl.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen3-vl-plus',
    defaultMaxTokens: 600,
    timeoutMs: 60_000,
  },
  zhipu: {
    domain: DOMAIN,
    endpoint: ENDPOINT,
    defaultModel: DEFAULT_MODEL,
    defaultMaxTokens: 400,
    timeoutMs: 60_000,
  },
  doubao: {
    domain: 'ark.cn-beijing.volces.com',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    defaultModel: '',
    defaultMaxTokens: 600,
    timeoutMs: 60_000,
  },
};

/** 配置文件缺失时的兜底链：DeepSeek 主、智谱兜底（两者当前都有可用 key）。 */
export const DEFAULT_VISION_CHAIN = [
  { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 1200 },
  { provider: 'zhipu', model: 'glm-4v-flash', maxTokens: 400 },
];

export function loadProviderConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (err) {
    return {};
  }
}

function findCredentialsFile() {
  const candidates = [
    process.env.DSH_CREDENTIALS_FILE,
    path.resolve(PLUGIN_DIR, '../../..', '.credentials.yaml'),
    '/opt/1panel/apps/deepseek-harness/deepseek-harness/data/dsh/.credentials.yaml',
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return existsSync(p); } catch (err) { return false; }
  }) || '';
}

/** 汇总各家 key：DeepSeek 从 dsh 凭据文件读，智谱从环境读，千问/豆包从 providers.json 读。 */
export function readDshCredential(name = 'DEEPSEEK_API_KEY') {
  const f = findCredentialsFile()
  if (!f) return ''
  try {
    const m = new RegExp(`${name}\\s*:\\s*['\"]?([^\\s'\"]+)`).exec(readFileSync(f, 'utf8'))
    return m ? m[1] : ''
  } catch (err) { return '' }
}

export function resolveVisionKeys(extra = {}) {
  const cfg = loadProviderConfig();
  let deepseek = '';
  const f = findCredentialsFile();
  if (f) {
    try {
      const m = /DEEPSEEK_API_KEY\s*:\s*['"]?([^\s'"]+)/.exec(readFileSync(f, 'utf8'));
      if (m) deepseek = m[1];
    } catch (err) { /* 读不到就当没配 */ }
  }
  return {
    deepseek: process.env.DEEPSEEK_API_KEY || deepseek,
    zhipu: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY
      || (cfg.zhipu?.enabled ? String(cfg.zhipu.apiKey || '') : '')
      || extra.zhipu || '',
    qwen: cfg.qwen?.enabled ? String(cfg.qwen.apiKey || '') : '',
    doubao: cfg.doubao?.enabled ? String(cfg.doubao.apiKey || '') : '',
  };
}

/** 只接受 http(s) 或 data:image/*;base64。避免把本地路径塞进来。 */
export function normalizeImage(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^data:image\/[a-z+]+;base64,/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return s;
  } catch (err) { /* fallthrough */ }
  return null;
}

export function buildVisionRequest({ image, question, model = DEFAULT_MODEL, maxTokens = 400 } = {}) {
  const url = normalizeImage(image);
  if (!url) throw Object.assign(new Error('invalid image'), { code: 'bad_image' });
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url } },
          { type: 'text', text: String(question || DEFAULT_PROMPT) },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
}

/** 从返回体里取文本；兼容 choices[0].message.content 为字符串或分段数组。 */
export function extractVisionText(payload) {
  const msg = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const c = msg && msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : x && x.text) || '').join('').trim();
  return '';
}

/** 这些都属于"没识别出来"，必须触发下一级，不能当成描述交给模型。 */
const UNUSABLE = /没看清|看不太清|无法识别|识别不出|没查到|稍后再试|还没配|密钥不对|图片理解的密钥|没有 fetch|查询超时|暂不可用|没收到|看不清/;
function unusable(text) {
  const s = String(text || '').trim();
  return !s || s.length < 4 || UNUSABLE.test(s);
}

async function runOnce({ provider, key, image, question, model, maxTokens, fetchImpl }) {
  const meta = PROVIDER_META[provider] || PROVIDER_META.zhipu;
  const useModel = model || meta.defaultModel;
  const spec = toolSpec({
    name: 'see_image',
    description: '看一张图片并描述内容。',
    domains: [meta.domain],
    config: { apiKey: key, timeoutMs: meta.timeoutMs, maxChars: 2000 },
    buildRequest: (args) => ({
      url: meta.endpoint,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(buildVisionRequest({
          image: args.image,
          question: args.question,
          model: useModel,
          maxTokens: maxTokens || meta.defaultMaxTokens,
        })),
      },
    }),
    parse: async (res) => {
      const payload = await res.json();
      const text = extractVisionText(payload);
      if (!text) return { text: '', source: `${provider}/${useModel}`, data: payload };
      return { text, source: `${provider}/${useModel}`, data: { usage: payload.usage } };
    },
  });
  const ctx = { fetch: fetchImpl, apiKey: key };
  let out = await runTool(spec, { image, question }, ctx);
  // 免费通道偶发 429(1113 资源包不足 / 1305 访问量过大)，退避一次再试。
  if (!out.ok && /429|1113|1305/.test(String(out.error || ''))) {
    await new Promise((r) => setTimeout(r, 1500));
    out = await runTool(spec, { image, question }, ctx);
  }
  return out;
}

/** 按 chain 顺序尝试，第一级成功（且不是降级文案）就返回。attempts 供排障与计费核对。 */
export async function describeImage({ image, question, apiKey, model, fetchImpl, config = {} } = {}) {
  const keys = config.apiKeys || resolveVisionKeys({ zhipu: apiKey || config.apiKey });
  const chain = Array.isArray(config.chain) && config.chain.length
    ? config.chain
    : [{ provider: 'deepseek', model: model || DEFAULT_VISION_CHAIN[0].model, maxTokens: config.maxTokens || 1200 }];
  const attempts = [];
  for (const step of chain) {
    const provider = String(step?.provider || 'deepseek');
    const meta = PROVIDER_META[provider] || PROVIDER_META.zhipu;
    const useModel = step?.model || meta.defaultModel;
    const key = keys[provider] || '';
    if (!key) { attempts.push({ provider, ok: false, reason: 'no_key' }); continue; }
    if (!useModel) { attempts.push({ provider, ok: false, reason: 'no_model' }); continue; }
    let out = null;
    try {
      out = await runOnce({ provider, key, image, question, model: useModel, maxTokens: step?.maxTokens, fetchImpl });
    } catch (err) {
      attempts.push({ provider, ok: false, reason: 'exception', error: redact(String(err?.message || err), [key]) });
      continue;
    }
    const ok = Boolean(out?.ok) && !unusable(out.text);
    attempts.push({
      provider, ok,
      code: out?.code || null,
      textLen: String(out?.text || '').length,
      elapsedMs: out?.elapsedMs || null,
      error: out?.error ? redact(String(out.error), [key]) : null,
    });
    if (ok) {
      return {
        ok: true,
        text: out.text,
        source: `${provider}/${useModel}`,
        attempts,
        at: out.at,
        elapsedMs: out.elapsedMs,
        truncated: out.truncated,
      };
    }
  }
  return { ok: false, code: 'vision_chain_exhausted', text: '（这张图我没看清）', attempts };
}

export function createVisionTool({ fetchImpl, apiKey, config = {} } = {}) {
  return {
    name: 'see_image',
    description: '看一张图片并描述内容。图片可以是 http(s) 链接或 data:image base64。只读。',
    params: { image: 'string，图片链接或 data URI', question: 'string，可选，想问的问题' },
    domains: [DOMAIN],
    run: (args) => describeImage({
      image: args && args.image,
      question: args && args.question,
      apiKey,
      fetchImpl,
      config,
    }),
  };
}

export function redactForReport(text, apiKey) {
  return redact(text, [apiKey]);
}

/**
 * STEP 13 - 天气工具（Open-Meteo，无需 API key）
 *
 * 选它而不是和风/OpenWeather 的理由：免费、无需注册、无 key 落盘（不触红线②）、
 * 中文城市名走官方 geocoding。代价是只有天气数据，没有生活指数。
 */

import { withTimeout, truncate, ToolError } from './tool-runtime.js';

export const DOMAINS = ['geocoding-api.open-meteo.com', 'api.open-meteo.com'];

/** WMO weather code → 中文短句。只覆盖常见码，未知码给「天气」。 */
export const WEATHER_CODES = {
  0: '晴', 1: '大致晴朗', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

export function codeToText(code) {
  return WEATHER_CODES[Number(code)] || '天气';
}

function q(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** 把结构化结果压成一句能直接说出口的话。 */
export function formatWeather({ city, current, daily } = {}) {
  const c = current || {};
  const temp = Number(c.temperature_2m);
  const feels = Number(c.apparent_temperature);
  const hum = Number(c.relative_humidity_2m);
  const wind = Number(c.wind_speed_10m);
  const desc = codeToText(c.weather_code);
  const parts = [`${city || '当地'}现在${desc}`];
  if (Number.isFinite(temp)) parts.push(`${temp.toFixed(0)}℃`);
  if (Number.isFinite(feels) && Math.abs(feels - temp) >= 2) parts.push(`体感${feels.toFixed(0)}℃`);
  if (Number.isFinite(hum)) parts.push(`湿度${hum.toFixed(0)}%`);
  if (Number.isFinite(wind) && wind >= 20) parts.push(`风有点大 ${wind.toFixed(0)}km/h`);
  const d = (daily && daily.temperature_2m_max && daily.temperature_2m_min)
    ? { max: Number(daily.temperature_2m_max[0]), min: Number(daily.temperature_2m_min[0]) }
    : null;
  if (d && Number.isFinite(d.max) && Number.isFinite(d.min)) parts.push(`今天 ${d.min.toFixed(0)}~${d.max.toFixed(0)}℃`);
  return parts.join('，') + '。';
}

export async function geocode(city, fetchImpl) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?${q({ name: city, count: 1, language: 'zh', format: 'json' })}`;
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res || res.ok === false) throw new ToolError('geocode_http', `http ${res && res.status}`);
  const data = await res.json();
  const hit = data && data.results && data.results[0];
  if (!hit) throw new ToolError('city_not_found', `city not found: ${city}`);
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(' '),
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone || 'Asia/Shanghai',
  };
}

export async function queryWeather({ city = '哈尔滨', fetchImpl, config = {} } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, code: 'no_fetch', text: '（当前环境没有 fetch）' };

  const timeoutMs = config.timeoutMs || 8000;
  try {
    const loc = await withTimeout(geocode(city, f), timeoutMs);
    const url = `https://api.open-meteo.com/v1/forecast?${q({
      latitude: loc.latitude, longitude: loc.longitude,
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min',
      timezone: loc.timezone, forecast_days: 1,
    })}`;
    const res = await withTimeout(f(url, { method: 'GET' }), timeoutMs);
    if (!res || res.ok === false) throw new ToolError('weather_http', `http ${res && res.status}`);
    const data = await res.json();
    const t = truncate(formatWeather({ city: loc.name, current: data.current, daily: data.daily }), config.maxChars || 400);
    return {
      ok: true,
      text: t.text,
      source: 'Open-Meteo',
      at: new Date().toISOString(),
      data: { location: loc, current: data.current },
    };
  } catch (err) {
    const code = err && err.code ? err.code : 'failed';
    return {
      ok: false,
      code,
      text: code === 'city_not_found' ? `（没找到「${city}」这个城市）` : '（天气没查到，稍后再试）',
      error: String(err && err.message || err),
    };
  }
}

export function createWeatherTool({ fetchImpl, config = {} } = {}) {
  return {
    name: 'weather_now',
    description: '查询某个城市此刻的天气与今日温度范围。只读，不需要用户提供位置。',
    params: { city: 'string，城市名，例如 哈尔滨' },
    domains: DOMAINS,
    run: (args) => queryWeather({ city: args && args.city, fetchImpl, config }),
  };
}

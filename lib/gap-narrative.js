/**
 * STEP 32 - 空档期叙事（纯函数，零依赖）
 *
 * 问题：她只在对方开口的时候才存在。隔三天回来，她的第一句和隔三小时回来
 *       没有区别 —— 中间那段时间是空白的。真人不是这样，真人在那段时间里过日子。
 * 定案：把「上次说话到现在」的间隔，连同这期间她自己的痕迹（日记、她说过的话、
 *       她做过的事）拼成一小段叙述交给她，让她能自然地说出「这几天我做了什么」。
 *
 * 三条纪律：
 *   ① 没有素材就不许编。素材为空时明确告诉她「这段时间没什么可讲的」，
 *      而不是留白让她自己填空 —— 留白必被幻觉填满。
 *   ② 短间隔不提。1.5 小时以内说了反而奇怪。
 *   ③ 只给线索不给台词。给的是「有这些事」，怎么讲由她自己决定。
 */

const MIN_GAP_MS = 90 * 60 * 1000;

/** 空档分级：决定她该轻描淡写还是认真交代。 */
export function gapTier(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs < MIN_GAP_MS) return 'none';
  if (gapMs < 8 * 3600 * 1000) return 'short';
  if (gapMs < 36 * 3600 * 1000) return 'medium';
  if (gapMs < 7 * 86400 * 1000) return 'long';
  return 'verylong';
}

/** 「3 天」「半天」「两个多月」—— 人不会说「259200000 毫秒」。 */
export function humanizeGap(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs < 0) return '';
  const minutes = gapMs / 60000;
  if (minutes < 1) return '刚才';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  const days = hours / 24;
  if (days < 1.5) return '一天多';
  if (days < 7) return `${Math.round(days)} 天`;
  if (days < 45) return `${Math.round(days / 7)} 个星期`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return '很久';
}

/** IANA 时区下的日期键与小时。 */
function zoned(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(date);
    const pick = (type) => parts.find((p) => p.type === type)?.value || '';
    return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, hour: Number(pick('hour')) };
  } catch (err) {
    const d = new Date(date);
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      hour: d.getHours(),
    };
  }
}

function dayLabel(dateStr, todayStr, timeZone, at) {
  if (dateStr === todayStr) {
    const hour = zoned(new Date(at), timeZone).hour;
    if (hour < 5) return '凌晨';
    if (hour < 11) return '早上';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    if (hour < 23) return '晚上';
    return '深夜';
  }
  const diffDays = Math.round((Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000);
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  if (diffDays > 2 && diffDays < 8) return `${diffDays} 天前`;
  return dateStr.slice(5).replace('-', ' 月') + ' 日';
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 把这段时间的痕迹按天归并。同一天多条只留最后两条，避免堆成流水账。
 * items: [{ at, kind: 'diary'|'said'|'did', text }]
 */
export function groupByDay(items, { timeZone = 'Asia/Shanghai', now = Date.now(), maxPerDay = 2 } = {}) {
  const today = zoned(new Date(now), timeZone).date;
  const buckets = new Map();
  for (const item of items || []) {
    const at = Number(item?.at);
    const text = String(item?.text || '').trim();
    if (!Number.isFinite(at) || !text) continue;
    if (at > now) continue;
    const { date } = zoned(new Date(at), timeZone);
    const key = date;
    if (!buckets.has(key)) buckets.set(key, { date, label: dayLabel(date, today, timeZone, at), items: [] });
    buckets.get(key).items.push({ at, kind: item.kind || 'did', text });
  }
  const days = [...buckets.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  return days.map((day) => ({
    ...day,
    items: day.items.sort((a, b) => b.at - a.at).slice(0, maxPerDay),
  }));
}

const KIND_LABEL = {
  diary: '写了日记',
  said: '说过',
  did: '做了',
  thought: '想过',
  read: '读了',
};

/**
 * 生成注入给她的那段话。返回 null 表示这次不该提。
 *
 * @returns {{tier:string, gapMs:number, gapText:string, text:string|null}}
 */
export function buildGapNarrative({
  lastTalkAt = null,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
  items = [],
  maxItems = 4,
  maxChars = 80,
  maxDays = 3,
} = {}) {
  const empty = { tier: 'none', gapMs: 0, gapText: '', text: null };
  const last = Number(lastTalkAt);
  if (!Number.isFinite(last) || last <= 0) return empty;
  const gapMs = now - last;
  const tier = gapTier(gapMs);
  if (tier === 'none') return { tier, gapMs, gapText: '', text: null };

  const gapText = humanizeGap(gapMs);
  const days = groupByDay(items, { timeZone, now }).slice(0, maxDays);
  const lines = [];

  const rendered = [];
  for (const day of days) {
    for (const item of day.items) {
      if (rendered.length >= maxItems) break;
      const prefix = KIND_LABEL[item.kind] || '做了';
      rendered.push(`- ${day.label}${prefix}「${truncate(item.text, maxChars)}」`);
    }
    if (rendered.length >= maxItems) break;
  }

  if (tier === 'short') {
    // 半天内：一句带过。没有素材就只留这一句，别追加纪律提示 ——
    // 短间隔本来没什么可交代的，多一句反而暗示她必须说点什么。
    if (!rendered.length) return { tier, gapMs, gapText, text: `【刚才】你们上次说话是 ${gapText}前。` };
    lines.push(`【刚才】你们上次说话是 ${gapText}前。`);
  } else {
    lines.push(`【这段时间】你们上次说话是 ${gapText}前。`);
  }

  if (rendered.length) {
    lines.push('这期间你自己有过这些：');
    lines.push(...rendered);
    lines.push('（只依据上面这些说，别编没发生的事。想提就提一句，不想提就轻轻带过。）');
  } else {
    lines.push('（这段时间没有留下记录。别编，最多说一句「这几天有点闷」这类不涉及具体事实的话。）');
  }

  return { tier, gapMs, gapText, text: lines.join('\n') };
}

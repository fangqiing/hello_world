/**
 * STEP 14 - 时间感知上下文（纯函数，零副作用）
 *
 * 解决的问题：模型本身没有时钟。不注入，她会答「现在应该是晚上吧」——那是幻觉。
 * 注入方式：给**人能读的时间**，不是 ISO 时间戳。绝对时间 + 相对时间 + 时段。
 *
 * 所有计算按 config.timeZone，不用服务器本地时区（审计 P2 提过日记用服务器 TZ 的坑）。
 */

export const WEEKDAY_ZH = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };

export const PERIODS = [
  { key: 'late_night', from: 0, to: 5, label: '深夜', hint: '这个点该睡了' },
  { key: 'dawn', from: 5, to: 8, label: '清晨', hint: '刚醒或还没醒' },
  { key: 'morning', from: 8, to: 11, label: '上午', hint: '一天刚开始' },
  { key: 'noon', from: 11, to: 13, label: '中午', hint: '饭点' },
  { key: 'afternoon', from: 13, to: 17, label: '下午', hint: '最容易困的时候' },
  { key: 'evening', from: 17, to: 21, label: '傍晚', hint: '下班/放学后' },
  { key: 'night', from: 21, to: 24, label: '夜里', hint: '一天快收尾了' },
];

/** 取某时区下的日期与时刻。en-CA 的日期格式天然是 YYYY-MM-DD。 */
export function zonedParts(timeZone = 'Asia/Shanghai', at = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(at))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute: Number(p.minute) || 0,
    weekday: p.weekday,
    weekdayZh: WEEKDAY_ZH[p.weekday] || '',
  };
}

/** 两个 YYYY-MM-DD 之间的日历日差（b - a）。 */
export function dayDiff(aDate, bDate) {
  const [ay, am, ad] = String(aDate).split('-').map(Number);
  const [by, bm, bd] = String(bDate).split('-').map(Number);
  if (![ay, am, ad, by, bm, bd].every(Number.isFinite)) return null;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function periodOf(hour) {
  const h = ((Number(hour) || 0) + 24) % 24;
  return PERIODS.find(p => h >= p.from && h < p.to) || PERIODS[0];
}

/** UTC timestamp of local midnight for a YYYY-MM-DD in the given time zone. */
export function startOfDay(timeZone = 'Asia/Shanghai', dateKey = '') {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return NaN;
  const target = Date.UTC(y, m - 1, d);
  let at = target;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(timeZone, at);
    const [py, pm, pd] = p.date.split('-').map(Number);
    at += target - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
  }
  return at;
}

/** 中文相对时间：刚刚 / N分钟前 / 今天上午 / 昨天 / 上周 / 三个月前 / 去年。 */
export function relativeTime(then, now = Date.now(), timeZone = 'Asia/Shanghai') {
  const t = Number(then);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diffMs = now - t;
  if (diffMs < 0) return '之后';
  if (diffMs < 60 * 1000) return '刚刚';
  if (diffMs < 60 * 60 * 1000) return `${Math.max(1, Math.round(diffMs / 60000))} 分钟前`;

  const a = zonedParts(timeZone, t);
  const b = zonedParts(timeZone, now);
  const d = dayDiff(a.date, b.date);
  if (d === 0) {
    if (diffMs < 3 * 3600 * 1000) return `${Math.max(1, Math.round(diffMs / 3600000))} 小时前`;
    return `今天${periodOf(a.hour).label}`;
  }
  if (d === 1) return `昨天${periodOf(a.hour).label}`;
  if (d === 2) return '前天';
  if (d != null && d < 7) return `${d} 天前`;
  if (d != null && d < 14) return '上周';
  if (d != null && d < 30) return `${Math.max(2, Math.round(d / 7))} 周前`;
  if (d != null && d < 365) return `${Math.max(1, Math.round(d / 30))} 个月前`;
  if (d != null && d < 730) return '去年';
  return `${Math.max(1, Math.round(d / 365))} 年前`;
}

/** 是否适合主动开口（深夜不问「今天过得怎么样」）。 */
export function isGoodMoment(periodKey, purpose = 'chat') {
  const p = PERIODS.find(x => x.key === periodKey) || PERIODS[0];
  if (purpose === 'casual') return p.key !== 'late_night';
  if (purpose === 'greeting') return ['dawn', 'morning', 'noon', 'evening'].includes(p.key);
  if (purpose === 'proactive') return ['morning', 'noon', 'afternoon', 'evening'].includes(p.key);
  return true;
}

/**
 * 生成注入 prompt 的「此刻」块。
 * 控制在 160 字内；不写 ISO，不写时区名，不写「系统时间」这种机械说法。
 */
export function buildTemporalBlock({ timeZone = 'Asia/Shanghai', at = Date.now(), lastTalkAt = null, firstMeetAt = null, style = 'normal' } = {}) {
  const now = zonedParts(timeZone, at);
  const period = periodOf(now.hour);
  const hh = String(now.hour).padStart(2, '0');
  const mm = String(now.minute).padStart(2, '0');
  const lines = [];

  const [, mon, day] = now.date.split('-');
  lines.push(`现在是${Number(mon)}月${Number(day)}日${now.weekdayZh}${period.label}，${hh}:${mm}。`);

  if (style === 'detailed') {
    if (period.key === 'late_night') lines.push('夜已经很深了，说话会轻一点。');
    else if (period.key === 'dawn') lines.push('天刚亮，城市还没完全醒。');
    else if (period.key === 'evening') lines.push('天在暗下来。');
  }

  if (Number.isFinite(Number(lastTalkAt)) && Number(lastTalkAt) > 0) {
    const rel = relativeTime(Number(lastTalkAt), at, timeZone);
    if (rel) lines.push(`上一次说话是${rel}。`);
  }
  if (Number.isFinite(Number(firstMeetAt)) && Number(firstMeetAt) > 0) {
    const rel = relativeTime(Number(firstMeetAt), at, timeZone);
    if (rel && rel !== '刚刚') lines.push(`你们第一次说话是${/^\d/.test(rel) ? ' ' : ''}${rel}。`);
  }

  return lines.join('');
}

/** 供一致性校验：整个插件里时间只应该来自这里。 */
export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return { ok: true, timeZone };
  } catch (err) {
    return { ok: false, timeZone: 'Asia/Shanghai', reason: String(err && err.message || err) };
  }
}

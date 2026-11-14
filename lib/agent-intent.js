/**
 * STEP 16 - 「这句话是不是想让我动手」检测（v2，组合判定）
 *
 * v1 的问题：动作词和技术对象各自加分，导致「帮我看看这个」+「这个」也能凑分。
 * v2 改成**组合规则**：请求词、技术动作、技术对象三者组合才判 high；
 * 纯日常请求（帮我倒杯水）不触发；纯提问（这个报错怎么修）只算 mid，不主动切。
 */

// ① 请求标记：有没有在「让人做事」
const REQUEST = [/帮我|替我|给我|麻烦你?|能不能|可不可以|请你|你(去|来)/];

// ② 技术动作：必须是真的「操作」，不是「看看」
// 强动作：本身就在「操作」，只要带请求词就够强
const STRONG_ACTION = [
  /执行|运行|跑一下|跑个|启动|重启|部署|回滚/,
  /安装|装一下|下载|拉取|克隆|clone|install|deploy/i,
  /改一下|改成|修复|替换|更新配置|删掉|删除|移到|重命名/,
  /写个脚本|写一个脚本|生成一个|导出|打包|编译|构建/,
  /提交|推送|拉取请求|merge|rebase|commit|push/i,
  /怎么(修|弄|改|查|装|跑|配)|如何(修|改|查|部署|配置)/,
];

// 弱动作：泛化的「查/看/读」，必须配技术对象才算任务
const WEAK_ACTION = [
  /查|看|读|搜|找|分析|排查|定位|grep|find|rg\b/i,
];

// ③ 技术对象：有具体的东西可操作
const TECH_OBJECT = [
  /https?:\/\/[^\s]+/i,
  /(^|\s)\/[a-z0-9_.\-\/]{2,}/i,
  /\b[\w\-]+\.(js|mjs|cjs|ts|py|sh|bash|json|md|log|db|sql|yml|yaml|html|css|conf|env)\b/i,
  /```/,
  /(日志|代码|脚本|接口|数据库|服务器|容器|端口|进程|权限|配置|仓库|分支|依赖|镜像|环境变量)/,
  /(Error|Traceback|Exception|exit code|command not found|permission denied|segfault)/i,
];

// ④ 命令行/报错直给：这类几乎一定是任务
const SHELL_LIKE = [
  /^\s*[$#>]\s+\S+/m,
  /\b(sudo|systemctl|docker|kubectl|npm|pnpm|yarn|pip|apt|git|ssh|curl|wget)\s+\S+/i,
];

// ⑤ 日常请求：是「让人做事」，但不是 agent 的事
const DAILY = [
  /打开(窗户|灯|空调|音乐)|倒(杯)?水|关(灯|窗)/,
  /提醒我|记一下|陪我|说说话|讲个笑话|夸夸我/,
  /(吃什么|几点睡|穿什么)/,
];

// ⑥ 情绪 / 闲聊 / 问观点
const NEGATIVE = [
  /哈哈|笑死|草|呜呜|好累|想你|抱抱|晚安|早安|在吗|无聊/,
  /你觉得|你怎么看|你说呢|是不是有点|我该不该/,
];

const has = (list, s) => list.some(re => re.test(s));

/** 祈使句：开头就是动词，没有「我」做主语 */
const IMPERATIVE = /^(把|帮|给|替|请|麻烦|查|看|读|跑|装|改|删|写|导|拉|提交|部署|重启|启动|执行)/;

/** 提取一个能放进确认话术的动词。 */
export function pickVerb(text) {
  const s = String(text || '');
  const pairs = [
    [/查|搜|grep|find|rg\b/i, '查'],
    [/看|读|分析/i, '看'],
    [/改|修|替换|更新配置|重命名/, '改'],
    [/安装|装|下载|拉取|克隆|install|deploy/i, '装'],
    [/执行|运行|跑|启动|重启|部署/, '跑'],
    [/删|清|移/, '删'],
    [/写|生成|导出|打包|编译|构建/, '写'],
    [/提交|推送|merge|rebase|commit|push/i, '提交'],
  ];
  for (const [re, v] of pairs) if (re.test(s)) return v;
  return '';
}

/**
 * 返回 { score, level, reasons, verb, matched }
 * high（≥6）：可以提议切 agent
 * mid （4–5）：只算疑似，不打断
 * none：不提议
 */
export function detectIntent(text, ctx = {}) {
  const s = String(text || '');
  const reasons = [];
  const matched = {};
  let score = 0;

  const req = has(REQUEST, s) || IMPERATIVE.test(s);
  const strong = has(STRONG_ACTION, s);
  const weak = has(WEAK_ACTION, s);
  const act = strong || weak;
  const obj = has(TECH_OBJECT, s);
  const shell = has(SHELL_LIKE, s);
  const daily = has(DAILY, s);
  const neg = has(NEGATIVE, s);

  matched.request = req; matched.strong = strong; matched.weak = weak;
  matched.object = obj; matched.shell = shell; matched.daily = daily; matched.negative = neg;

  // 命令行 / 报错直给：单独就够强
  if (shell) { score += 6; reasons.push('shell_like'); }

  // 组合判定：强动作配请求 = 直接高；弱动作必须有对象
  if (req && strong) { score += 7; reasons.push('request+strong_action'); }
  else if (req && weak && obj) { score += 6; reasons.push('request+weak_action+object'); }
  else if (act && obj) { score += 4; reasons.push('action+object'); }
  else if (req && weak) { score += 1; reasons.push('request+weak_no_object'); }

  // 日常请求：不是 agent 的事，直接压掉
  if (daily) { score = Math.min(score, 1); reasons.push('daily_request'); }

  // 情绪 / 问观点
  if (neg) { score -= 4; reasons.push('negative_tone'); }

  // 太短
  if (s.length < 6) { score -= 2; reasons.push('too_short'); }

  // 群聊降权（最终也不提议，见 shouldAsk）
  if (ctx.isGroup === true) { score -= 2; reasons.push('group'); }

  if (ctx.mode === 'agent') reasons.push('already_agent');

  score = Math.max(-10, Math.min(14, score));
  const level = score >= 6 ? 'high' : score >= 4 ? 'mid' : 'none';
  return { score, level, reasons, verb: pickVerb(s), matched };
}

/** 是否值得打断当前话题去问一句。 */
export function shouldAsk(intent, ctx = {}) {
  if (!intent) return false;
  if (ctx.isGroup === true) return false;
  if (ctx.mode && ctx.mode !== 'chat') return false;
  if (ctx.authorized !== true) return false;
  return intent.level === 'high';
}

/**
 * STEP 40 - 显式指令。
 *
 * 原来只有 detectIntent 打分：判 high 就先问一句「要我动手吗」。
 * 但「进入 agent 模式」「帮我完成这个任务」这类话本身就是确认，
 * 再问一遍是多余的，还会把一句明确指令变成两轮对话。
 *
 * 所以分两层：
 *   显式指令（本函数）→ 直接切，不问；
 *   模糊倾向（detectIntent 判 high）→ 仍然问，避免「帮我看看这个」被误会成任务。
 */

const EXPLICIT_ENTER = [
  /(进入|切换到|切到|换成|打开|启动)\s*(agent|Agent|AGENT|工作|任务|执行|干活)\s*模式/,
  /^(agent|工作|任务|执行)\s*模式$/,
  /(帮我|替我|请你?)(完成|做|搞定|处理|跑|执行|写|改)(一下|一遍)?(这个|那个|下面)?(任务|活|东西|事情)/,
  // 「帮我处理这个」也算 —— 有明确对象，不用非说「任务」二字
  /(帮我|替我|请你?)(完成|搞定|处理|跑|执行)(一下|一遍)?(这个|那个)/,
  /^(开工|开始干活|开始工作|干正事|开始执行)/,
  /(这个|那个)任务(交给你|你来)/,
];

const EXPLICIT_EXIT = [
  /(退出|结束|关掉|关闭|离开|停用)\s*(agent|Agent|AGENT|工作|任务|执行)?\s*模式/,
  /^(退出|结束|收工|不干了)/,
  /回到(聊天|平常|正常|原来)(状态|模式)?/,
  /(任务|活)(已经)?(完成|结束|做完了)/,
  /^(回来吧|回来|收工吧|就这样吧)/,
];

/**
 * 返回 'enter' | 'exit' | null。
 * 退出优先判定：「退出 agent 模式」里也含「agent 模式」这个词。
 */
export function explicitMode(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 60) return null;
  if (EXPLICIT_EXIT.some((re) => re.test(s))) return 'exit';
  if (EXPLICIT_ENTER.some((re) => re.test(s))) return 'enter';
  return null;
}

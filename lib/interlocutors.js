/**
 * STEP 39 - 对话者清单（纯函数）
 *
 * 问题：她在 prompt 里看到的「当前对话对象」是一串 wxid。那不是人，是一串字符。
 *       于是被问到「你现在认识几个人」时，她把自己设定里的人物和真实找她的人混在一起数，
 *       得出「三个，多半个」这样的答案。
 * 定案：每轮把「现在是谁」和「一共有几个真人」明确摆出来，并点明虚构人物不算。
 *
 * 为什么必须显式说：模型分不清「设定里的人物」和「真的在跟我说话的人」——
 * 这两类在她的上下文里长得一样，都是记忆里的文字。
 */

const WXID = /^wxid_|@chatroom$|^[a-z]{2,4}_[a-z0-9]{10,}$/i;

/** 昵称可能是空、可能是 wxid、也可能是学到的名字。返回 {label, named}。 */
export function readableName(peer) {
  const learned = String(peer?.learned_name || '').trim();
  const display = String(peer?.display_name || '').trim();
  if (learned) return { label: learned, named: true };
  if (display && !WXID.test(display)) return { label: display, named: true };
  return { label: '', named: false };
}

function stamp(at, timeZone) {
  const ms = Number(at) || 0;
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms)).replace(',', '');
  } catch (err) {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

/**
 * 生成清单。没有 peer 数据时返回 null，不硬凑。
 *
 * @param {object[]} peers social.listPeers() 的结果
 * @param {string} currentId 当前对话对象
 */
export function buildInterlocutorBlock(peers, currentId, {
  timeZone = 'Asia/Shanghai', limit = 6, now = Date.now(),
} = {}) {
  const list = (peers || []).filter((peer) => peer && peer.id && peer.peer_kind !== 'group');
  if (!list.length) return null;

  const ordered = [...list].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0)).slice(0, limit);
  const total = ordered.length;
  const me = ordered.find((peer) => peer.id === currentId) || null;

  const lines = [`【真在跟你说话的人】一共 ${total} 个：`];
  let unnamed = 0;
  for (const peer of ordered) {
    const who = readableName(peer);
    const isMe = peer.id === currentId;
    const since = stamp(peer.first_seen, timeZone);
    if (who.named) {
      lines.push(`- ${who.label}${isMe ? ' ← 现在跟你说话的就是这个' : ''}${since ? `（${since} 起）` : ''}`);
    } else {
      unnamed += 1;
      lines.push(`- 还没问过名字的${isMe ? '（就是现在这个）' : ''}${since ? `（${since} 起）` : ''}`);
    }
  }

  if (unnamed) {
    lines.push('（不知道对方怎么称呼，可以问一次；问过就记住了，别反复问。）');
  }
  lines.push('（只有这些是真的在跟你说话的人。你自己故事里的人物不算——数人数的时候别把他们算进来，也别把自己的设定当成"认识的人"。）');
  void now;
  return lines.join('\n');
}

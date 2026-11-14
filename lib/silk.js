/**
 * STEP 32 - 微信语音格式探测与 SILK 转码计划（纯函数）
 *
 * 微信语音是 SILK v3（magic `#!SILK_V3`），ffmpeg 绝大多数发行版不带 libsilk，
 * 必须先解成 PCM 再转 16k 单声道 wav（SenseVoice 要 16k mono）。
 *
 * 两条解码路线：
 *   A pilk（Python，pip 装，无需编译）—— 推荐，4C4G 上最省事
 *   B silk_v3_decoder（C 编译，kn007/silk-v3-decoder）—— 备选
 */

export const SILK_MAGIC = '#!SILK_V3';

export const FORMAT = {
  SILK: 'silk', WAV: 'wav', MP3: 'mp3', AMR: 'amr', OPUS: 'opus', UNKNOWN: 'unknown',
};

/** 微信有些语音在 magic 前带 1 字节 0x02，返回 magic 的真实偏移。 */
export function silkOffset(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let off = 0; off <= 2; off += 1) {
    let ok = true;
    for (let i = 0; i < SILK_MAGIC.length; i += 1) {
      if (off + i >= b.length || b[off + i] !== SILK_MAGIC.charCodeAt(i)) { ok = false; break; }
    }
    if (ok) return off;
  }
  return -1;
}

export function detectAudio(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const ascii = Array.from(b.slice(0, 12)).map(x => String.fromCharCode(x)).join('');
  if (silkOffset(b) >= 0) return { format: FORMAT.SILK, magic: ascii, silkOffset: silkOffset(b) };
  if (ascii.startsWith('RIFF')) return { format: FORMAT.WAV, magic: ascii };
  if (ascii.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { format: FORMAT.MP3, magic: ascii };
  if (ascii.startsWith('#!AMR')) return { format: FORMAT.AMR, magic: ascii };
  if (ascii.startsWith('OggS')) return { format: FORMAT.OPUS, magic: ascii };
  return { format: FORMAT.UNKNOWN, magic: ascii };
}

/**
 * 返回转码步骤（不执行）。steps 是命令数组，由调用方按顺序执行。
 * { in, silk, pcm, wav } 是路径占位符。
 */
export function buildTranscodePlan(format, { decoder = 'pilk', sampleRate = 24000 } = {}) {
  if (format === FORMAT.WAV) {
    return { needed: true, tool: 'ffmpeg', steps: [
      ['ffmpeg', ['-y', '-i', '{in}', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '{wav}']],
    ], note: '统一成 16k mono，即便源已是 wav 也重采样' };
  }
  if (format === FORMAT.SILK) {
    if (decoder === 'pilk') {
      return {
        needed: true, tool: 'pilk', steps: [
          ['python3', ['{pilkScript}', '{in}', '{pcm}']],
          ['ffmpeg', ['-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', '{pcm}',
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '{wav}']],
        ],
        note: 'pilk 解出 s16le PCM（微信常见 24000Hz），再 ffmpeg 转 16k',
      };
    }
    return {
      needed: true, tool: 'silk_v3_decoder', steps: [
        ['silk_v3_decoder', ['{in}', '{pcm}']],
        ['ffmpeg', ['-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', '{pcm}',
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '{wav}']],
      ],
      note: 'C 版解码器需先编译；输出 s16le PCM',
    };
  }
  if (format === FORMAT.AMR || format === FORMAT.MP3 || format === FORMAT.OPUS) {
    return { needed: true, tool: 'ffmpeg', steps: [
      ['ffmpeg', ['-y', '-i', '{in}', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '{wav}']],
    ] };
  }
  return { needed: true, tool: null, steps: [], note: '未知格式，需人工确认' };
}

/** pilk 解码的一行 Python（部署脚本会写成独立文件，这里只给契约）。 */
export const PILK_DECODE_SNIPPET = [
  'import sys, pilk',
  'src, dst = sys.argv[1], sys.argv[2]',
  'with open(src, "rb") as f:',
  '    data = f.read()',
  '# 微信 SILK 常带 1 字节前缀，pilk 需要纯 SILK 数据',
  'off = data.find(b"#!SILK_V3")',
  'if off > 0: data = data[off:]',
  'pilk.decode(data, dst)',
].join('\n');

/**
 * 目標スコア (CLEAR_SCORE) を決めるための実測。
 *
 *   node tools/calibrate.mjs [runs] [depth]
 *
 * 1) 上限: 当たり判定を無視して大ジャンプを繰り返したときの 1 秒あたり点数
 * 2) 先読み bot: 地上にいる瞬間ごとに「待つ / 小 / 大」を着地まで試し、着地後も depth 手先まで分岐して
 *    生き残る中で点の多い手を選ぶ。未来の出現を知り反応も 0 なので人より強い。クリア秒の下限として読む
 */
import { DEFAULT_CONFIG, createState, startRun, step } from '../src/core.js';

const FRAME = 16;
const runs = Number(process.argv[2] ?? 30);
const DEPTH = Number(process.argv[3] ?? 4);

/** 状態を複製できる乱数 (mulberry32)。先読みで未来の出現を揃えるため。 */
function makeRng(seed) {
  const r = { s: seed >>> 0 };
  r.next = () => {
    r.s = (r.s + 0x6d2b79f5) >>> 0;
    let t = r.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return r;
}

const NO_CLEAR = { ...DEFAULT_CONFIG, clearScore: Infinity };

// --- 1) 上限 ---
{
  const r = makeRng(1);
  let s = startRun(createState());
  const cfg = { ...NO_CLEAR, rng: r.next };
  const sec = 60;
  for (let f = 0; f < (sec * 1000) / FRAME; f++) {
    step(s, { hold: true, holdEdge: s.onGround }, FRAME, cfg);
    if (s.phase === 'over') {
      // 当たりを無視して続ける
      s.phase = 'playing';
    }
  }
  console.log(`[上限] 大ジャンプ連打・無敵扱い 60 秒: ${s.score} 点 (${(s.score / sec).toFixed(1)} 点/秒)`);
}

// --- 2) 先読み bot ---
function clone(s) {
  return structuredClone(s);
}

/**
 * 地上で 1 手 (押す長さ plan フレーム) 打ち、次に着地するまで進める。
 * 着地したら残りの深さで再び 3 択を試す (深さ優先)。戻り値は生存フレーム数と点。
 */
function search(s, rngState, depth) {
  let best = null;
  for (const plan of PLANS) {
    const c = clone(s);
    const r = makeRng(0);
    r.s = rngState;
    const cfg = { ...NO_CLEAR, rng: r.next };
    let prev = false;
    let f = 0;
    let dead = false;
    // 最低 1 フレームは進め、次に地上へ戻るまで (上限 80 フレーム)
    for (; f < 80; f++) {
      const hold = f < plan;
      step(c, { hold, holdEdge: hold && !prev }, FRAME, cfg);
      prev = hold;
      if (c.phase === 'over') { dead = true; break; }
      if (f > 0 && c.onGround && f >= plan) break;
    }
    let res;
    if (dead) res = { frames: f, score: c.score };
    else if (depth <= 1) res = { frames: f + 1000, score: c.score };
    else {
      const sub = search(c, r.s, depth - 1);
      res = { frames: f + sub.frames, score: sub.score };
    }
    const key = res.frames * 10000 + res.score;
    if (!best || key > best.key) best = { plan, key, frames: res.frames, score: res.score };
  }
  return best;
}
// 大 / 小 / 1 フレーム待つ
const PLANS = [10, 1, 0];

function playBot(seed, limitSec = 300) {
  const r = makeRng(seed);
  const cfg = { ...NO_CLEAR, rng: r.next };
  let s = startRun(createState());
  let planLeft = 0;
  let prev = false;
  let clearAt = 0;
  const target = DEFAULT_CONFIG.clearScore;
  for (let f = 0; f < (limitSec * 1000) / FRAME; f++) {
    if (s.onGround && planLeft === 0) {
      // 候補: 待つ(0) / 小(1) / 大(10 = BIG_HOLD_MS を越える長さ)
      planLeft = search(s, r.s, DEPTH).plan;
    }
    const hold = planLeft > 0;
    if (planLeft > 0) planLeft -= 1;
    step(s, { hold, holdEdge: hold && !prev }, FRAME, cfg);
    prev = hold;
    if (!clearAt && s.score >= target) clearAt = (f + 1) * FRAME;
    if (s.phase === 'over') return { score: s.score, sec: ((f + 1) * FRAME) / 1000, clearAt };
  }
  return { score: s.score, sec: limitSec, clearAt };
}

const results = [];
for (let i = 0; i < runs; i++) results.push(playBot(1000 + i));
const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};
const scores = results.map((r) => r.score);
const secs = results.map((r) => r.sec);
const clears = results.filter((r) => r.clearAt).map((r) => r.clearAt / 1000);
console.log(`[bot] ${runs} 走: 生存秒 中央 ${q(secs, 0.5)} / 最短 ${q(secs, 0)} / 最長 ${q(secs, 0.99)}`);
console.log(`[bot] スコア 中央 ${q(scores, 0.5)} / 25% ${q(scores, 0.25)} / 75% ${q(scores, 0.75)}`);
// 目標点ごとの「到達した走の割合」と「到達までの中央秒」
for (const t of [1000, 1500, 2000, 2500, 3000]) {
  const hit = results.filter((r) => r.score >= t).length;
  console.log(`[bot] 目標 ${t}: 到達 ${hit}/${runs}`);
}
console.log(`[bot] 目標 ${DEFAULT_CONFIG.clearScore} のクリア秒: ${clears.length ? `中央 ${q(clears, 0.5)} / 最短 ${q(clears, 0)}` : 'なし'}`);

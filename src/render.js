/**
 * チャージ・ラン Web 版 — 描画。
 *
 * 実機 (cardputer-chargerun/src/main.cpp) の drawScene / drawOverlay の移植に、
 * 目標スコアまでの進捗バーとクリア画面を足したもの。240x135 の実寸座標で描き、
 * 拡大は呼ぶ側 (CSS の image-rendering: pixelated) に任せる。
 */
import {
  BAND_BOTTOM,
  BAND_TOP,
  GAUGE_MAX,
  GROUND_Y,
  PLAYER_H,
  PLAYER_W,
  PLAYER_X,
  SCREEN_H,
  SCREEN_W,
} from './core.js';

const COL = {
  bandOn: '#3cd2eb',
  bandOff: '#163e4e',
  ground: '#78787f',
  player: '#fae878',
  pillar: '#5ac86e',
  drone: '#f05a50',
  text: '#ebebf0',
  gaugeOff: '#1c1c22',
  gaugeHot: '#78f5ff',
  clear: '#fff05a',
};

/** 無敵中に使う派手な色。位相で 3 色を回す。 */
function rushColor(s, shift) {
  const phase = (Math.floor(s.animMs / 70) + shift) % 3;
  if (phase === 0) return '#fff05a';
  if (phase === 1) return '#ff6ec8';
  return '#6ef0ff';
}

const MONO = 'ui-monospace, Menlo, Consolas, monospace';

/** ms を「48.3」形式の秒へ。 */
export function formatSec(ms) {
  return (ms / 1000).toFixed(1);
}

/** 走行中の経過時間 (ms)。走り終えた後はその回の記録で止める。 */
export function elapsedMs(s) {
  if (s.phase === 'playing') return s.animMs - s.runStartMs;
  if (s.phase === 'title') return 0;
  return s.runMs;
}

function drawScene(ctx, s, clearScore, bestClearMs) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // --- 充電帯: 3 層に塗り分け、上の層ほど明るい ---
  // 溜まりが速い高さを色で示す。数値を読ませずに「上へ行くほど得だが危ない」を伝える
  const bandH = BAND_BOTTOM - BAND_TOP;
  for (let layer = 0; layer < 3; layer += 1) {
    const ly = BAND_TOP + Math.floor((bandH * layer) / 3);
    const lh = BAND_TOP + Math.floor((bandH * (layer + 1)) / 3) - ly;
    const lv = 3 - layer;
    ctx.fillStyle = s.charging
      ? `rgb(${6 * lv},${20 * lv},${25 * lv})`
      : `rgb(${2 * lv},${7 * lv},${9 * lv})`;
    ctx.fillRect(0, ly, SCREEN_W, lh);
  }
  const bandCol = s.invincible ? rushColor(s, 0) : s.charging ? COL.bandOn : COL.bandOff;
  ctx.fillStyle = bandCol;
  ctx.fillRect(0, BAND_TOP, SCREEN_W, 1);
  ctx.fillRect(0, BAND_BOTTOM, SCREEN_W, 1);
  for (let x = -s.scroll; x < SCREEN_W; x += 24) {
    ctx.fillRect(x, (BAND_TOP + BAND_BOTTOM) / 2, 8, 1);
  }

  // --- 地面 ---
  ctx.fillStyle = COL.ground;
  ctx.fillRect(0, GROUND_Y, SCREEN_W, 1);
  for (let gx = -s.scroll; gx < SCREEN_W; gx += 24) {
    ctx.fillRect(gx + 6, GROUND_Y + 5, 1, 1);
    ctx.fillRect(gx + 15, GROUND_Y + 9, 1, 1);
  }

  // --- 障害物 ---
  for (const o of s.obstacles) {
    ctx.fillStyle = o.air ? COL.drone : COL.pillar;
    ctx.fillRect(Math.round(o.x), o.y, o.w, o.h);
    // ローター (飛来物だと一目で分かるように上へ線を出す)
    if (o.air) ctx.fillRect(Math.round(o.x) - 2, o.y - 2, o.w + 4, 1);
  }

  // --- 破壊エフェクト ---
  s.bursts.forEach((b, i) => {
    const r = 3 + Math.floor((180 - b.ms) / 22);
    ctx.fillStyle = rushColor(s, i);
    ctx.fillRect(b.x - r, b.y, r * 2, 1);
    ctx.fillRect(b.x, b.y - r, 1, r * 2);
  });

  // --- 自機 ---
  let py = Math.round(s.playerY);
  // 地上では 1px だけ上下させ、走っているように見せる
  if (s.onGround && s.phase === 'playing' && Math.floor(s.animMs / 90) % 2 === 0) py -= 1;

  if (s.charging && !s.invincible) {
    // 帯から自機へ電気が流れているように、点を動かしながら描く
    ctx.fillStyle = COL.bandOn;
    const phase = Math.floor(s.animMs / 30) % 4;
    for (let y = BAND_TOP + phase; y < py; y += 4) {
      ctx.fillRect(PLAYER_X + PLAYER_W / 2, y, 1, 1);
    }
  }
  if (s.invincible) {
    ctx.strokeStyle = rushColor(s, 1);
    ctx.lineWidth = 1;
    ctx.strokeRect(PLAYER_X - 2.5, py - 2.5, PLAYER_W + 5, PLAYER_H + 5);
  }
  ctx.fillStyle = s.invincible ? rushColor(s, 0) : COL.player;
  ctx.fillRect(PLAYER_X, py, PLAYER_W, PLAYER_H);
  ctx.fillStyle = '#000';
  ctx.fillRect(PLAYER_X + PLAYER_W - 3, py + 3, 1, 1);

  // --- HUD: ゲージは数字でなく左端の縦棒で出す (実機の UI 案 C) ---
  ctx.font = `8px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = COL.text;
  // 競うのは「目標点に届くまでのタイム」なので、経過タイムを常に出し、自己ベストを並べる
  ctx.fillText(`SCORE ${s.score}/${clearScore}`, 14, 3);
  const timeText = `TIME ${formatSec(elapsedMs(s))}` + (bestClearMs > 0 ? `  BEST ${formatSec(bestClearMs)}` : '');
  ctx.fillText(timeText, SCREEN_W - 8 - Math.ceil(ctx.measureText(timeText).width), 3);

  // 目標点までの進捗バー (Web 版で追加)。スコアの横に細く引き、読まずに残りが分かるようにする
  const barX = 14;
  const barW = SCREEN_W - 14 - 8;
  const ratio = Math.min(1, s.score / clearScore);
  ctx.fillStyle = COL.gaugeOff;
  ctx.fillRect(barX, 13, barW, 2);
  ctx.fillStyle = s.phase === 'clear' ? COL.clear : s.invincible ? rushColor(s, 2) : COL.bandOn;
  ctx.fillRect(barX, 13, Math.round(barW * ratio), 2);

  const lit = Math.ceil(s.gauge - 0.001);
  for (let i = 0; i < GAUGE_MAX; i += 1) {
    const on = GAUGE_MAX - i <= lit;
    let c = COL.gaugeOff;
    if (on) {
      if (s.invincible) c = rushColor(s, i);
      else if (s.flashMs > 0) c = '#ffffff';
      else if (!s.charging) c = COL.ground;
      else c = s.chargeRate > 1.1 ? COL.gaugeHot : COL.bandOn;
    }
    ctx.fillStyle = c;
    ctx.fillRect(3, 18 + i * 9, 6, 6);
  }
}

/** 目標の 75% 以上で「あと少し」扱いにする。 */
export const SO_CLOSE_RATIO = 0.75;

/** ミス画面の見出しと色。自己ベスト更新 > あと少し > それ以外、の順に良い言葉を選ぶ。 */
export function overHeadline(s, clearScore) {
  if (s.newBest) return { text: 'NEW BEST!', color: COL.clear };
  if (s.score >= clearScore * SO_CLOSE_RATIO) return { text: 'SO CLOSE!', color: COL.gaugeHot };
  return { text: 'NICE RUN', color: COL.bandOn };
}

/** 枠付きの小窓を描く。 */
function panel(ctx, x, y, w, h, accent) {
  ctx.fillStyle = '#0a0a0e';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** 文字列を横中央に置く。 */
function center(ctx, text, y) {
  const w = ctx.measureText(text).width;
  ctx.fillText(text, Math.round((SCREEN_W - w) / 2), y);
}

function drawOverlay(ctx, s, clearScore, bestClearMs) {
  if (s.phase === 'title') {
    panel(ctx, 20, 34, SCREEN_W - 40, 68, COL.bandOn);
    ctx.fillStyle = COL.bandOn;
    ctx.font = `bold 16px ${MONO}`;
    center(ctx, 'CHARGE RUN', 40);
    ctx.font = `8px ${MONO}`;
    ctx.fillStyle = '#c8c8d2';
    center(ctx, 'tap: small jump / hold: big jump', 59);
    center(ctx, `reach ${clearScore} pts as fast as you can`, 69);
    // 自己ベストを出して「前回の自分」を目標にさせる。記録が無ければ出さない
    if (bestClearMs > 0 || s.best > 0) {
      ctx.fillStyle = COL.clear;
      const parts = [];
      if (bestClearMs > 0) parts.push(`BEST TIME ${formatSec(bestClearMs)}s`);
      if (s.best > 0) parts.push(`BEST ${s.best} pts`);
      center(ctx, parts.join('   '), 79);
    }
    ctx.fillStyle = COL.bandOn;
    center(ctx, 'press any key / tap to start', 90);
  } else if (s.phase === 'over') {
    // ミスを「失敗」でなく「ここまで走った記録」として見せる (赤は使わない)。
    // 見出しは記録の良さで選び、0 点でも走った秒数という数字が残るようにする
    const head = overHeadline(s, clearScore);
    panel(ctx, 24, 32, SCREEN_W - 48, 66, head.color);
    ctx.fillStyle = head.color;
    ctx.font = `bold 16px ${MONO}`;
    center(ctx, head.text, 38);
    ctx.font = `8px ${MONO}`;
    ctx.fillStyle = '#dcdce4';
    center(ctx, `${s.score} pts   ${formatSec(s.runMs)}s run`, 57);

    // 目標までの進捗バー。自己ベストの位置に印を立て、「あと少し」を目で見せる
    const bx = 44;
    const bw = SCREEN_W - 88;
    ctx.fillStyle = COL.gaugeOff;
    ctx.fillRect(bx, 69, bw, 3);
    ctx.fillStyle = head.color;
    ctx.fillRect(bx, 69, Math.round(bw * Math.min(1, s.score / clearScore)), 3);
    if (!s.newBest && s.best > 0) {
      ctx.fillStyle = COL.clear;
      ctx.fillRect(bx + Math.round(bw * Math.min(1, s.best / clearScore)), 67, 1, 7);
    }

    ctx.fillStyle = '#a0a0aa';
    // 記録がまだ無い (best 0) 回は BEST を出さない。「BEST 0」はさびしく見える
    const bestParts = [];
    if (!s.newBest && s.best > 0) bestParts.push(`BEST ${s.best}`);
    if (bestClearMs > 0) bestParts.push(`BEST TIME ${formatSec(bestClearMs)}s`);
    bestParts.push(`GOAL ${clearScore}`);
    center(ctx, bestParts.join(' / '), 76);
    ctx.fillStyle = COL.bandOn;
    center(ctx, 'post to X below / key to retry', 87);
  } else if (s.phase === 'clear') {
    const accent = rushColor(s, 0);
    panel(ctx, 24, 32, SCREEN_W - 48, 66, accent);
    ctx.fillStyle = accent;
    ctx.font = `bold 16px ${MONO}`;
    center(ctx, 'CLEAR!', 38);
    ctx.font = `8px ${MONO}`;
    ctx.fillStyle = '#dcdce4';
    center(ctx, `TIME ${formatSec(s.clearMs)}s   RUSH x${s.rushCount}`, 58);
    // bestClearMs は呼ぶ側がこの回の結果を反映済みで渡す。同値なら今回が最速
    const isBest = s.clearMs === bestClearMs;
    ctx.fillStyle = isBest ? COL.clear : '#a0a0aa';
    center(ctx, isBest ? 'BEST TIME!' : `BEST ${formatSec(bestClearMs)}s`, 69);
    ctx.fillStyle = COL.bandOn;
    center(ctx, 'post to X below / key to retry', 84);
  }
}

/**
 * 1 フレーム描く。被弾直後の画面揺れもここで面倒を見る。
 * 揺らす前に全面を黒で塗り、ずらしてできる隙間に前フレームを残さない。
 */
export function render(ctx, s, { clearScore, bestClearMs = 0 }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.save();
  if (s.shakeMs > 0) {
    const amp = 1 + Math.floor(s.shakeMs / 120);
    ctx.translate(
      Math.round((Math.random() * 2 - 1) * amp),
      Math.round((Math.random() * 2 - 1) * amp),
    );
  }
  drawScene(ctx, s, clearScore, bestClearMs);
  drawOverlay(ctx, s, clearScore, bestClearMs);
  ctx.restore();
}

export { SCREEN_W, SCREEN_H };

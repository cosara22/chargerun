/**
 * チャージ・ラン Web 版 — ゲームロジック本体。
 *
 * Cardputer ADV 実機版 (dev/cardputer-chargerun/src/main.cpp) と、その TS 移植
 * (My-Portfolio/lib/games/chargerun/core.ts) を元にした単体公開版。
 * 座標・物理係数・しきい値は実機と同じ値を使う。
 *
 * 実機版との違いは 1 点だけ: 目標スコア CLEAR_SCORE に届いたら 'clear' へ移り、
 * 走行を終える (Web 版は「クリアして X でポストする」遊び方にするため)。
 *
 * DOM に依存しない。Node からも読み込んで bot で調整できる (tools/calibrate.mjs)。
 */

/** 実機の画面サイズ (px)。描画側もこの座標系で描く。 */
export const SCREEN_W = 240;
export const SCREEN_H = 135;

export const GROUND_Y = 112;
/** 充電帯。上端ほど速く溜まり、ドローンも上端ほど密になる。 */
export const BAND_TOP = 28;
export const BAND_BOTTOM = 86;

export const PLAYER_X = 34;
export const PLAYER_W = 10;
export const PLAYER_H = 13;

/**
 * 物理。ジャンプは小・大の2種類だけで、押し続けても高さは無段階にならない。
 * 大ジャンプは押した瞬間ではなく BIG_HOLD_MS 経過後に差分を足すため、
 * その間の落下ぶんだけ到達点が下がる。JUMP_BIG はそれを見込んだ値。
 */
export const GRAVITY = 0.46;
export const JUMP_SMALL = -5.6;
export const JUMP_BIG = -10.2;
export const BIG_HOLD_MS = 120;
export const MAX_FALL = 6.4;

export const SPEED_START = 2.3;
export const SPEED_MAX = 6.2;
export const SPEED_GAIN = 0.00016;

export const SCORE_TICK_MS = 50;
export const RESTART_LOCK_MS = 350;
/** クリア直後の誤爆再開を防ぐ。ポストボタンへ手を動かす猶予も兼ねる。 */
export const CLEAR_LOCK_MS = 1200;

/** 帯の中の高さによる充電速度の重み。下端 0.6 倍 〜 上端 1.6 倍。 */
export const DEPTH_RATE_MIN = 0.6;
export const DEPTH_RATE_SPAN = 1.0;

export const GAUGE_MAX = 9;
export const BREAK_SCORE = 50;

/** クリアに要るスコア。値の根拠は tools/calibrate.mjs の実測 (README 参照)。 */
export const CLEAR_SCORE = 1000;

export const MAX_OBSTACLES = 8;
export const BURST_MS = 180;

/** 充電中に流れる音階 (C メジャー 2 オクターブ)。滞在が続くほど 1 音ずつ上がる。 */
export const CHARGE_SCALE = [
  523, 587, 659, 698, 784, 880, 988, 1047, 1175, 1319, 1397, 1568, 1760, 1976,
  2093, 2349,
];

/** 無敵中の BGM。16 分音符相当で駆け上がる。 */
export const BGM_LEAD = [
  988, 1319, 1568, 1319, 1175, 1568, 1865, 1568, 988, 1319, 1568, 1319, 1047,
  1397, 1661, 1397,
];
export const BGM_BASS = [123, 123, 165, 123, 110, 110, 147, 110];
export const BGM_STEP_MS = 95;

/**
 * レベルデザインの要になる 2 値 (実機の既定値と同じ)。
 * 300ms/段では 9 段 2.7 秒で満タンになり、一度も避けずに無敵へ届いてしまう。
 * 500ms/段なら下端 4.5 秒・上端 2.8 秒で「下で粘るか / 上で稼ぐか」が成り立つ。
 */
export const DEFAULT_CONFIG = Object.freeze({
  fillMs: 500,
  drainMs: 420,
  clearScore: CLEAR_SCORE,
});

/** @typedef {'title' | 'playing' | 'over' | 'clear'} Phase */

export function createState(best = 0) {
  return {
    /** @type {Phase} */
    phase: 'title',
    playerY: GROUND_Y - PLAYER_H,
    velY: 0,
    onGround: true,
    jumpHoldMs: 0,
    bigApplied: false,
    speed: SPEED_START,
    spawnGap: 140,
    scroll: 0,
    score: 0,
    best,
    charging: false,
    chargeRate: 1,
    gauge: 0,
    invincible: false,
    obstacles: [],
    bursts: [],
    scoreAccMs: 0,
    toneMs: 0,
    scaleStep: 0,
    bgmMs: 0,
    bgmStep: 0,
    animMs: 0,
    shakeMs: 0,
    flashMs: 0,
    newBest: false,
    prevCharging: false,
    prevOnGround: true,
    overAtMs: 0,
    runStartMs: 0,
    rushCount: 0,
    firstRushMs: 0,
    /** クリアまでにかかった時間 (ms)。クリアしていなければ 0。 */
    clearMs: 0,
    /** 走行が終わるまでに走った時間 (ms)。ミスでもクリアでも入る (結果画面とポストに使う)。 */
    runMs: 0,
  };
}

function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** 自機の当たり判定矩形と、任意の矩形が重なるか。 */
export function hitsPlayer(s, o) {
  return overlaps(PLAYER_X, s.playerY, PLAYER_W, PLAYER_H, o.x, o.y, o.w, o.h);
}

/**
 * 障害物を 1 つ足す。
 * ドローンは帯の中に収めるが、乱数を二乗して上端ほど密にする。
 * 上へ寄るほど速く溜まる代わりに当たりやすい、という釣り合いを作るため。
 */
function spawn(s, rng) {
  if (s.obstacles.length >= MAX_OBSTACLES) return;

  const airChance = 34 + (s.speed - SPEED_START) * 9;
  const air = rng() * 100 < airChance;

  if (air) {
    const h = 7 + Math.floor(rng() * 4);
    const span = BAND_BOTTOM - BAND_TOP - h;
    const r = rng();
    s.obstacles.push({
      air: true,
      x: SCREEN_W + 8,
      y: BAND_TOP + (span > 0 ? Math.floor(span * r * r) : 0),
      w: 12 + Math.floor(rng() * 8),
      h,
    });
  } else {
    const gh = 12 + Math.floor(rng() * 16);
    s.obstacles.push({
      air: false,
      x: SCREEN_W + 8,
      y: GROUND_Y - gh,
      w: 7 + Math.floor(rng() * 6),
      h: gh,
    });
  }

  s.spawnGap = 96 + s.speed * 13 + rng() * 70;
}

function enterInvincible(s, events) {
  s.invincible = true;
  s.bgmMs = 0;
  s.bgmStep = 0;
  s.shakeMs = 220;
  s.toneMs = 0;
  s.scaleStep = 0;
  s.rushCount += 1;
  if (s.firstRushMs === 0) s.firstRushMs = s.animMs - s.runStartMs;
  events.push({ type: 'rushStart' });
}

function exitInvincible(s, events) {
  s.invincible = false;
  s.gauge = 0;
  events.push({ type: 'rushEnd' });
}

/**
 * 1 フレーム進める。dtMs は実機と同じ 16ms 固定を想定する。
 * 戻り値は「この 1 フレームで鳴らすべき音」(StepEvent の配列)。
 */
export function step(s, input, dtMs, config = DEFAULT_CONFIG) {
  const events = [];
  const rng = config.rng ?? Math.random;
  const { hold, holdEdge } = input;

  // --- 演出タイマーは状態に関係なく進める ---
  s.animMs += dtMs;
  s.shakeMs = Math.max(0, s.shakeMs - dtMs);
  s.flashMs = Math.max(0, s.flashMs - dtMs);
  for (let i = s.bursts.length - 1; i >= 0; i--) {
    const burst = s.bursts[i];
    burst.ms -= dtMs;
    if (burst.ms <= 0) s.bursts.splice(i, 1);
  }

  if (s.phase !== 'playing') return events;

  // --- ジャンプ: 短押し=小 / 長押し=大 の2種類だけ ---
  if (holdEdge && s.onGround) {
    s.velY = JUMP_SMALL;
    s.onGround = false;
    s.jumpHoldMs = 0;
    s.bigApplied = false;
    events.push({ type: 'jumpSmall' });
  }
  if (hold && !s.bigApplied && !s.onGround && s.velY < 0) {
    s.jumpHoldMs += dtMs;
    if (s.jumpHoldMs >= BIG_HOLD_MS) {
      // 経過ぶんの落下は保ったまま、初速の差だけを足して昇格する
      s.velY += JUMP_BIG - JUMP_SMALL;
      s.bigApplied = true;
      events.push({ type: 'jumpBig' });
    }
  }
  if (!hold) s.jumpHoldMs = 0;

  s.velY += GRAVITY;
  if (s.velY > MAX_FALL) s.velY = MAX_FALL;
  s.playerY += s.velY;

  if (s.playerY + PLAYER_H >= GROUND_Y) {
    s.playerY = GROUND_Y - PLAYER_H;
    s.velY = 0;
    s.onGround = true;
  } else {
    s.onGround = false;
  }
  if (s.playerY < 0) {
    s.playerY = 0;
    if (s.velY < 0) s.velY = 0;
  }

  if (s.onGround && !s.prevOnGround) events.push({ type: 'land' });
  s.prevOnGround = s.onGround;

  // --- 帯の判定 ---
  s.charging = overlaps(
    PLAYER_X, s.playerY, PLAYER_W, PLAYER_H,
    0, BAND_TOP, SCREEN_W, BAND_BOTTOM - BAND_TOP,
  );

  if (s.charging && !s.prevCharging) {
    events.push({ type: 'bandIn' });
    // 入った瞬間から音階を鳴らす
    s.toneMs = 1000;
    s.scaleStep = 0;
  } else if (!s.charging && s.prevCharging) {
    events.push({ type: 'bandOut' });
    s.toneMs = 0;
    s.scaleStep = 0;
  }
  s.prevCharging = s.charging;

  // --- ゲージ ---
  if (s.invincible) {
    // 無敵中は帯にいても溜まらない。尽きるまで減る一方
    s.gauge -= dtMs / config.drainMs;
    if (s.gauge <= 0) exitInvincible(s, events);

    s.bgmMs += dtMs;
    while (s.bgmMs >= BGM_STEP_MS) {
      s.bgmMs -= BGM_STEP_MS;
      events.push({
        type: 'bgmLead',
        freq: BGM_LEAD[s.bgmStep % BGM_LEAD.length],
        ms: BGM_STEP_MS,
      });
      if (s.bgmStep % 2 === 0) {
        events.push({
          type: 'bgmBass',
          freq: BGM_BASS[Math.floor(s.bgmStep / 2) % BGM_BASS.length],
          ms: BGM_STEP_MS * 2,
        });
      }
      s.bgmStep += 1;
    }
  } else if (s.charging) {
    // 帯の中のどの高さにいるかで充電速度が変わる (t: 0=下端 / 1=上端)
    const centerY = s.playerY + PLAYER_H * 0.5;
    const t = Math.max(0, Math.min(1, (BAND_BOTTOM - centerY) / (BAND_BOTTOM - BAND_TOP)));
    s.chargeRate = DEPTH_RATE_MIN + DEPTH_RATE_SPAN * t;

    const before = Math.floor(s.gauge);
    s.gauge += (dtMs * s.chargeRate) / config.fillMs;
    if (Math.floor(s.gauge) > before) s.flashMs = 140;

    // 帯にいる間は音階を流し続ける。居続けるほど 1 音ずつ上がり、
    // 帯の上寄り (充電が速い高さ) ほど速く刻む
    s.toneMs += dtMs;
    const stepMs = 160 - s.chargeRate * 50;
    if (s.toneMs >= stepMs) {
      s.toneMs = 0;
      const idx = Math.min(s.scaleStep, CHARGE_SCALE.length - 1);
      events.push({ type: 'chargeTone', freq: CHARGE_SCALE[idx], ms: stepMs * 0.9 });
      if (s.scaleStep < CHARGE_SCALE.length) s.scaleStep += 1;
    }

    if (s.gauge >= GAUGE_MAX) {
      s.gauge = GAUGE_MAX;
      enterInvincible(s, events);
    }
  } else if (s.onGround) {
    // 地上ではゲージは増えないが、失われもしない
    s.chargeRate = 1;
  }

  // --- 帯にいる間の加点 (高い位置ほど多い) ---
  if (s.charging) {
    s.scoreAccMs += dtMs;
    while (s.scoreAccMs >= SCORE_TICK_MS) {
      s.scoreAccMs -= SCORE_TICK_MS;
      s.score += 1 + Math.floor(s.chargeRate * 2);
    }
  }

  // --- スクロールと障害物 ---
  s.speed = Math.min(s.speed + SPEED_GAIN * dtMs, SPEED_MAX);
  const advance = s.speed * (dtMs / 16);
  s.scroll = (s.scroll + advance) % 24;
  s.spawnGap -= advance;
  if (s.spawnGap <= 0) spawn(s, rng);

  for (let i = s.obstacles.length - 1; i >= 0; i--) {
    const o = s.obstacles[i];
    o.x -= advance;
    if (o.x + o.w < -4) {
      s.obstacles.splice(i, 1);
      continue;
    }
    if (!hitsPlayer(s, o)) continue;

    if (s.invincible) {
      // 無敵中は壊して加点する (溜めた見返りをここで受け取る)
      s.bursts.push({ x: o.x + o.w / 2, y: o.y + o.h / 2, ms: BURST_MS });
      s.obstacles.splice(i, 1);
      s.score += BREAK_SCORE;
      s.shakeMs = 120;
      events.push({ type: 'break' });
      continue;
    }

    s.phase = 'over';
    s.overAtMs = s.animMs;
    s.runMs = s.animMs - s.runStartMs;
    s.charging = false;
    s.shakeMs = 320;
    if (s.score > s.best) {
      s.best = s.score;
      s.newBest = true;
    }
    events.push({ type: 'crash', newBest: s.newBest });
    return events;
  }

  // --- クリア判定: 目標スコアに届いた時点で走行を終える ---
  if (s.score >= config.clearScore) {
    s.phase = 'clear';
    s.overAtMs = s.animMs;
    s.clearMs = s.animMs - s.runStartMs;
    s.runMs = s.clearMs;
    s.charging = false;
    s.invincible = false;
    s.shakeMs = 220;
    if (s.score > s.best) {
      s.best = s.score;
      s.newBest = true;
    }
    events.push({ type: 'clear', newBest: s.newBest });
  }

  return events;
}

/** タイトル / ゲームオーバー / クリアから走行を開始する。best と経過時間は引き継ぐ。 */
export function startRun(s) {
  const next = createState(s.best);
  next.animMs = s.animMs;
  next.runStartMs = s.animMs;
  next.phase = 'playing';
  return next;
}

/** ミス・クリア直後の誤爆再開を防ぐ。 */
export function canRestart(s) {
  if (s.phase === 'title') return true;
  const lock = s.phase === 'clear' ? CLEAR_LOCK_MS : RESTART_LOCK_MS;
  return s.animMs - s.overAtMs >= lock;
}

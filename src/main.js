/**
 * チャージ・ラン Web 版 — ページ側 (canvas・入力・ループ・記録・X ポスト)。
 *
 * ゲームの中身は core.js、描画は render.js、音は audio.js。
 * ここはそれらをつなぎ、クリアしたときに X の投稿画面 (Web Intent) への導線を出す。
 */
import { GameAudio } from './audio.js';
import {
  DEFAULT_CONFIG,
  SCREEN_H,
  SCREEN_W,
  canRestart,
  createState,
  startRun,
  step,
} from './core.js';
import { formatSec, render } from './render.js';

const FRAME_MS = 16;
/** ポストに載せる URL。ローカルで試したときも公開 URL を載せる。 */
const SITE_URL = 'https://cosara22.github.io/chargerun/';
const HASHTAG = 'チャージラン';
const KEY = { best: 'chargerun.best', bestClear: 'chargerun.bestClearMs', muted: 'chargerun.muted' };

// 目標点の上書き (?goal=N) はローカルでの動作確認専用。公開先で効くとクリアを偽れるため
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const goalParam = Number(new URLSearchParams(location.search).get('goal'));
const config = {
  ...DEFAULT_CONFIG,
  clearScore: isLocal && goalParam > 0 ? goalParam : DEFAULT_CONFIG.clearScore,
};

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const clearPanel = document.getElementById('clear-panel');
const clearSummary = document.getElementById('clear-summary');
const postLink = document.getElementById('post-x');
const retryButton = document.getElementById('retry');
const muteButton = document.getElementById('mute');
const goalLabel = document.getElementById('goal');

canvas.width = SCREEN_W;
canvas.height = SCREEN_H;
goalLabel.textContent = String(config.clearScore);

const audio = new GameAudio();
let state = createState(readNumber(KEY.best));
let bestClearMs = readNumber(KEY.bestClear);
let hold = false;
let prevHold = false;
// 瞬間タップ対策: 押下はイベントでラッチし、ループ側で 1 回ぶん必ず消費する。
// hold を 16ms 周期で読むだけだと、down→up が 1 フレーム内に収まってエッジが消える
let pendingEdge = false;

function readNumber(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // プライベートモード等で使えなくても遊べる
  }
}

function writeValue(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    // 保存できなくても進行は妨げない
  }
}

// --- ミュート ---
let muted = (() => {
  try {
    return localStorage.getItem(KEY.muted) === '1';
  } catch {
    return false;
  }
})();
function applyMute() {
  audio.setMuted(muted);
  muteButton.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  muteButton.setAttribute('aria-pressed', String(muted));
}
applyMute();
muteButton.addEventListener('click', () => {
  muted = !muted;
  writeValue(KEY.muted, muted ? '1' : '0');
  applyMute();
  canvas.focus({ preventScroll: true });
});

// --- 入力 ---
function press() {
  audio.resume();
  hold = true;
  pendingEdge = true;
}
function release() {
  hold = false;
}

canvas.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') return; // フォーカス移動は妨げない
  if (e.ctrlKey || e.metaKey || e.altKey) return; // ブラウザのショートカットは通す
  e.preventDefault();
  if (e.repeat) return; // オートリピートでエッジを再ラッチしない (勝手に再開してしまう)
  press();
});
canvas.addEventListener('keyup', (e) => {
  if (e.key === 'Tab') return;
  release();
});
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture?.(e.pointerId);
  press();
});
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('blur', release);
// 長押しで出るコンテキストメニュー (スマホ・右クリック) を止める
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

retryButton.addEventListener('click', () => {
  audio.resume();
  restart();
  canvas.focus({ preventScroll: true });
});

function restart() {
  state = startRun(state);
  clearPanel.hidden = true;
}

// --- クリア時の X ポスト ---
function buildPostUrl(s) {
  const lines = [
    `チャージ・ランをクリア！`,
    `クリアタイム ${formatSec(s.clearMs)}秒 / RUSH ${s.rushCount}回 / スコア ${s.score}`,
    `#${HASHTAG}`,
  ];
  const params = new URLSearchParams({ text: lines.join('\n'), url: SITE_URL });
  return `https://x.com/intent/post?${params.toString()}`;
}

function onClear(s) {
  if (bestClearMs === 0 || s.clearMs < bestClearMs) {
    bestClearMs = s.clearMs;
    writeValue(KEY.bestClear, bestClearMs);
  }
  clearSummary.textContent =
    `クリアタイム ${formatSec(s.clearMs)} 秒 / RUSH ${s.rushCount} 回 / スコア ${s.score}` +
    (s.clearMs === bestClearMs ? '(自己ベスト)' : `(自己ベスト ${formatSec(bestClearMs)} 秒)`);
  postLink.href = buildPostUrl(s);
  clearPanel.hidden = false;
}

// --- ループ ---
let acc = 0;
let last = performance.now();

function frame(now) {
  // タブ復帰直後などに大量のフレームを一気に進めない
  acc += Math.min(now - last, 100);
  last = now;
  while (acc >= FRAME_MS) {
    acc -= FRAME_MS;
    // ラッチしたエッジがある間は、離されていても 1 フレームだけ押下扱いにする
    const pending = pendingEdge;
    const h = hold || pending;
    const holdEdge = (h && !prevHold) || pending;
    pendingEdge = false;
    prevHold = hold;

    if (state.phase === 'playing') {
      const events = step(state, { hold: h, holdEdge }, FRAME_MS, config);
      audio.play(events, state.invincible);
      // step の中で終わりへ遷移しうるので、状態ではなくイベントで見る
      for (const e of events) {
        if ((e.type === 'crash' || e.type === 'clear') && e.newBest) writeValue(KEY.best, state.best);
        if (e.type === 'clear') onClear(state);
      }
    } else {
      // タイトル / ゲームオーバー / クリアでも演出タイマーだけは進める
      step(state, { hold: h, holdEdge }, FRAME_MS, config);
      if (holdEdge && canRestart(state)) restart();
    }
  }
  render(ctx, state, { clearScore: config.clearScore, bestClearMs });
  requestAnimationFrame(frame);
}

canvas.focus({ preventScroll: true });
requestAnimationFrame(frame);

// 動作確認用 (Playwright から状態を読む)。ローカルでだけ公開する
if (isLocal) window.__chargerun = { get state() { return state; }, config };

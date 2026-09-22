/**
 * チャージ・ラン Web 版 — 音。
 *
 * core が返す StepEvent を受けて鳴らすだけの層。実機は圧電スピーカーなので、
 * 矩形波で音色を寄せる。周波数と長さは実機と同じ値を core から受け取る。
 * ブラウザの自動再生制限があるため、AudioContext は最初の操作で開く。
 */

/** 実機のチャンネル音量 (255 基準) をおおよその gain へ写した値。 */
const GAIN = {
  sfx: 0.05,
  cue: 0.045,
  charge: 0.06,
  lead: 0.035,
  bass: 0.04,
};

/** クリアのジングル (Web 版で追加)。C-E-G-C の駆け上がり。[周波数, 開始ms, 長さms] */
const CLEAR_JINGLE = [
  [1047, 0, 110],
  [1319, 110, 110],
  [1568, 220, 110],
  [2093, 330, 380],
];

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** ユーザー操作の中で呼ぶこと (自動再生制限のため)。 */
  resume() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(v) {
    this.muted = v;
  }

  tone(freq, ms, gain, delayMs = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'square'; // 圧電ブザーに近い音色
    osc.frequency.value = freq;
    osc.connect(amp);
    amp.connect(ctx.destination);
    const t = ctx.currentTime + delayMs / 1000;
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }

  /** 無敵中は効果音にオクターブ上を重ねて派手にする。 */
  beep(freq, ms, invincible) {
    if (invincible) {
      this.tone(freq * 1.5, ms * 1.5, GAIN.sfx);
      this.tone(freq * 3, ms, GAIN.cue);
    } else {
      this.tone(freq, ms, GAIN.sfx);
    }
  }

  /** 1 フレームぶんのイベントを鳴らす。 */
  play(events, invincible) {
    for (const e of events) {
      switch (e.type) {
        case 'jumpSmall':
          this.beep(660, 22, invincible);
          break;
        case 'jumpBig':
          this.beep(880, 22, invincible);
          break;
        case 'land':
          this.beep(240, 18, invincible);
          break;
        case 'bandIn':
          this.beep(1180, 22, invincible);
          break;
        case 'bandOut':
          this.beep(520, 22, invincible);
          break;
        case 'chargeTone':
          // 音量は一定。変わるのは音程と刻みの速さだけ
          this.tone(e.freq, e.ms, GAIN.charge);
          break;
        case 'rushStart':
          this.tone(1568, 70, GAIN.sfx);
          this.tone(2093, 90, GAIN.cue);
          break;
        case 'rushEnd':
          this.tone(392, 90, GAIN.sfx);
          break;
        case 'break':
          this.tone(196, 60, GAIN.sfx);
          this.tone(2637, 50, GAIN.cue);
          break;
        case 'crash':
          this.tone(130, 300, GAIN.sfx);
          // 被弾音に高音を重ねる。失敗の音だけで終わらせない
          if (e.newBest) this.tone(1568, 140, GAIN.cue);
          break;
        case 'clear':
          for (const [f, at, ms] of CLEAR_JINGLE) {
            this.tone(f, ms, GAIN.sfx, at);
            this.tone(f / 2, ms, GAIN.bass, at);
          }
          break;
        case 'bgmLead':
          this.tone(e.freq, e.ms, GAIN.lead);
          break;
        case 'bgmBass':
          this.tone(e.freq, e.ms, GAIN.bass);
          break;
      }
    }
  }
}

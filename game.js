/* ============================================================
   MindMine — game.js
   ============================================================ */

'use strict';

/* ----------------------------------------------------------
   定数
   ---------------------------------------------------------- */
const WAVE_INTERVAL   = 20000;   // Wave が上がるまでの ms
const BASE_SPAWN_MS   = 2800;    // Wave1 の敵スポーン間隔 (ms)
const MINE_READY_MS   = 3000;    // 地雷設置からこの時間後に起爆可能になる (ms)
const CHARGE_FULL_MS  = 2000;    // キーをこの時間押し続けると最大チャージ（超過で不発弾）(ms)
const BLAST_MIN       = 40;      // 最小爆破半径: タップ即離しのとき (px)
// 実際の blastMax はゲーム開始時に initState() で算出する（下記 blastMax 変数）
const ENEMY_R_MIN     = 14;      // 敵の最小半径 (px)
const ENEMY_R_MAX     = 26;      // 敵の最大半径 (px)
// 進化間隔: 大きい敵ほど速く進化（20秒〜30秒）
// r=ENEMY_R_MAX → EVO_MS_MIN(20s)、r=ENEMY_R_MIN → EVO_MS_MAX(30s)
const EVO_MS_MIN      = 20000;
const EVO_MS_MAX      = 30000;
const MAX_STAGE       = 5;       // 最終段階インデックス (0〜5 の 6 段階)
const FINAL_HORROR_MS = 5000;    // 最終段階演出の継続 ms
const TRACK_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-^\\@[;:],./'.split('');

/* プレイ開始時のウィンドウサイズを固定して使う
   （プレイ中のリサイズは無視。ゲーム開始時に initState() で設定される） */
let gameW = window.innerWidth;
let gameH = window.innerHeight;
let blastMax = Math.min(gameW, gameH) / 4;  // 最大爆破サイズ

/* 各進化段階のビジュアル設定 */
const STAGE_STYLE = [
  { fill: 0x4488cc, stroke: 0x88ccff, glow: 0x66aaff, rMul: 1.0  }, // 0: 水色
  { fill: 0x339944, stroke: 0x66ee66, glow: 0x44dd44, rMul: 1.1  }, // 1: 草緑
  { fill: 0xaaaa00, stroke: 0xffff44, glow: 0xeeee00, rMul: 1.2  }, // 2: 黄色
  { fill: 0xcc6600, stroke: 0xffaa22, glow: 0xff8800, rMul: 1.35 }, // 3: オレンジ
  { fill: 0xbb1100, stroke: 0xff4422, glow: 0xff2200, rMul: 1.5  }, // 4: 赤
  { fill: 0x1a0000, stroke: 0xcc0000, glow: 0x880000, rMul: 1.8  }, // 5: 暗黒赤
];

/* 爆発の色テーブル (通常 / 不発弾) */
const BLAST_COLORS = {
  normal: [0xff8800, 0xffcc00, 0xff4400, 0xffff88],
  dud:    [0x4488ff, 0x88ccff, 0x2244cc, 0xaaccff],
};

/* ----------------------------------------------------------
   PixiJS Application 初期化
   ---------------------------------------------------------- */
const app = new PIXI.Application({
  resizeTo: window,        // ウィンドウリサイズに追従
  antialias: true,
  autoDensity: true,       // HiDPI (Retina) 対応
  backgroundColor: 0x000000,
  resolution: window.devicePixelRatio || 1,
});
document.body.appendChild(app.view); // <canvas> を body 先頭に挿入

/* ----------------------------------------------------------
   シーングラフのレイヤー構成

   worldContainer ─── 画面シェイクのターゲット
     ├─ bgGfx          背景グリッド描画
     ├─ explosionLayer 爆発エフェクト（パーティクル）
     ├─ mineLayer      地雷スプライト
     ├─ enemyLayer     敵スプライト
     └─ overlayGfx     チャージプレビュー円など

   chargeGfx    ── worldContainer の外（シェイクされない）
   crosshairGfx ── worldContainer の外（照準）
   floatLayer   ── worldContainer の外（浮き上がりスコアテキスト）
   ---------------------------------------------------------- */
const worldContainer = new PIXI.Container();
app.stage.addChild(worldContainer);

const bgGfx          = new PIXI.Graphics();
const explosionLayer = new PIXI.Container();
const mineLayer      = new PIXI.Container();
const enemyLayer     = new PIXI.Container();
const overlayGfx     = new PIXI.Graphics();
worldContainer.addChild(bgGfx, explosionLayer, mineLayer, enemyLayer, overlayGfx);

const chargeGfx    = new PIXI.Graphics(); // チャージ中の爆発範囲プレビュー
const crosshairGfx = new PIXI.Graphics(); // マウスカーソル照準
const floatLayer   = new PIXI.Container(); // 浮き上がりスコアテキスト
app.stage.addChild(chargeGfx, crosshairGfx, floatLayer);

// 爆発パーティクル用の共有 Graphics（毎フレーム clear して再描画）
const particleGfx = new PIXI.Graphics();
explosionLayer.addChild(particleGfx);

/* ----------------------------------------------------------
   サウンドエフェクト（Web Audio API で合成、外部ファイル不要）
   ---------------------------------------------------------- */
const _ac = new (window.AudioContext || window.webkitAudioContext)();

/**
 * 汎用トーン生成ユーティリティ
 * @param {string} type   - オシレーター波形 ('sine'|'square'|'sawtooth'|'triangle')
 * @param {number} freq   - 開始周波数 (Hz)
 * @param {number} endFreq- 終了周波数（スウィープ）
 * @param {number} dur    - 持続時間 (秒)
 * @param {number} vol    - 音量 0〜1
 * @param {number} [delay=0] - 開始ディレイ (秒)
 */
function _tone(type, freq, endFreq, dur, vol, delay) {
  delay = delay || 0;
  const t   = _ac.currentTime + delay;
  const osc = _ac.createOscillator();
  const gain= _ac.createGain();
  osc.type  = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 10), t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  gain.connect(_ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.01);
}

/** ホワイトノイズバースト（爆発音の低音に重ねる） */
function _noise(dur, vol, delay) {
  delay = delay || 0;
  const bufSize = Math.floor(_ac.sampleRate * dur);
  const buf = _ac.createBuffer(1, bufSize, _ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src  = _ac.createBufferSource();
  const gain = _ac.createGain();
  const t    = _ac.currentTime + delay;
  src.buffer = buf;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(gain);
  gain.connect(_ac.destination);
  src.start(t);
}

// --- 各 SE 関数 ---

/** 地雷設置（通常）: 短い金属的なクリック音 */
function sePlace() {
  _tone('triangle', 320, 120, 0.12, 0.25);
  _noise(0.06, 0.08);
}

/** 地雷設置（不発弾）: 鈍いこもった音 */
function sePlaceDud() {
  _tone('sawtooth', 180, 60, 0.2, 0.2);
  _noise(0.12, 0.05);
}

/** 不発弾キー押下: エラーブザー */
function seDudPress() {
  _tone('square', 140, 100, 0.18, 0.18);
  _tone('square', 105, 80,  0.18, 0.12, 0.09);
}

/** 地雷が起爆可能になった瞬間: ピン音 */
function seReady() {
  _tone('sine', 880, 1200, 0.15, 0.2);
  _tone('sine', 1200, 1600, 0.1, 0.12, 0.12);
}

/** 爆発: 爆破半径に応じた迫力 */
function seExplode(br) {
  const scale = Math.min(br / 220, 1);        // 0〜1
  const vol   = 0.15 + scale * 0.35;
  const dur   = 0.25 + scale * 0.4;
  _noise(dur, vol * 1.2);
  _tone('sawtooth', 80 + scale * 60, 20, dur, vol * 0.8);
  _tone('sine', 200, 40, dur * 0.6, vol * 0.4);
}

/** 不発弾誘爆: 爆発より低くこもった音 */
function seDudExplode(br) {
  const scale = Math.min(br / 220, 1);
  _noise(0.25, 0.1 + scale * 0.1);
  _tone('triangle', 120, 30, 0.3, 0.15);
}

/** 敵を倒した（n匹同時）: ポップ音 */
function seKill(n) {
  const count = Math.min(n, 5);
  for (let i = 0; i < count; i++) {
    const freq = 300 + i * 80;
    _tone('sine', freq * 1.5, freq * 0.5, 0.12, 0.15 / count, i * 0.04);
  }
}

/** ジャストミート: キラキラ音 */
function seJustMeet() {
  [880, 1100, 1320, 1760].forEach((f, i) => _tone('sine', f, f * 1.2, 0.15, 0.18, i * 0.05));
}

/** カウントダウン数字（3・2・1）: ビープ */
function seCountdownTick() {
  _tone('sine', 660, 640, 0.1, 0.25);
}

/** START: 上昇アルペジオ */
function seCountdownStart() {
  [440, 550, 660, 880].forEach((f, i) => _tone('sine', f, f * 1.05, 0.15, 0.3, i * 0.07));
}

/** 最終段階到達: 不穏な和音 */
function seFinalStage() {
  _tone('sawtooth', 220, 215, 1.5, 0.15);
  _tone('sawtooth', 233, 228, 1.5, 0.12);
  _tone('sawtooth', 110, 108, 1.5, 0.1);
}

/** ゲームオーバー: 下降音 */
function seGameOver() {
  [440, 370, 311, 233].forEach((f, i) => _tone('sawtooth', f, f * 0.9, 0.3, 0.2, i * 0.2));
}

/** コンボ更新（高コンボ時のみ）: 上昇ピッチ */
function seCombo(count) {
  if (count < 5) return;
  const freq = Math.min(400 + count * 30, 1200);
  _tone('sine', freq, freq * 1.4, 0.15, 0.2);
}

/** ランクアップ: 明るい上昇音 */
function seRankUp() {
  [523, 659, 784, 1047].forEach((f, i) => _tone('sine', f, f * 1.1, 0.18, 0.28, i * 0.06));
}

/** ランクダウン: 暗い下降音 */
function seRankDown() {
  [440, 349, 277, 220].forEach((f, i) => _tone('sawtooth', f, f * 0.9, 0.22, 0.18, i * 0.07));
}

/* ----------------------------------------------------------
   ゲーム状態変数
   ---------------------------------------------------------- */
let enemies    = [];
let mines      = {};
let particles  = [];
let floatTexts = [];

let score      = 0;
let comboCount = 0;
let maxCombo   = 0;
let wave       = 1;
let gameRunning   = false;
let countdownPhase= false;
let countdownVal  = 3;
let countdownTimer= 0;

let finalStageMode  = false;
let finalStageTimer = 0;

let waveTimer  = 0;
let spawnTimer = 0;

let mouseX = 0;
let mouseY = 0;

const holdStart = {};

let shakeIntensity = 0;
let msgTimer = null;

/* ----------------------------------------------------------
   プレイヤーランクシステム
   1 スタート、上限なし。数値で表示。
   30 秒ごとに「倒した数 vs スポーン数」でランクを上下。
   ---------------------------------------------------------- */

/** rankIndex (0始まり) → 表示ランク数値 */
function getRankLabel(i) { return String(i + 1); }

/** rankIndex → スコア倍率 (1倍〜 線形増加) */
function getRankMult(i)  { return i + 1; }
const RANK_INTERVAL_MS    = 30000; // ランク評価間隔 (ms)
const RANK_REFERENCE_MS   = 20000; // 基準出現数を算出する参照時間 (ms)
const RANK_UP_THRESHOLD   = 0.6;   // 撃破率がこの割合以上でランクアップ
const RANK_DOWN_THRESHOLD = 0.4;   // 撃破率がこの割合以下でランクダウン

let rankIndex          = 0;   // 現在のランクインデックス（表示は +1）
let rankTimer          = 0;   // 評価タイマー (ms)
let rankKillCount      = 0;   // 今の評価期間で倒した敵の数
let rankFlashTimer     = 0;   // ランク変動フラッシュ残り時間 (秒)
let currentSpawnInterval = BASE_SPAWN_MS; // 直近のスポーン間隔（updateUI から参照）
let totalKills      = 0;   // ゲーム全体の撃破数
let playTimeSec     = 0;   // ゲームプレイ時間（秒）

/* ----------------------------------------------------------
   敵の移動パターン定義
   ---------------------------------------------------------- */
const MOVE_TYPES = [
  // 0: 直進
  {
    init(e) {
      const spd = 60 + Math.random() * 80;
      const ang = Math.random() * Math.PI * 2;
      e.vx = Math.cos(ang) * spd;
      e.vy = Math.sin(ang) * spd;
    },
    update(e, dt) { e.x += e.vx * dt; e.y += e.vy * dt; }
  },
  // 1: サイン波
  {
    init(e) {
      const spd = 70 + Math.random() * 60;
      e.dir   = Math.random() * Math.PI * 2;
      e.amp   = 50 + Math.random() * 80;
      e.freq  = 1 + Math.random() * 2;
      e.phase = Math.random() * Math.PI * 2;
      e.vx = Math.cos(e.dir) * spd;
      e.vy = Math.sin(e.dir) * spd;
    },
    update(e, dt, now) {
      const perp = Math.sin(now * e.freq + e.phase) * e.amp * dt;
      e.x += e.vx * dt + Math.cos(e.dir + Math.PI / 2) * perp;
      e.y += e.vy * dt + Math.sin(e.dir + Math.PI / 2) * perp;
    }
  },
  // 2: 緩やかなカーブ
  {
    init(e) {
      e.angle    = Math.random() * Math.PI * 2;
      e.spd      = 50 + Math.random() * 70;
      e.turnRate = (Math.random() - 0.5) * 1.5;
    },
    update(e, dt) {
      e.angle += e.turnRate * dt;
      e.x += Math.cos(e.angle) * e.spd * dt;
      e.y += Math.sin(e.angle) * e.spd * dt;
    }
  },
  // 3: ジグザグ
  {
    init(e) {
      e.angle       = Math.random() * Math.PI * 2;
      e.spd         = 80 + Math.random() * 60;
      e.zigTimer    = 0;
      e.zigInterval = 0.6 + Math.random() * 0.8;
    },
    update(e, dt) {
      e.zigTimer += dt;
      if (e.zigTimer >= e.zigInterval) {
        e.zigTimer -= e.zigInterval;
        e.angle += (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 3 + Math.random() * Math.PI / 4);
      }
      e.x += Math.cos(e.angle) * e.spd * dt;
      e.y += Math.sin(e.angle) * e.spd * dt;
    }
  },
  // 4: 弧を描く旋回
  {
    init(e) {
      e.angle    = Math.random() * Math.PI * 2;
      e.spd      = 60 + Math.random() * 60;
      e.turnRate = (Math.random() > 0.5 ? 1 : -1) * (0.8 + Math.random() * 1.2);
    },
    update(e, dt) {
      e.angle += e.turnRate * dt;
      e.x += Math.cos(e.angle) * e.spd * dt;
      e.y += Math.sin(e.angle) * e.spd * dt;
    }
  },
];

/* ----------------------------------------------------------
   ユーティリティ
   ---------------------------------------------------------- */
function hexToRgb(hex) {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

function lerpColor(a, b, t) {
  const ac = hexToRgb(a), bc = hexToRgb(b);
  return (
    (Math.round(ac.r + (bc.r - ac.r) * t) << 16) |
    (Math.round(ac.g + (bc.g - ac.g) * t) << 8)  |
     Math.round(ac.b + (bc.b - ac.b) * t)
  );
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

/* ----------------------------------------------------------
   グロー描画ヘルパー
   透明度を落としながら外に広がる同心円でグローを表現する
   ---------------------------------------------------------- */
function drawGlow(gfx, x, y, r, color, alpha, layers) {
  alpha  = alpha  || 0.18;
  layers = layers || 5;
  for (let i = layers; i > 0; i--) {
    gfx.beginFill(color, alpha / i);
    gfx.drawCircle(x, y, r * (1 + i * 0.35));
    gfx.endFill();
  }
}

/* ----------------------------------------------------------
   点線円描画ヘルパー
   ---------------------------------------------------------- */
function drawDottedCircle(gfx, x, y, r, color, alpha, dotCount) {
  alpha    = alpha    || 0.6;
  dotCount = dotCount || 60;
  const dotR = Math.max(1.5, r * 0.018);
  gfx.beginFill(color, alpha);
  for (let i = 0; i < dotCount; i++) {
    const a = (i / dotCount) * Math.PI * 2;
    gfx.drawCircle(x + Math.cos(a) * r, y + Math.sin(a) * r, dotR);
  }
  gfx.endFill();
}

/* ----------------------------------------------------------
   敵の目を描画する（gfx はその敵専用の PIXI.Graphics）
   ---------------------------------------------------------- */
function drawEnemyEyes(gfx, stage, drawR, now) {
  const st   = STAGE_STYLE[stage];
  const eyeR = drawR * (0.2 + stage * 0.04);
  const eyeY = -drawR * 0.15;
  const eyeX = drawR * 0.3;
  // 白目なし: 眼球全体を黒い瞳孔で覆う。段階が上がるほど大きくなる。
  const pupilR = eyeR * (0.75 + stage * 0.05); // stage0=75%〜stage5=100%

  for (let side = -1; side <= 1; side += 2) {
    const ex = side * eyeX;

    // 瞳孔のみ（白目なし）
    if (stage >= 1) drawGlow(gfx, ex, eyeY, pupilR * 1.05, st.glow, 0.3, 3);
    gfx.beginFill(0x000000, 1);
    gfx.drawCircle(ex, eyeY, Math.min(pupilR, eyeR));
    gfx.endFill();

    // 怒り眉（段階 2 以上）
    if (stage >= 2) {
      const browSlope = (stage - 1) * 4;
      const browY     = eyeY - eyeR - 3;
      const browColor = stage >= 4 ? 0xff2200 : 0x220000;
      gfx.lineStyle(Math.max(1.5, drawR * 0.05), browColor, stage >= 4 ? 1 : 0.8);
      gfx.moveTo(ex - eyeR, browY + side * browSlope);
      gfx.lineTo(ex + eyeR, browY - side * browSlope);
      gfx.lineStyle(0);
    }

    // 血走り（段階 5）
    if (stage >= MAX_STAGE) {
      gfx.lineStyle(0.8, 0xff0000, 0.7);
      for (let v = 0; v < 3; v++) {
        const va = (v / 3) * Math.PI * 2;
        gfx.moveTo(ex + Math.cos(va) * eyeR * 0.5, eyeY + Math.sin(va) * eyeR * 0.5);
        gfx.lineTo(ex + Math.cos(va) * eyeR * 0.95, eyeY + Math.sin(va) * eyeR * 0.95);
      }
      gfx.lineStyle(0);
    }
  }

  // 口: 段階 0〜1 は笑顔、段階 2 は平坦、段階 3 以上は不機嫌
  const mouthY  = drawR * 0.32;
  const mouthW  = drawR * 0.38;
  const lw      = Math.max(1.2, drawR * 0.045);
  if (stage <= 1) {
    // 笑顔: 下に開いた弧
    const mouthColor = stage === 0 ? 0x003311 : 0x112200;
    gfx.lineStyle(lw, mouthColor, 0.9);
    gfx.arc(0, mouthY - mouthW * 0.4, mouthW * 0.6, Math.PI * 0.1, Math.PI * 0.9);
    gfx.lineStyle(0);
  } else if (stage === 2) {
    // 平坦: 横一文字
    gfx.lineStyle(lw, 0x221100, 0.7);
    gfx.moveTo(-mouthW * 0.5, mouthY);
    gfx.lineTo( mouthW * 0.5, mouthY);
    gfx.lineStyle(0);
  } else {
    // 不機嫌: 上に開いた弧（への字口）
    const mouthColor = stage >= 5 ? 0xff0000 : 0x550000;
    gfx.lineStyle(lw, mouthColor, stage >= 4 ? 1 : 0.85);
    gfx.arc(0, mouthY + mouthW * 0.35, mouthW * 0.5, Math.PI * 1.1, Math.PI * 1.9);
    gfx.lineStyle(0);
  }

  // 「!」マーク（段階 5 — 脈動する赤い縦棒＋点）
  if (stage >= MAX_STAGE) {
    const pulse = 0.7 + 0.3 * Math.sin(now * 8);
    const lw2   = drawR * 0.06;
    gfx.lineStyle(lw2, 0xff0000, pulse);
    gfx.moveTo(0, drawR * 0.55);
    gfx.lineTo(0, drawR * 0.72);
    gfx.lineStyle(0);
    gfx.beginFill(0xff0000, pulse);
    gfx.drawCircle(0, drawR * 0.8, lw2 * 0.8);
    gfx.endFill();
  }
}

/* ----------------------------------------------------------
   敵を再描画する（毎フレーム）
   ---------------------------------------------------------- */
function redrawEnemy(e, now) {
  const gfx   = e.gfx;
  const st    = STAGE_STYLE[e.stage];
  const drawR = e.r * st.rMul;

  gfx.clear();

  // グロー
  drawGlow(gfx, 0, 0, drawR, st.glow, 0.15, 5);

  // 外縁（stroke 色で少し大きく）
  gfx.beginFill(st.stroke, 0.9);
  gfx.drawCircle(0, 0, drawR);
  gfx.endFill();

  // 内側（fill 色）
  gfx.beginFill(st.fill, 1);
  gfx.drawCircle(0, 0, drawR * 0.82);
  gfx.endFill();

  // 最終段階の脈動ハイライト
  if (e.stage >= MAX_STAGE) {
    const pulse = 0.3 + 0.3 * Math.sin(now * 6 + e.pulseOffset);
    gfx.beginFill(0xff0000, pulse);
    gfx.drawCircle(0, 0, drawR * 0.55);
    gfx.endFill();
  }

  // 最終段階一つ手前（stage 4）: 外縁を赤↔黒で高速点滅させて危険を警告
  if (e.stage === MAX_STAGE - 1) {
    const t = (Math.sin(now * 10 + e.pulseOffset) + 1) / 2; // 0〜1
    // t=1: 明るい赤 / t=0: 暗い赤（ほぼ黒）
    const warnColor = Math.round(t * 0xff) << 16; // R チャンネルだけ変化させた 0xRR0000
    gfx.lineStyle(4, warnColor, 0.9);
    gfx.drawCircle(0, 0, drawR + 3);
    gfx.lineStyle(0);
  }

  drawEnemyEyes(gfx, e.stage, drawR, now);

  gfx.x = e.x;
  gfx.y = e.y;
}

/* ----------------------------------------------------------
   地雷を再描画する（毎フレーム）
   ---------------------------------------------------------- */
function redrawMine(m, now) {
  const gfx     = m.gfx;
  const elapsed = (now - m.placedAt) * 1000;

  gfx.clear();

  const blinkRate = m.ready ? 6 : 2;
  const blink     = m.dud ? 0.3 : (0.7 + 0.3 * Math.sin(now * blinkRate));

  let bodyColor, glowColor;
  if (m.dud) {
    bodyColor = 0x223344; glowColor = 0x224466;
  } else if (m.ready) {
    bodyColor = 0xff6600; glowColor = 0xff8800;
  } else {
    bodyColor = 0x0088cc; glowColor = 0x00aaff;
  }

  drawGlow(gfx, 0, 0, 10, glowColor, blink * 0.2, 4);

  // 六角形の本体
  gfx.beginFill(bodyColor, blink);
  const sides = 6;
  gfx.moveTo(Math.cos(0) * 10, Math.sin(0) * 10);
  for (let i = 1; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    gfx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
  }
  gfx.closePath();
  gfx.endFill();

  // 中央ドット
  gfx.beginFill(m.dud ? 0x334455 : (m.ready ? 0xffcc00 : 0x00ccff), blink);
  gfx.drawCircle(0, 0, 3.5);
  gfx.endFill();

  // 爆破範囲プレビュー（点線円）
  const previewAlpha = m.dud ? 0.15 : (m.ready ? 0.5 : 0.25);
  drawDottedCircle(gfx, 0, 0, m.blastRadius, glowColor, previewAlpha * blink, 48);

  // 不発弾の × 印
  if (m.dud) {
    gfx.lineStyle(1.5, 0x4488aa, 0.6);
    gfx.moveTo(-6, -6); gfx.lineTo(6, 6);
    gfx.moveTo(6, -6);  gfx.lineTo(-6, 6);
    gfx.lineStyle(0);
  }

  // 起爆カウントダウンテキスト
  if (!m.dud && !m.ready) {
    const remain = Math.ceil((MINE_READY_MS - elapsed) / 1000);
    m.timerText.text    = String(remain);
    m.timerText.visible = true;
  } else {
    m.timerText.visible = false;
  }

  // 不発弾キー押下時のシェイクオフセット（shakeTimer が残っている間ランダムにずらす）
  const shakeMag = m.shakeTimer > 0 ? Math.min(m.shakeTimer * 40, 6) : 0;
  gfx.x = m.x + (Math.random() - 0.5) * shakeMag * 2;
  gfx.y = m.y + (Math.random() - 0.5) * shakeMag * 2;
  m.timerText.x = m.x;
  m.timerText.y = m.y - 20;
}

/* ----------------------------------------------------------
   背景グリッド（ゲーム開始時に 1 回だけ描く）
   ---------------------------------------------------------- */
function drawBackground() {
  bgGfx.clear();

  // グリッド（gameW/gameH を使って固定サイズで描く）
  bgGfx.lineStyle(0.5, 0x112233, 0.35);
  const step = 60;
  for (let x = 0; x < gameW; x += step) { bgGfx.moveTo(x, 0); bgGfx.lineTo(x, gameH); }
  for (let y = 0; y < gameH; y += step) { bgGfx.moveTo(0, y); bgGfx.lineTo(gameW, y); }

  // 敵の活動領域境界線（やや控えめな色）
  bgGfx.lineStyle(1.5, 0x1a3a5c, 0.55);
  bgGfx.drawRect(0, 0, gameW, gameH);

  // 四隅のコーナーマーカー（少し目立つ）
  const corner = 20;
  bgGfx.lineStyle(2, 0x2a5a8c, 0.7);
  for (const [cx, cy, sx, sy] of [[0,0,1,1],[gameW,0,-1,1],[0,gameH,1,-1],[gameW,gameH,-1,-1]]) {
    bgGfx.moveTo(cx + sx * corner, cy);
    bgGfx.lineTo(cx, cy);
    bgGfx.lineTo(cx, cy + sy * corner);
  }
}

/* ----------------------------------------------------------
   十字照準（毎フレーム）
   ---------------------------------------------------------- */
function drawCrosshair() {
  crosshairGfx.clear();
  const x = mouseX, y = mouseY, sz = 10;
  crosshairGfx.lineStyle(1, 0x00ffff, 0.7);
  crosshairGfx.moveTo(x - sz, y); crosshairGfx.lineTo(x + sz, y);
  crosshairGfx.moveTo(x, y - sz); crosshairGfx.lineTo(x, y + sz);
  crosshairGfx.drawCircle(x, y, sz * 0.6);
}

/* ----------------------------------------------------------
   チャージプレビュー（毎フレーム）
   ---------------------------------------------------------- */
function drawChargePreview(now) {
  chargeGfx.clear();
  for (const key of TRACK_KEYS) {
    if (!(key in holdStart)) continue;
    const held     = (now - holdStart[key]) * 1000;
    const isDudPrev= held > CHARGE_FULL_MS;
    const clamped  = Math.min(held, CHARGE_FULL_MS);
    const t  = clamped / CHARGE_FULL_MS;
    const br = BLAST_MIN + t * (blastMax - BLAST_MIN);
    const color = isDudPrev ? 0x2244aa : lerpColor(0x0066cc, 0xffaa00, t);
    const alpha = isDudPrev ? 0.2 : (0.25 + 0.2 * t);

    drawDottedCircle(chargeGfx, mouseX, mouseY, br, color, alpha, 60);

    // チャージアーク（マウス周辺の弧でチャージ量を表示）
    chargeGfx.lineStyle(3, color, 0.7);
    chargeGfx.arc(mouseX, mouseY, 18, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
    chargeGfx.lineStyle(0);
  }
}

/* ----------------------------------------------------------
   パーティクルシステム
   ---------------------------------------------------------- */
function spawnExplosion(cx, cy, br, isDud) {
  const colors = isDud ? BLAST_COLORS.dud : BLAST_COLORS.normal;

  // フラッシュ
  particles.push({ type: 'flash', x: cx, y: cy, maxR: br * 0.6, life: 0, maxLife: 0.18, color: isDud ? 0x88ccff : 0xffffff });

  // 衝撃波リング
  particles.push({ type: 'ring', x: cx, y: cy, maxR: br, life: 0, maxLife: 0.55, color: colors[0] });

  // スパーク
  const sparkCount = Math.floor(8 + br / 10);
  for (let i = 0; i < sparkCount; i++) {
    const a   = Math.random() * Math.PI * 2;
    const spd = 120 + Math.random() * br * 2.2;
    particles.push({
      type: 'spark',
      x: cx, y: cy,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      life: 0, maxLife: 0.35 + Math.random() * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }

  // エンバー（残り火）
  const emberCount = Math.floor(5 + br / 20);
  for (let i = 0; i < emberCount; i++) {
    const a   = Math.random() * Math.PI * 2;
    const spd = 20 + Math.random() * 60;
    particles.push({
      type: 'ember',
      x: cx + (Math.random() - 0.5) * br * 0.5,
      y: cy + (Math.random() - 0.5) * br * 0.5,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 30,
      life: 0, maxLife: 0.8 + Math.random() * 0.6,
      color: colors[Math.floor(Math.random() * colors.length)],
      r: 2 + Math.random() * 3,
    });
  }
}

function updateParticles(dt) {
  const g = particleGfx;
  g.clear();

  const alive = [];
  for (const p of particles) {
    p.life += dt;
    const t    = p.life / p.maxLife;
    if (t >= 1) continue;
    alive.push(p);
    const tRev = 1 - t;

    if (p.type === 'flash') {
      g.beginFill(p.color, tRev * 0.8);
      g.drawCircle(p.x, p.y, p.maxR * (1 - t));
      g.endFill();
    }
    else if (p.type === 'ring') {
      const rr = p.maxR * easeOutCubic(t);
      g.lineStyle(Math.max(1, tRev * 8), p.color, tRev * 0.85);
      g.drawCircle(p.x, p.y, rr);
      g.lineStyle(0);
    }
    else if (p.type === 'spark') {
      p.vx *= 1 - dt * 3;
      p.vy *= 1 - dt * 3;
      p.vy += dt * 60;
      const px = p.x, py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      g.lineStyle(1.5, p.color, tRev);
      g.moveTo(px, py);
      g.lineTo(p.x, p.y);
      g.lineStyle(0);
    }
    else if (p.type === 'ember') {
      p.vy += dt * 15;
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      g.beginFill(p.color, tRev * 0.9);
      g.drawCircle(p.x, p.y, p.r * tRev);
      g.endFill();
    }
  }
  particles = alive;
}

/* ----------------------------------------------------------
   浮き上がりスコアテキスト
   ---------------------------------------------------------- */
function spawnFloatText(x, y, text, color) {
  color = color || 0xffff00;
  const style = new PIXI.TextStyle({ fontSize: 20, fill: color, fontWeight: 'bold', fontFamily: 'Courier New' });
  const t = new PIXI.Text(text, style);
  t.anchor.set(0.5, 0.5);
  t.x = x; t.y = y;
  t._life = 0;
  t._maxLife = 1.2;
  floatLayer.addChild(t);
  floatTexts.push(t);
}

function updateFloatTexts(dt) {
  const alive = [];
  for (const t of floatTexts) {
    t._life += dt;
    const tt = t._life / t._maxLife;
    if (tt >= 1) { floatLayer.removeChild(t); t.destroy(); continue; }
    t.y    -= 30 * dt;
    t.alpha = 1 - tt * 0.8;
    alive.push(t);
  }
  floatTexts = alive;
}

/* ----------------------------------------------------------
   画面シェイク
   ---------------------------------------------------------- */
function triggerShake(intensity) {
  shakeIntensity = Math.max(shakeIntensity, intensity);
}

function updateShake(dt) {
  if (shakeIntensity < 0.5) {
    worldContainer.x = 0;
    worldContainer.y = 0;
    shakeIntensity   = 0;
    return;
  }
  worldContainer.x = (Math.random() - 0.5) * shakeIntensity * 2;
  worldContainer.y = (Math.random() - 0.5) * shakeIntensity * 2;
  shakeIntensity  *= Math.pow(0.85, dt * 60);
}

/* ----------------------------------------------------------
   敵スポーン
   ---------------------------------------------------------- */
function spawnEnemy() {
  // gameW/gameH はプレイ開始時に固定された値を使う
  let x, y;
  const side = Math.floor(Math.random() * 4);
  if      (side === 0) { x = Math.random() * gameW; y = -20; }
  else if (side === 1) { x = gameW + 20;             y = Math.random() * gameH; }
  else if (side === 2) { x = Math.random() * gameW;  y = gameH + 20; }
  else                 { x = -20;                    y = Math.random() * gameH; }

  const moveType = Math.floor(Math.random() * MOVE_TYPES.length);
  const r = ENEMY_R_MIN + Math.random() * (ENEMY_R_MAX - ENEMY_R_MIN);

  // 大きい敵ほど速く進化（20s）、小さい敵ほど遅く進化（30s）
  const rNorm   = (r - ENEMY_R_MIN) / (ENEMY_R_MAX - ENEMY_R_MIN); // 0(小)〜1(大)
  const baseEvo = EVO_MS_MAX - rNorm * (EVO_MS_MAX - EVO_MS_MIN);  // 30000〜20000
  // ランクが上がるほど進化が速くなる（10%/rank 短縮）。
  // ランク5段階上昇（rankIndex=5）で上限に達し、それ以降は変化しない。下限 10000ms
  const evoRank = Math.min(rankIndex, 5);
  const evoMs   = Math.max(10000, baseEvo / (1 + evoRank * 0.1));

  const e = { x, y, r, evoMs, stage: 0, evoTimer: 0, moveType, pulseOffset: Math.random() * Math.PI * 2, gfx: new PIXI.Graphics() };
  MOVE_TYPES[moveType].init(e);
  enemyLayer.addChild(e.gfx);
  enemies.push(e);
}

/* ----------------------------------------------------------
   地雷設置
   ---------------------------------------------------------- */
function placeMine(key, x, y, blastRadius, isDud) {
  const now = performance.now() / 1000;

  const gfx = new PIXI.Graphics();
  mineLayer.addChild(gfx);

  const style = new PIXI.TextStyle({ fontSize: 12, fill: 0x00ccff, fontFamily: 'Courier New' });
  const timerText = new PIXI.Text('', style);
  timerText.anchor.set(0.5, 0.5);
  floatLayer.addChild(timerText);

  mines[key] = { x, y, blastRadius, dud: isDud, ready: false, placedAt: now, gfx, timerText, shakeTimer: 0 };

  const el = document.getElementById('ki-' + key);
  if (el) el.className = 'ki ' + (isDud ? 'dud' : 'active');

  if (isDud) sePlaceDud(); else sePlace();
  showMsg(isDud ? `[${key}] 不発弾として設置！（誘爆のみ）` : `[${key}] 設置完了 — ${MINE_READY_MS/1000}秒後に起爆可能`);
}

/* ----------------------------------------------------------
   地雷起爆（チェーン爆発も再帰処理）
   ---------------------------------------------------------- */
function detonateMine(key) {
  const m = mines[key];
  if (!m) return;

  const cx = m.x, cy = m.y, br = m.blastRadius;

  spawnExplosion(cx, cy, br, m.dud);
  triggerShake(br * 0.12);
  if (m.dud) seDudExplode(br); else seExplode(br);

  if (m.gfx)       { mineLayer.removeChild(m.gfx);      m.gfx.destroy(); }
  if (m.timerText) { floatLayer.removeChild(m.timerText); m.timerText.destroy(); }
  delete mines[key];

  const el = document.getElementById('ki-' + key);
  if (el) el.className = 'ki';

  // 範囲内の敵を倒す（最終段階の敵は無敵）
  const killed = [];
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.stage >= MAX_STAGE) continue;
    if (Math.hypot(e.x - cx, e.y - cy) <= br + e.r) {
      killed.push(e);
      enemies.splice(i, 1);
      enemyLayer.removeChild(e.gfx);
      e.gfx.destroy();
    }
  }

  // ジャストミート判定: 敵が地雷本体（半径 10px の六角形）と重なっていた場合
  // つまり「敵中心〜地雷中心」の距離が (地雷本体半径10 + 敵半径) 以内
  const MINE_BODY_R = 10;
  const justMeet = killed.some(e => Math.hypot(e.x - cx, e.y - cy) <= MINE_BODY_R + e.r);

  const n = killed.length;
  if (n > 0) {
    // 敵1匹ごとの基本点: 10pt + stage×5pt
    let basePts = killed.reduce((sum, e) => sum + (10 + e.stage * 5), 0);

    // ジャストミート ×2
    if (justMeet) basePts *= 2;

    // コンボ加算 (comboCount × 1pt)
    comboCount    += n;
    if (comboCount > maxCombo) maxCombo = comboCount;
    rankKillCount += n;
    totalKills    += n;
    basePts += comboCount;

    // 爆破範囲乗算: 範囲大=1倍、範囲小=2倍
    const radiusMult = 1 + (blastMax - br) / Math.max(blastMax - BLAST_MIN, 1);
    let pts = Math.round(basePts * radiusMult);

    // ランク倍率
    pts = Math.round(pts * getRankMult(rankIndex));

    score += pts;
    seKill(n);
    if (justMeet) seJustMeet();
    seCombo(comboCount);

    const color = justMeet ? 0xff44ff : (n >= 3 ? 0xff8800 : 0xffff00);
    const label = `+${pts}${justMeet ? ' JUST!' : ''}${n >= 2 ? ` ×${n}` : ''}`;
    spawnFloatText(cx, cy - 20, label, color);
  } else {
    comboCount = 0;
  }

  // チェーン爆発（範囲内の他の地雷を誘爆）
  for (const k of Object.keys(mines)) {
    const om = mines[k];
    if (Math.hypot(om.x - cx, om.y - cy) <= br) detonateMine(k);
  }

  updateUI();
}

/* ----------------------------------------------------------
   敵バウンス処理
   ---------------------------------------------------------- */
function bounceEnemy(e, axis, clamp, sign) {
  e[axis] = clamp;
  if (axis === 'x') {
    if      (e.vx    !== undefined) e.vx    = sign * Math.abs(e.vx);
    else if (e.angle !== undefined) e.angle = Math.PI - e.angle;
    else if (e.dir   !== undefined) e.dir   = Math.PI - e.dir;
  } else {
    if      (e.vy    !== undefined) e.vy    = sign * Math.abs(e.vy);
    else if (e.angle !== undefined) e.angle = -e.angle;
    else if (e.dir   !== undefined) e.dir   = -e.dir;
  }
}

/* ----------------------------------------------------------
   メインループ
   ---------------------------------------------------------- */
app.ticker.add((delta) => {
  const dt  = delta / 60;  // delta はフレーム単位なので秒に変換
  const now = performance.now() / 1000;

  updateShake(dt);

  /* --- カウントダウン中 --- */
  if (countdownPhase) {
    countdownTimer += dt * 1000;
    const tickMs = countdownVal <= 0 ? 700 : 1000;
    if (countdownTimer >= tickMs) {
      countdownTimer -= tickMs;
      countdownVal--;
      if (countdownVal > 0) {
        showCountdown(countdownVal);
        seCountdownTick();
      } else if (countdownVal === 0) {
        showCountdown(0);
        seCountdownStart();
      } else {
        countdownPhase = false;
        hideCountdown();
        gameRunning = true;
      }
    }
    updateParticles(dt);
    updateFloatTexts(dt);
    drawCrosshair();
    return;
  }

  if (!gameRunning) { updateParticles(dt); updateFloatTexts(dt); return; }

  /* --- 最終段階演出 --- */
  if (finalStageMode) {
    finalStageTimer += dt * 1000;
    const W = gameW, H = gameH;
    enemies.forEach(e => {
      e.stage = MAX_STAGE;
      MOVE_TYPES[e.moveType].update(e, dt * 2.5, now);
      if (e.x < e.r)     bounceEnemy(e, 'x',  e.r,     1);
      if (e.x > W - e.r) bounceEnemy(e, 'x',  W - e.r, -1);
      if (e.y < e.r)     bounceEnemy(e, 'y',  e.r,     1);
      if (e.y > H - e.r) bounceEnemy(e, 'y',  H - e.r, -1);
      redrawEnemy(e, now);
    });
    updateParticles(dt);
    updateFloatTexts(dt);
    drawCrosshair();
    if (finalStageTimer >= FINAL_HORROR_MS) endGame('手に負えなくなった…');
    return;
  }

  /* --- 通常ゲームループ --- */
  const W = gameW, H = gameH;

  // プレイ時間の積算
  playTimeSec += dt;

  // ランク評価タイマー（30 秒ごとに撃破数でランクを上下）
  rankTimer += dt * 1000;
  if (rankTimer >= RANK_INTERVAL_MS) {
    rankTimer -= RANK_INTERVAL_MS;
    const k = rankKillCount;
    rankKillCount = 0;
    const prevRank = rankIndex;

    // 現在のスポーン間隔で RANK_REFERENCE_MS(20s) に出現する敵数を基準とする
    const expectedIn20s = RANK_REFERENCE_MS / currentSpawnInterval;
    const killRate = k / expectedIn20s;
    if      (killRate >= RANK_UP_THRESHOLD)  rankIndex = rankIndex + 1;
    else if (killRate <= RANK_DOWN_THRESHOLD) rankIndex = Math.max(rankIndex - 1, 0);

    if (rankIndex !== prevRank) {
      const up = rankIndex > prevRank;
      const cx = gameW / 2, cy = gameH / 2 - 40;
      spawnFloatText(cx, cy,
        up ? `▲ RANK UP! ${getRankLabel(rankIndex)}` : `▼ RANK DOWN ${getRankLabel(rankIndex)}`,
        up ? 0x00ffff : 0xff4444);
      if (up) seRankUp(); else seRankDown();
      rankFlashTimer = 2.0; // 2 秒間フラッシュ
      const el = document.getElementById('rank-display');
      if (el) {
        el.classList.remove('rank-up', 'rank-down');
        el.classList.add(up ? 'rank-up' : 'rank-down');
        setTimeout(() => el.classList.remove('rank-up', 'rank-down'), 2000);
      }
    }
    updateUI();
  }

  // Wave タイマー
  waveTimer += dt * 1000;
  if (waveTimer >= WAVE_INTERVAL) {
    waveTimer -= WAVE_INTERVAL;
    wave++;
    document.getElementById('wave').textContent = wave;
  }

  // 敵スポーン（ランクが上がるほど間隔が短くなる: rank毎に10%短縮、最短500ms）
  spawnTimer += dt * 1000;
  const baseInterval   = Math.max(800, BASE_SPAWN_MS - (wave - 1) * 200);
  const rankSpeedMult  = 1 + rankIndex * 0.1;          // rank0=×1.0, rank7=×1.7
  currentSpawnInterval = Math.max(500, baseInterval / rankSpeedMult);
  if (spawnTimer >= currentSpawnInterval) {
    spawnTimer -= currentSpawnInterval;
    spawnEnemy();
  }

  // 敵の移動・進化・描画
  let finalReached = false;
  enemies.forEach(e => {
    if (e.stage < MAX_STAGE) {
      e.evoTimer += dt * 1000;
      if (e.evoTimer >= e.evoMs) {
        e.evoTimer -= e.evoMs;
        e.stage++;
        if (e.stage >= MAX_STAGE) finalReached = true;
      }
    }
    MOVE_TYPES[e.moveType].update(e, dt, now);
    if (e.x < e.r)     bounceEnemy(e, 'x',  e.r,     1);
    if (e.x > W - e.r) bounceEnemy(e, 'x',  W - e.r, -1);
    if (e.y < e.r)     bounceEnemy(e, 'y',  e.r,     1);
    if (e.y > H - e.r) bounceEnemy(e, 'y',  H - e.r, -1);
    redrawEnemy(e, now);
  });

  if (finalReached && !finalStageMode) {
    finalStageMode = true;
    finalStageTimer = 0;
    seFinalStage();
    showMsg('⚠ 最終段階に到達！');
    // 設置済みの全地雷を即時無効化（起爆・誘爆不可の不発弾に変える）
    for (const key of Object.keys(mines)) {
      const m = mines[key];
      m.dud   = true;
      m.ready = false;
      const el = document.getElementById('ki-' + key);
      if (el) el.className = 'ki dud';
    }
  }

  // 地雷の更新
  for (const key of Object.keys(mines)) {
    const m = mines[key];
    const elapsed = (now - m.placedAt) * 1000;
    if (!m.dud && !m.ready && elapsed >= MINE_READY_MS) {
      m.ready = true;
      seReady();
      const el = document.getElementById('ki-' + key);
      if (el) el.className = 'ki ready';
    }
    if (m.shakeTimer > 0) m.shakeTimer -= dt;
    redrawMine(m, now);
  }

  updateParticles(dt);
  updateFloatTexts(dt);
  drawCrosshair();
  drawChargePreview(now);
  updateEvoBar();
  updateUI();
});

/* ----------------------------------------------------------
   UI ヘルパー
   ---------------------------------------------------------- */
function updateUI() {
  document.getElementById('score').textContent       = score;
  document.getElementById('combo-count').textContent = comboCount;
  document.getElementById('ecount').textContent      = enemies.length;
  document.getElementById('rank-label').textContent  = getRankLabel(rankIndex);
  document.getElementById('rank-mult').textContent   = `×${getRankMult(rankIndex)}`;

  // ランク判定メーター（現在の 30 秒区間での撃破率をリアルタイム表示）
  // 基準: 現在のスポーン間隔で 20 秒間に出現する敵数
  const expectedIn20s = RANK_REFERENCE_MS / currentSpawnInterval;
  const rate = rankKillCount / expectedIn20s;
  const pct  = Math.min(Math.round(rate * 100), 999);

  document.getElementById('rank-kill-rate').textContent = `${pct}%`;

  const fill = document.getElementById('rank-meter-fill');
  const hint = document.getElementById('rank-meter-hint');
  if (fill) {
    fill.style.width = `${Math.min(pct, 100)}%`;
    // 色: 80%以上=シアン(↑), 40%以下=赤(↓), それ以外=緑(→)
    fill.style.background = rate >= RANK_UP_THRESHOLD ? '#0ff' : (rate <= RANK_DOWN_THRESHOLD ? '#f44' : '#0f0');
  }
  if (hint) {
    hint.textContent = rate >= RANK_UP_THRESHOLD ? '▲UP' : (rate <= RANK_DOWN_THRESHOLD ? '▼DN' : '→');
    hint.style.color = rate >= RANK_UP_THRESHOLD ? '#0ff' : (rate <= RANK_DOWN_THRESHOLD ? '#f44' : '#888');
  }
}

function updateEvoBar() {
  if (enemies.length === 0) return;
  const maxStage = Math.max(...enemies.map(e => e.stage));
  for (let i = 0; i < MAX_STAGE; i++) {
    const dot = document.getElementById('evo' + i);
    if (!dot) continue;
    dot.className = 'evo-dot' + (maxStage >= MAX_STAGE ? ' final' : (i < maxStage ? ' lit' : ''));
  }
}

function showMsg(text) {
  document.getElementById('msg').textContent = text;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { document.getElementById('msg').textContent = ''; }, 2500);
}

function showCountdown(val) {
  const overlay = document.getElementById('countdown-overlay');
  overlay.classList.add('active');
  const numEl = document.getElementById('countdown-num');
  numEl.classList.remove('small');  // 通常サイズに戻す
  numEl.textContent = val === 0 ? 'START' : String(val);
}

function hideCountdown() {
  document.getElementById('countdown-overlay').classList.remove('active');
}

function endGame(reason) {
  gameRunning = false;
  seGameOver();
  const kpm = playTimeSec > 0 ? (totalKills / playTimeSec * 60).toFixed(1) : '0.0';

  // localStorage から自己ベストを読み込み、更新する
  const best = {
    score : parseInt(localStorage.getItem('mm_best_score') || '0', 10),
    combo : parseInt(localStorage.getItem('mm_best_combo') || '0', 10),
    rank  : parseInt(localStorage.getItem('mm_best_rank')  || '0', 10),
    kpm   : parseFloat(localStorage.getItem('mm_best_kpm') || '0'),
  };
  if (score        > best.score) { best.score = score;           localStorage.setItem('mm_best_score', score); }
  if (maxCombo     > best.combo) { best.combo = maxCombo;        localStorage.setItem('mm_best_combo', maxCombo); }
  if (rankIndex    > best.rank)  { best.rank  = rankIndex;       localStorage.setItem('mm_best_rank',  rankIndex); }
  if (parseFloat(kpm) > best.kpm){ best.kpm   = parseFloat(kpm); localStorage.setItem('mm_best_kpm',  kpm); }

  document.getElementById('gameover-reason').textContent = reason || '';
  document.getElementById('final-score').textContent     = score;
  document.getElementById('final-combo').textContent     = maxCombo;
  document.getElementById('final-rank').textContent      = getRankLabel(rankIndex);
  document.getElementById('final-kps').textContent       = kpm;

  // 自己ベスト表示
  document.getElementById('best-score').textContent = best.score;
  document.getElementById('best-combo').textContent = best.combo;
  document.getElementById('best-rank').textContent  = getRankLabel(best.rank);
  document.getElementById('best-kps').textContent   = best.kpm.toFixed(1);

  document.getElementById('gameover').style.display = 'flex';
}

/* ----------------------------------------------------------
   ゲーム初期化
   ---------------------------------------------------------- */
function initState() {
  // 地雷クリア
  for (const key of Object.keys(mines)) {
    const m = mines[key];
    if (m.gfx)       { mineLayer.removeChild(m.gfx);      m.gfx.destroy(); }
    if (m.timerText) { floatLayer.removeChild(m.timerText); m.timerText.destroy(); }
  }
  mines = {};

  // 敵クリア
  for (const e of enemies) { enemyLayer.removeChild(e.gfx); e.gfx.destroy(); }
  enemies = [];

  // パーティクルクリア
  particleGfx.clear();
  particles = [];

  // フロートテキストクリア
  for (const t of floatTexts) { floatLayer.removeChild(t); t.destroy(); }
  floatTexts = [];

  // スコア・タイマーリセット
  score = 0; comboCount = 0; maxCombo = 0; wave = 1;
  waveTimer = 0; spawnTimer = 0;
  shakeIntensity = 0;
  finalStageMode = false; finalStageTimer = 0;
  rankIndex = 0; rankTimer = 0; rankKillCount = 0; rankFlashTimer = 0;
  totalKills = 0; playTimeSec = 0;
  const rankEl = document.getElementById('rank-display');
  if (rankEl) rankEl.classList.remove('rank-up', 'rank-down');

  for (const k in holdStart) delete holdStart[k];

  // 画面下のキーインジケーターを全てリセット
  for (const key of TRACK_KEYS) {
    const el = document.getElementById('ki-' + key);
    if (el) el.className = 'ki';
  }

  for (let i = 0; i < MAX_STAGE; i++) {
    const dot = document.getElementById('evo' + i);
    if (dot) dot.className = 'evo-dot';
  }

  // プレイ開始時のウィンドウサイズを固定（プレイ中のリサイズは無視）
  gameW    = window.innerWidth;
  gameH    = window.innerHeight;
  blastMax = Math.min(gameW, gameH) / 4;

  updateUI();
  document.getElementById('wave').textContent = '1';
  document.getElementById('msg').textContent  = '';

  drawBackground();
}

/* ゲームが実際に始まる直前に AudioContext をアンロックし、
   その後カウントダウンを開始する */
let _waitingForInteraction = false;

function _beginCountdown() {
  // AudioContext が suspended なら resume してからスタート
  const doStart = () => {
    countdownPhase = true;
    countdownVal   = 3;
    countdownTimer = 0;
    gameRunning    = false;
    showCountdown(3);
    seCountdownTick();
  };

  if (_ac.state === 'suspended') {
    _ac.resume().then(doStart);
  } else {
    doStart();
  }
}

function startGame() {
  document.getElementById('gameover').style.display = 'none';
  initState();

  // カウントダウン前に「キーを押して開始」画面を出し、
  // 最初のユーザー操作で AudioContext をアンロックする
  _waitingForInteraction = true;
  const overlay = document.getElementById('countdown-overlay');
  overlay.classList.add('active');
  const numEl = document.getElementById('countdown-num');
  numEl.classList.add('small');
  numEl.textContent = 'PRESS\nANY KEY';
}

window.restartGame = startGame;

/* ----------------------------------------------------------
   キーボードイベント
   ---------------------------------------------------------- */
window.addEventListener('keydown', e => {
  // 「PRESS ANY KEY」待ち状態: 最初のキー入力で AudioContext をアンロックしカウントダウン開始
  if (_waitingForInteraction) {
    _waitingForInteraction = false;
    _beginCountdown();
    return;
  }

  if (!gameRunning) return;
  const key = e.key.toUpperCase();
  if (!TRACK_KEYS.includes(key) || e.repeat) return;

  if (mines[key]) {
    const m = mines[key];
    if (m.dud) {
      m.shakeTimer = 0.35;  // 0.35秒間シェイク
      seDudPress();
      showMsg(`[${key}] 不発弾 — 誘爆のみ有効`);
    } else if (m.ready) {
      detonateMine(key);
    } else {
      showMsg(`[${key}] 起爆まであと少し…`);
    }
    return;
  }

  // チャージ開始
  holdStart[key] = performance.now() / 1000;
  const el = document.getElementById('ki-' + key);
  if (el) el.className = 'ki active';
});

window.addEventListener('keyup', e => {
  if (!gameRunning) return;
  const key = e.key.toUpperCase();
  if (!TRACK_KEYS.includes(key) || !(key in holdStart)) return;

  const now     = performance.now() / 1000;
  const held    = (now - holdStart[key]) * 1000;
  const isDud   = held > CHARGE_FULL_MS;
  const clamped = Math.min(held, CHARGE_FULL_MS);
  const br      = BLAST_MIN + (clamped / CHARGE_FULL_MS) * (blastMax - BLAST_MIN);

  delete holdStart[key];
  if (mines[key]) return;

  placeMine(key, mouseX, mouseY, br, isDud);
});

/* ----------------------------------------------------------
   マウス座標追跡
   ---------------------------------------------------------- */
window.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });

/* ----------------------------------------------------------
   キーマップ UI の生成
   ---------------------------------------------------------- */
(function buildKeymap() {
  const km = document.getElementById('keymap');
  for (const key of TRACK_KEYS) {
    const div = document.createElement('div');
    div.className = 'ki';
    div.id = 'ki-' + key;
    div.textContent = key;
    km.appendChild(div);
  }
})();

/* ----------------------------------------------------------
   ゲームスタート
   ---------------------------------------------------------- */
startGame();

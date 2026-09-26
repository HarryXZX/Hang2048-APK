'use strict';

/* ==========================================================================
   夯048 · Hang2048 —— 游戏逻辑与渲染（响应式 / 手机适配版）
   ========================================================================== */

/* ---------------- 配置 ---------------- */
const SIZE = 4;        // 4×4 网格
const MAX_LEVEL = 4;   // 最高等级「夯」

// 布局：这些值不再写死，由 layout() 按屏幕尺寸算好后写入 CSS 变量，
// 同时同步到下面的 L 对象，供 JS 计算棋子坐标使用。
const L = {
  cell: 110,   // 格子边长 px
  gap: 12,     // 格子间距 px
  board: 500,  // 棋盘边长 px = SIZE*cell + (SIZE+1)*gap
  font: 16     // 字号基准 px
};

// 设计基准：桌面版 550×600 窗口、500px 棋盘、110px 格子、12px 间距
const BASE_CELL = 110;
const BASE_GAP = 12;
const BASE_FONT = 16;
// 棋盘外还需要留给顶部信息栏、内边距的最小高度（按基准比例估算）
const CHROME_RATIO = 0.2;   // 顶部栏 + 内边距约占棋盘高度的比例
const MIN_CELL = 44;        // 格子最小边长，低于此值布局会太挤
const MAX_CELL = 150;       // 格子最大边长，避免大屏上过分拉伸

// 合成链：等级 -> 名称
const NAMES = ['拉完了', 'NPC', '人上人', '顶级', '夯'];

// 每个等级的外观（字号在 layout() 里按格子尺寸换算，这里只存比例）
const STYLES = [
  { bg: '#eee4da', color: '#776e65', fs: 0.255 },  // 拉完了
  { bg: '#ede0c8', color: '#776e65', fs: 0.291 },  // NPC
  { bg: '#f2b179', color: '#f9f6f2', fs: 0.255 },  // 人上人
  { bg: '#f59563', color: '#f9f6f2', fs: 0.273 },  // 顶级
  { bg: '#edc22e', color: '#f9f6f2', fs: 0.327 }   // 夯
];

const SPAWN_LEVEL0_RATE = 0.9;  // 新块 90% 是「拉完了」，10% 是「NPC」
const MERGE_SCORE = 10;         // 每次合并得分
const GOAL_SCORE = 100;         // 合成「夯」额外得分
const DRAG_THRESHOLD_MIN = 24;  // 拖拽阈值下限 px
const DRAG_THRESHOLD_RATIO = 0.22; // 拖拽阈值 = 格子边长 × 该比例

const DELAY_MERGE = 130;        // 滑动结束 -> 播放合并动画
const DELAY_SPAWN = 260;        // 滑动结束 -> 生成新块 / 判定胜负

// 当前拖拽阈值（随格子尺寸变化）
let dragThreshold = 30;

/* ---------------- DOM ---------------- */
const appEl = document.getElementById('app');
const boardEl = document.getElementById('board');
const gridEl = document.getElementById('grid');
const tilesEl = document.getElementById('tiles');
const scoreEl = document.getElementById('score');
const timerEl = document.getElementById('timer');
const overlayEl = document.getElementById('overlay');
const toastEl = document.getElementById('toast');
const overMsgEl = document.getElementById('overMsg');
const overSubEl = document.getElementById('overSub');
const overTimeEl = document.getElementById('overTime');
const againBtnEl = document.getElementById('againBtn');
const resetBtnEl = document.getElementById('resetBtn');
const closeBtnEl = document.getElementById('closeBtn');
const headerEl = document.querySelector('.header');

/* ---------------- 环境探测 ---------------- */
// 触屏设备：隐藏自绘关闭按钮，改由系统返回键退出
const IS_TOUCH = (() => {
  if (window.desktop) return false;                 // Electron 预览壳 = 桌面
  if (navigator.maxTouchPoints > 0) return true;
  return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
})();

// Android WebView 注入的桥（由 MainActivity 提供；纯浏览器下为 undefined）
const ANDROID = window.AndroidBridge || null;

/* ---------------- 状态 ---------------- */
let board = [];          // board[r][c] = { level, id, row, col } | null
let score = 0;           // 本局得分
let tileId = 0;          // 递增的棋子 id
let gameOver = false;    // 本局是否已结束
let won = false;         // 是否已合成「夯」
let toastTimer = null;
let startTime = 0;       // 第一次有效操作的时间戳；0 = 计时器待命
let timerInterval = null;
let dragStart = null;

const pos = (n) => L.gap + n * (L.cell + L.gap);

/* ==========================================================================
   计时器
   ========================================================================== */

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
}

/** 开局/重置：进入「待命」状态（显示 00:00，但不计时） */
function armTimer() {
  stopTimer();
  startTime = 0;
  timerEl.textContent = '00:00';
}

/** 第一次有效操作才真正开始计时；重复调用不会重置起点 */
function startTimer() {
  if (timerInterval) return;
  startTime = Date.now();
  timerInterval = setInterval(() => {
    timerEl.textContent = fmtTime(Date.now() - startTime);
  }, 200);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function getElapsed() {
  return startTime ? Date.now() - startTime : 0;
}

/* ==========================================================================
   渲染
   ========================================================================== */

/** 静态网格背景，只需建一次 */
/** 重建静态网格背景（布局变化时需先清空再重建） */
function buildGrid() {
  gridEl.textContent = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.left = pos(c) + 'px';
      cell.style.top = pos(r) + 'px';
      gridEl.appendChild(cell);
    }
  }
}

function tileElement(t) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = t.id;
  el.style.width = L.cell + 'px';
  el.style.height = L.cell + 'px';
  el.style.left = pos(t.col) + 'px';
  el.style.top = pos(t.row) + 'px';
  applyStyle(el, t.level);
  return el;
}

function applyStyle(el, level) {
  const s = STYLES[level];
  el.style.background = s.bg;
  el.style.color = s.color;
  // 字号按格子边长等比换算，保证不同屏幕上文字与格子的比例一致
  el.style.fontSize = (L.cell * s.fs).toFixed(1) + 'px';
  el.textContent = NAMES[level];
}

/** 无动画全量重建 */
function render() {
  tilesEl.innerHTML = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c]) tilesEl.appendChild(tileElement(board[r][c]));
    }
  }
}

/**
 * 带滑动动画的渲染：先按旧坐标画，强制回流后再切到新坐标，
 * 由 CSS transition(left/top 120ms) 产生滑动效果。
 */
function renderWithMove(oldBoard) {
  tilesEl.innerHTML = '';

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = board[r][c];
      if (!t) continue;
      const el = tileElement(t);
      const from = oldBoard[r][c];
      el.style.left = pos(from ? from.col : t.col) + 'px';
      el.style.top = pos(from ? from.row : t.row) + 'px';
      tilesEl.appendChild(el);
    }
  }

  void tilesEl.offsetHeight; // 强制回流：确保旧坐标已生效

  for (let i = 0; i < tilesEl.children.length; i++) {
    const el = tilesEl.children[i];
    const t = findTileById(parseInt(el.dataset.id, 10));
    if (!t) continue;
    el.style.left = pos(t.col) + 'px';
    el.style.top = pos(t.row) + 'px';
  }
}

function findTileById(id) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = board[r][c];
      if (t && t.id === id) return t;
    }
  }
  return null;
}

/* ==========================================================================
   移动与合并
   ========================================================================== */

/**
 * 方向移动。dir ∈ 'up' | 'down' | 'left' | 'right'
 * 返回是否有效操作（用于测试；动画与生成走 setTimeout）
 */
function move(dir) {
  if (gameOver) return false;

  // 旧状态快照：滑动动画起点 + 「是否有效操作」判定
  const oldBoard = board.map((row) =>
    row.map((t) => (t ? { level: t.level, id: t.id, row: t.row, col: t.col } : null))
  );
  const mergedNow = []; // 本次合并后保留的棋子 id
  let moved = false;

  for (let i = 0; i < SIZE; i++) {
    // 取出一条线（自移动方向起算）上的非空棋子
    const line = [];
    for (let j = 0; j < SIZE; j++) {
      const t = dir === 'up' ? board[j][i]
        : dir === 'down' ? board[SIZE - 1 - j][i]
          : dir === 'left' ? board[i][j]
            : board[i][SIZE - 1 - j];
      if (t) line.push(t);
    }

    // 相邻且同等级才合并；每块每回合只参与一次；「夯」不再合并
    const merged = [];
    for (let k = 0; k < line.length; k++) {
      const cur = line[k];
      const nxt = line[k + 1];
      if (nxt && cur.level === nxt.level && cur.level < MAX_LEVEL) {
        const newLevel = cur.level + 1;
        score += MERGE_SCORE;
        vibrate('merge');   // 每发生一次合并给一次轻震动
        if (newLevel === MAX_LEVEL) {
          score += GOAL_SCORE;
          won = true;
          showToast('🏆 合成【夯】！+100');
        }
        nxt.level = newLevel; // 保留靠移动方向的那块，当前块被吃掉
        merged.push(nxt);
        mergedNow.push(nxt.id);
        k++;                  // 跳过被吃掉的块，避免连锁合并
      } else {
        merged.push(cur);
      }
    }
    if (merged.length !== line.length) moved = true;

    // 写回棋盘
    for (let m = 0; m < SIZE; m++) {
      const r = dir === 'up' ? m : dir === 'down' ? SIZE - 1 - m : i;
      const c = dir === 'left' ? m : dir === 'right' ? SIZE - 1 - m : i;
      const t = merged[m] || null;
      if (t) {
        if (t.row !== r || t.col !== c) moved = true;
        t.row = r;
        t.col = c;
      }
      board[r][c] = t;
    }
  }

  if (!moved) return false; // 无效操作：不生成新块、不计分、也不启动计时

  startTimer();             // 第一次有效操作才开始计时
  renderWithMove(oldBoard);

  // ① 滑动结束 → 合并动画
  setTimeout(() => {
    for (let i = 0; i < tilesEl.children.length; i++) {
      const el = tilesEl.children[i];
      const id = parseInt(el.dataset.id, 10);
      if (mergedNow.indexOf(id) === -1) continue;
      const t = findTileById(id);
      if (!t) continue;
      el.classList.add('merged');
      applyStyle(el, t.level);
    }
  }, DELAY_MERGE);

  // ② 动画播完 → 生成新块 / 判定胜负
  setTimeout(() => {
    if (won) {
      gameOver = true;
      updateScore();
      vibrate('win');
      showOverlay('🏆 合成【夯】！', '恭喜通关，达成最高等级', '再来一局');
      return; // 获胜后不再生成新块
    }
    spawnTile();
    updateScore();
    if (isBoardFull()) {
      gameOver = true;
      vibrate('lose');
      showOverlay('游戏失败', '棋盘已填满', '再来一局');
    }
  }, DELAY_SPAWN);

  return true;
}

/** 在随机空位生成新块 */
function spawnTile() {
  const empty = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return null;

  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const level = Math.random() < SPAWN_LEVEL0_RATE ? 0 : 1;
  const t = { id: ++tileId, level, row: r, col: c };
  board[r][c] = t;

  const el = tileElement(t);
  el.classList.add('appear');
  tilesEl.appendChild(el);
  return t;
}

function isBoardFull() {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) return false;
    }
  }
  return true;
}

/* ==========================================================================
   界面
   ========================================================================== */

function updateScore() {
  scoreEl.textContent = score;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

function showOverlay(msg, sub, btn) {
  stopTimer();
  overMsgEl.textContent = msg;
  overSubEl.textContent = sub;
  againBtnEl.textContent = btn;
  overTimeEl.textContent = '⏱ 用时 ' + fmtTime(getElapsed());
  overlayEl.classList.add('show');
}

function hideOverlay() {
  overlayEl.classList.remove('show');
}

/* ==========================================================================
   开局 / 重置
   ========================================================================== */

function reset() {
  board = [];
  for (let r = 0; r < SIZE; r++) {
    board.push(new Array(SIZE).fill(null));
  }
  score = 0;
  gameOver = false;
  won = false;
  dragStart = null;
  hideOverlay();
  updateScore();
  render();
  armTimer();   // 待命：等第一次有效操作才计时
  spawnTile();
  spawnTile();
}

/* ==========================================================================
   输入
   ========================================================================== */

const KEY_MAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
};

document.addEventListener('keydown', (e) => {
  const dir = KEY_MAP[e.key];
  if (dir) {
    e.preventDefault();
    move(dir);
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    reset();
  }
});

/* ---------------- 输入：拖拽 / 滑动 ----------------
   同一套 pointer 事件同时服务桌面鼠标拖拽与手机触摸滑动：
   · 手机上是「滑动」，手指抬起才算一次完整手势
   · 桌面上保留原有的「连续拖拽」（不抬手也能连续滑动）
*/
let activePointerId = null;

boardEl.addEventListener('pointerdown', (e) => {
  // 多指同时按下时只跟踪第一根手指，避免手势互相干扰
  if (activePointerId !== null) return;
  activePointerId = e.pointerId;
  dragStart = { x: e.clientX, y: e.clientY };
  // 触摸时捕获该指针，离开棋盘区域也能继续收到 move/up
  if (IS_TOUCH && boardEl.setPointerCapture) {
    try { boardEl.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  }
});

boardEl.addEventListener('pointermove', (e) => {
  if (!dragStart || e.pointerId !== activePointerId) return;

  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.abs(dx) < dragThreshold && Math.abs(dy) < dragThreshold) return;

  const dir = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up');
  move(dir);

  if (IS_TOUCH) {
    // 手机端：一次滑动只触发一次，等手指抬起再重置
    dragStart = { x: e.clientX, y: e.clientY };
  } else {
    // 桌面端：不抬手也能连续拖拽
    dragStart = { x: e.clientX, y: e.clientY };
  }
});

function endDrag(e) {
  if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
  activePointerId = null;
  dragStart = null;
}

boardEl.addEventListener('pointerup', endDrag);
boardEl.addEventListener('pointercancel', endDrag);
boardEl.addEventListener('pointerleave', (e) => {
  // 触摸已被 pointer capture 接管，leave 不应中断手势
  if (IS_TOUCH) return;
  endDrag(e);
});

// 触屏下彻底压掉浏览器默认的滚动/缩放/长按菜单，避免抢走手势
boardEl.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) e.preventDefault(); // 双指缩放
}, { passive: false });
boardEl.addEventListener('touchmove', (e) => {
  e.preventDefault(); // 阻止页面滚动与下拉刷新
}, { passive: false });

document.addEventListener('contextmenu', (e) => e.preventDefault());
// 双击缩放
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
// iOS 双击放大
document.addEventListener('gesturestart', (e) => e.preventDefault());

resetBtnEl.addEventListener('click', reset);
againBtnEl.addEventListener('click', reset);

closeBtnEl.addEventListener('click', () => {
  if (window.desktop && typeof window.desktop.closeWindow === 'function') {
    window.desktop.closeWindow();
  } else {
    window.close();
  }
});

/* ---------------- Android 返回键 ----------------
   系统返回键由 MainActivity 捕获后调用 window.__h2048.onBackKey()。
   返回 true 表示「已处理，不要退出应用」，false 表示「交给系统退出」。
   策略：结算面板打开时先关面板；否则提示再按一次退出。
*/
let backKeyArmed = false;
let backKeyTimer = null;

function onBackKey() {
  if (overlayEl.classList.contains('show')) {
    hideOverlay();
    return true;
  }
  if (!backKeyArmed) {
    backKeyArmed = true;
    showToast('再按一次返回键退出');
    if (backKeyTimer) clearTimeout(backKeyTimer);
    backKeyTimer = setTimeout(() => {
      backKeyArmed = false;
      backKeyTimer = null;
    }, 2000);
    return true;
  }
  return false;
}

/* ==========================================================================
   布局：按屏幕尺寸计算棋盘与格子的实际像素
   --------------------------------------------------------------------------
   思路：
     1. 棋盘是正方形，取「可用宽」与「可用高（扣掉顶部信息栏）」的较小值
     2. 由棋盘边长反推格子边长：board = SIZE*cell + (SIZE+1)*gap，
        而 gap 与 cell 保持固定比例（基准 12/110），故
        cell = board / (SIZE + (SIZE+1)*gapRatio)
     3. 结果写入 CSS 变量，同时同步到 L 供坐标计算使用
   ========================================================================== */

function readSafeArea() {
  // env() 只有在支持安全区的浏览器里才能读到；读不到就退回 0
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'padding-top:env(safe-area-inset-top,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);' +
    'padding-right:env(safe-area-inset-right,0px);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const v = {
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
    right: parseFloat(cs.paddingRight) || 0
  };
  probe.remove();
  return v;
}

function setVar(name, value) {
  document.documentElement.style.setProperty(name, value);
}

function layout() {
  const safe = readSafeArea();

  // 可用空间：视口尺寸扣掉安全区
  const availW = window.innerWidth - safe.left - safe.right;
  const availH = window.innerHeight - safe.top - safe.bottom;

  const sidePad = 24;   // 左右内边距合计（CSS --pad-side: 12px × 2）

  // ---- 垂直方向：先量出顶部栏的实际高度，而不是靠经验估算 ----
  // 此时 CSS 变量尚未更新，量到的可能是上一轮的值，
  // 但顶部栏高度只与字号有关，先用当前值量一次再算，误差可忽略。
  const headerH = headerEl ? headerEl.getBoundingClientRect().height : 56;
  const padTop = 10;
  const padBottom = 10;
  const vertChrome = headerH + padTop + padBottom + 8; // 8 = 顶部栏与棋盘之间的间隙余量

  const boardByH = availH - vertChrome;
  const boardByW = availW - sidePad;

  // 取两者较小值，保证棋盘完整可见
  let board = Math.min(boardByW, boardByH);

  // 由棋盘反推格子（保持基准的 gap/cell 比例）
  const gapRatio = BASE_GAP / BASE_CELL;
  let cell = board / (SIZE + (SIZE + 1) * gapRatio);

  // 夹在合理区间内，并据此回算最终棋盘与间距
  cell = Math.max(MIN_CELL, Math.min(MAX_CELL, cell));
  const gap = cell * gapRatio;
  board = SIZE * cell + (SIZE + 1) * gap;

  // 字号基准随格子缩放（基准：110px 格子 -> 16px 字号）
  const font = Math.max(11, Math.min(22, cell * (BASE_FONT / BASE_CELL)));
  dragThreshold = Math.max(DRAG_THRESHOLD_MIN, cell * DRAG_THRESHOLD_RATIO);

  // 同步到 JS 侧
  L.cell = cell;
  L.gap = gap;
  L.board = board;
  L.font = font;

  // 写入 CSS 变量
  setVar('--app-w', Math.round(availW) + 'px');
  setVar('--app-h', Math.round(availH) + 'px');
  setVar('--board', board.toFixed(2) + 'px');
  setVar('--cell', cell.toFixed(2) + 'px');
  setVar('--gap', gap.toFixed(2) + 'px');
  // 圆角随尺寸缩放，保持视觉比例
  setVar('--tile-radius', (cell * 0.09).toFixed(2) + 'px');
  setVar('--board-radius', (cell * 0.11).toFixed(2) + 'px');
  setVar('--font-base', font.toFixed(2) + 'px');
  setVar('--safe-top', safe.top + 'px');
  setVar('--safe-bottom', safe.bottom + 'px');
  setVar('--safe-left', safe.left + 'px');
  setVar('--safe-right', safe.right + 'px');

  return { board, cell, gap, font };
}

/** 布局变化后重建网格与棋子（尺寸变了，DOM 上的内联坐标也要重算） */
function relayout() {
  // 顶部栏高度依赖字号，而字号又由棋盘推导 —— 迭代两次让两者收敛，
  // 避免出现「棋盘略微超出屏幕底部」的一像素级误差。
  layout();
  layout();
  buildGrid();
  render();
}

/* ==========================================================================
   窗口尺寸自适应（Electron 预览壳用；手机端不需要）
   ========================================================================== */

function syncWindowSize() {
  if (!window.desktop || typeof window.desktop.resize !== 'function') return;
  const r = appEl.getBoundingClientRect();
  window.desktop.resize(Math.ceil(r.width), Math.ceil(r.height));
}

/* ==========================================================================
   震动反馈（Android；无桥时静默降级）
   ========================================================================== */

function vibrate(kind) {
  // 优先走原生桥（WebView 里 navigator.vibrate 不一定可用）
  if (ANDROID && typeof ANDROID.vibrate === 'function') {
    try {
      ANDROID.vibrate(kind);
      return;
    } catch (_) { /* 落到下面的兜底 */ }
  }
  if (navigator.vibrate) {
    if (kind === 'win') navigator.vibrate([0, 40, 60, 40, 60, 120]);
    else if (kind === 'lose') navigator.vibrate([0, 120, 80, 200]);
    else navigator.vibrate(12);
  }
}

/* ==========================================================================
   启动
   ========================================================================== */

function init() {
  // 触屏设备标记：CSS 据此隐藏自绘关闭按钮
  if (IS_TOUCH) document.body.classList.add('is-touch');

  layout();
  buildGrid();
  reset();
  syncWindowSize();

  // 屏幕旋转 / 尺寸变化时重新布局
  let resizeTimer = null;
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      relayout();
      syncWindowSize();
    }, 120);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
}

init();

/* ==========================================================================
   自动化测试钩子
   ========================================================================== */

window.__h2048 = {
  size: SIZE,
  maxLevel: MAX_LEVEL,
  names: NAMES.slice(),
  styles: STYLES.map((s) => ({ bg: s.bg, color: s.color, fs: s.fs })),

  newGame: reset,
  move,
  spawnTile,
  layout,
  relayout,
  vibrate,
  onBackKey,
  getMetrics: () => ({
    isTouch: IS_TOUCH,
    hasAndroidBridge: !!ANDROID,
    cell: L.cell,
    gap: L.gap,
    board: L.board,
    font: L.font,
    dragThreshold,
    innerW: window.innerWidth,
    innerH: window.innerHeight
  }),

  /** 直接摆一个盘面（null 表示空位），用于确定性测试 */
  loadGrid(grid) {
    board = [];
    for (let r = 0; r < SIZE; r++) {
      board.push([]);
      for (let c = 0; c < SIZE; c++) {
        const lv = grid && grid[r] ? grid[r][c] : null;
        board[r].push(lv === null || lv === undefined
          ? null
          : { id: ++tileId, level: lv, row: r, col: c });
      }
    }
    score = 0;
    gameOver = false;
    won = false;
    dragStart = null;
    hideOverlay();
    updateScore();
    render();
    armTimer();
  },

  snapshot() {
    const grid = [];
    const ids = [];
    for (let r = 0; r < SIZE; r++) {
      grid.push([]);
      ids.push([]);
      for (let c = 0; c < SIZE; c++) {
        const t = board[r][c];
        grid[r].push(t ? t.level : null);
        ids[r].push(t ? t.id : null);
      }
    }
    return {
      grid,
      ids,
      score,
      scoreText: scoreEl.textContent,
      gameOver,
      won,
      timerStarted: !!startTime,
      timerText: timerEl.textContent,
      elapsed: getElapsed(),
      overlay: overlayEl.classList.contains('show'),
      overlayMsg: overMsgEl.textContent,
      overlaySub: overSubEl.textContent,
      overlayTime: overTimeEl.textContent,
      tileCount: tilesEl.children.length,
      dragging: !!dragStart
    };
  }
};

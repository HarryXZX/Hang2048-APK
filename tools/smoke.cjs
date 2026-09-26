'use strict';

/**
 * 冒烟测试：逻辑断言 + 界面截图。
 *   npm run smoke
 * 截图输出到 captures/，断言结果打印到控制台。
 *
 * 关键手法：测试里把 Math.random 固定为 0，
 * 这样「合并后新块落点 / 等级」完全可预测，断言可以写死。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'captures');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
}

let win = null;

/**
 * 与 main.js 保持一致的窗口尺寸处理。
 * 无边框窗口在非整数缩放下 setContentSize(N) 可能得到 N+1，需要反向补偿一次。
 */
function applyContentSize(w, h) {
  win.setContentSize(w, h);
  const [aw, ah] = win.getContentSize();
  const dw = aw - w;
  const dh = ah - h;
  if (dw || dh) win.setContentSize(w - dw, h - dh);
}

ipcMain.on('resize-window', (_e, w, h) => {
  if (!win || win.isDestroyed()) return;
  applyContentSize(Math.max(120, Math.round(w)), Math.max(120, Math.round(h)));
});

const EMPTY_ROW = [null, null, null, null];
const blank = () => [EMPTY_ROW.slice(), EMPTY_ROW.slice(), EMPTY_ROW.slice(), EMPTY_ROW.slice()];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#faf8ef',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = ev && typeof ev === 'object' && 'level' in ev ? ev.level : args[1];
    const message = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[2];
    if (level === 'error' || level === 3) errors.push(String(message));
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(400);

  // 必须让窗口真正上屏：隐藏窗口的 capturePage 会漏掉合成层，
  // 而 .tile 带 transition + z-index，会被提升为独立合成层，
  // 结果就是断言全对、截图里却看不到棋子。
  win.showInactive();
  await sleep(700);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  const setup = (grid) => js(`window.__h2048.loadGrid(${JSON.stringify(grid)})`);
  const snap = () => js(`window.__h2048.snapshot()`);
  // 注意：这里的表达式必须返回可克隆的值 —— 直接写 `Math.random = fn`
  // 会让 executeJavaScript 试图回传一个函数，报 "An object could not be cloned"
  const freezeRandom = () => js(
    `(function () { window.__rand0 = Math.random; Math.random = function () { return 0; }; return true; })()`);
  const unfreezeRandom = () => js(
    `(function () { Math.random = window.__rand0; return true; })()`);

  async function moveAndSettle(dir) {
    const moved = await js(`window.__h2048.move(${JSON.stringify(dir)})`);
    await sleep(430);
    return moved;
  }

  /**
   * 排空挂起的异步回调。
   * move() 内部有两个 setTimeout（DELAY_MERGE=130 / DELAY_SPAWN=260）负责
   * 补块与判负；如果用例在这些回调落地前就切到下一个盘面，回调会作用在
   * 新盘面上，造成跨用例污染。动画驱动类用例结束后必须调用它。
   */
  async function drain() {
    await sleep(450);
  }

  async function shot(name) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    const size = img.getSize();
    console.log('shot  ' + name + '.png  ' + size.width + 'x' + size.height);
  }

  const row0 = (g) => JSON.stringify(g[0]);

  /* ---------- 0. 响应式布局（APK 版铺满视口，不再固定 550×600） ---------- */
  await sleep(300);
  const m0 = await js(`(() => {
    const ms = window.__h2048.getMetrics();
    const app = document.getElementById('app').getBoundingClientRect();
    return { metrics: ms, appW: app.width, appH: app.height,
             innerW: window.innerWidth, innerH: window.innerHeight };
  })()`);
  check('应用铺满视口', Math.abs(m0.appW - m0.innerW) < 2 && Math.abs(m0.appH - m0.innerH) < 2,
    `app=${m0.appW.toFixed(0)}x${m0.appH.toFixed(0)} inner=${m0.innerW}x${m0.innerH}`);
  check('棋盘尺寸由布局算出（非写死 500）', m0.metrics.board !== 500 && m0.metrics.board > 100,
    `board=${m0.metrics.board.toFixed(1)} cell=${m0.metrics.cell.toFixed(1)}`);
  check('拖拽阈值随格子尺寸缩放',
    m0.metrics.dragThreshold >= 24 && m0.metrics.dragThreshold <= 40,
    `threshold=${m0.metrics.dragThreshold.toFixed(1)}`);

  /* ---------- 1. 初始局面 ---------- */
  await js(`window.__h2048.newGame()`);
  await sleep(60);
  let s = await snap();
  const filled = s.grid.flat().filter((v) => v !== null).length;
  check('开局生成 2 个初始块', filled === 2, JSON.stringify(s.grid));
  check('初始块只会是「拉完了」或「NPC」',
    s.grid.flat().every((v) => v === null || v === 0 || v === 1));
  check('开局计时器处于待命 (00:00)', s.timerStarted === false && s.timerText === '00:00', s.timerText);
  check('开局得分 0、无结束面板', s.score === 0 && s.overlay === false);
  check('开局 DOM 上正好 2 个棋子', s.tileCount === 2, 'tiles=' + s.tileCount);

  /* ---------- 2. 合成链常量 ---------- */
  const cfg = await js(`({
    size: window.__h2048.size,
    maxLevel: window.__h2048.maxLevel,
    names: window.__h2048.names,
    styles: window.__h2048.styles
  })`);
  check('4×4 网格、最高等级 4', cfg.size === 4 && cfg.maxLevel === 4);
  check('合成链 5 级且首尾正确',
    cfg.names.length === 5 && cfg.names[0] === '拉完了' && cfg.names[4] === '夯',
    cfg.names.join(' → '));
  check('每级都配了背景/前景/字号',
    cfg.styles.length === 5 && cfg.styles.every((x) => x.bg && x.color && x.fs));

  /* ---------- 3. 基本合并 ---------- */
  await setup([[0, 0, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  let moved = await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('[0,0] 左移合并成 [1]', s.grid[0][0] === 1, row0(s.grid));
  check('合并一次 +10 分', s.score === 10, 'score=' + s.score);
  check('有效操作 move() 返回 true', moved === true);
  check('合并后补了 1 个新块', s.tileCount === 2, 'tiles=' + s.tileCount);

  /* ---------- 4. 不同等级不合并 = 无效操作 ---------- */
  await setup([[0, 1, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  moved = await moveAndSettle('left');
  s = await snap();
  check('相邻但等级不同 → 不合并', s.grid[0][0] === 0 && s.grid[0][1] === 1, row0(s.grid));
  check('贴边同行不合并属无效操作 (返回 false)', moved === false);
  check('无效操作不生成新块', s.tileCount === 2, 'tiles=' + s.tileCount);
  check('无效操作不启动计时器', s.timerStarted === false);
  check('无效操作不加分', s.score === 0);

  /* ---------- 5. 每块每回合只合并一次 ---------- */
  await setup([[0, 0, 0, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('三连相同只合一次 → [1,0]（不连锁成 2）',
    s.grid[0][0] === 1 && s.grid[0][1] === 0, row0(s.grid));
  check('三连只计一次分 (+10)', s.score === 10, 'score=' + s.score);

  await setup([[0, 0, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('四连相同合并成两对 → [1,1]',
    s.grid[0][0] === 1 && s.grid[0][1] === 1, row0(s.grid));
  check('四连计两次分 (+20)', s.score === 20, 'score=' + s.score);

  /* ---------- 6. 「夯」不再合并 ---------- */
  await setup([[4, 4, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  moved = await moveAndSettle('left');
  s = await snap();
  check('两个「夯」相邻也不会合并',
    s.grid[0][0] === 4 && s.grid[0][1] === 4, row0(s.grid));
  check('「夯」相邻属无效操作、也没判胜', moved === false && s.won === false && s.gameOver === false);

  /* ---------- 7. 合成「夯」= 胜利 ---------- */
  await setup([[3, 3, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('合成「夯」判定胜利', s.won === true && s.gameOver === true, JSON.stringify({won: s.won, over: s.gameOver}));
  check('合出「夯」额外 +100（合计 110）', s.score === 110, 'score=' + s.score);
  check('得分显示已同步', s.scoreText === '110', s.scoreText);
  check('胜利面板弹出且文案含「夯」', s.overlay === true && s.overlayMsg.indexOf('夯') >= 0, s.overlayMsg);
  check('胜利后不再生成新块', s.tileCount === 1, 'tiles=' + s.tileCount);
  check('胜利面板显示用时', /用时 \d\d:\d\d/.test(s.overlayTime), s.overlayTime);

  await sleep(200);
  await shot('03-win');

  /* ---------- 8. 棋盘填满 = 失败 ---------- */
  const fullish = [
    [0, 0, 1, 2],
    [1, 2, 1, 2],
    [2, 3, 2, 3],
    [3, 1, 3, 0]
  ];
  await setup(fullish);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('棋盘填满判定失败', s.gameOver === true && s.won === false);
  check('失败面板文案正确', s.overlay === true && s.overlayMsg === '游戏失败', s.overlayMsg);

  // 上一局的「合成【夯】」toast 有 1.4s 生命期，等它消失再截图
  await sleep(1600);
  await shot('04-lose');

  /* ---------- 9. 「再来一局」按钮 ---------- */
  await js(`document.getElementById('againBtn').click()`);
  await sleep(80);
  s = await snap();
  check('「再来一局」重开：面板关闭、得分归零、2 个初始块',
    s.overlay === false && s.score === 0 && s.tileCount === 2,
    JSON.stringify({ overlay: s.overlay, score: s.score, tiles: s.tileCount }));

  /* ---------- 10. 计时器：第一次有效操作才启动 ---------- */
  await setup([[null, 0, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  s = await snap();
  check('操作前计时器仍未启动', s.timerStarted === false && s.timerText === '00:00');
  const t0 = Date.now();
  await js(`window.__h2048.move('left')`);
  s = await snap();
  check('第一次有效操作后计时器启动', s.timerStarted === true);

  // 计时器每 200ms 才刷新一次显示，固定 sleep 可能恰好读到刷新前的旧值。
  // 这里改为轮询，最多等 2.5s，一旦显示变化就通过。
  let timerText = '00:00';
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    await sleep(150);
    timerText = (await snap()).timerText;
    if (timerText !== '00:00') break;
  }
  check('计时器开始走字', timerText !== '00:00', 'timer=' + timerText);
  check('计时器格式为 MM:SS', /^\d{2}:\d{2}$/.test(timerText), timerText);

  /* ---------- 11. 新块生成概率 90% / 10% ---------- */
  const dist = await js(`(() => {
    const ms = window.__h2048;
    const empty = [[null,null,null,null],[null,null,null,null],[null,null,null,null],[null,null,null,null]];
    let zero = 0, one = 0;
    for (let i = 0; i < 600; i++) {
      ms.loadGrid(empty);
      const t = ms.spawnTile();
      if (t && t.level === 1) one++; else zero++;
    }
    return { zero, one };
  })()`);
  const rate = dist.zero / (dist.zero + dist.one);
  check('新块 90% 是「拉完了」/ 10% 是「NPC」',
    rate > 0.86 && rate < 0.94,
    'level0=' + (rate * 100).toFixed(1) + '%  ' + JSON.stringify(dist));

  /* ---------- 12. 键盘方向键 ---------- */
  await setup([[null, null, null, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  check('键盘 ← 触发左移', s.grid[0][0] === 2, row0(s.grid));

  /* ---------- 13. 鼠标拖拽 ---------- */
  const drag = async (fromX, toX) => js(`(() => {
    const board = document.getElementById('board');
    const r = board.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y) => board.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true
    }));
    fire('pointerdown', cx, cy);
    fire('pointermove', cx + ${fromX}, cy);
    fire('pointermove', cx + ${toX}, cy);
    fire('pointerup', cx + ${toX}, cy);
    return true;
  })()`);

  await setup([[null, null, null, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await drag(0, -20);                       // 只移动 20px，低于阈值
  await sleep(120);
  s = await snap();
  check('拖拽不足阈值不触发移动', s.grid[0][3] === 2 && s.grid[0][0] === null, row0(s.grid));

  await freezeRandom();
  await drag(0, -60);                       // 跨越阈值
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  check('拖拽超过阈值触发左移', s.grid[0][0] === 2, row0(s.grid));

  /* ---------- 13b. 四个方向的滑动 ---------- */
  const swipe = async (dx, dy) => js(`(() => {
    const board = document.getElementById('board');
    const r = board.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y) => board.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 7, isPrimary: true, pointerType: 'touch'
    }));
    fire('pointerdown', cx, cy);
    fire('pointermove', cx + ${dx}, cy + ${dy});
    fire('pointerup', cx + ${dx}, cy + ${dy});
    return true;
  })()`);

  // 竖直向下滑：块应从第 0 行落到第 3 行
  await setup([[2, null, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await swipe(0, 120);
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  check('向下滑动生效', s.grid[3][0] === 2, JSON.stringify(s.grid.map((r) => r[0])));
  await drain();

  // 竖直向上滑
  await setup([EMPTY_ROW, EMPTY_ROW, EMPTY_ROW, [2, null, null, null]]);
  await freezeRandom();
  await swipe(0, -120);
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  check('向上滑动生效', s.grid[0][0] === 2, JSON.stringify(s.grid.map((r) => r[0])));
  await drain();

  // 水平向右滑
  await setup([[2, null, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await swipe(120, 0);
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  check('向右滑动生效', s.grid[0][3] === 2, row0(s.grid));
  await drain();

  /* ---------- 13c. 触屏：多指与 pointercancel 不产生误操作 ---------- */
  // 场景：第一根手指右滑（应触发一次右移），第二根手指竖直乱动（应被忽略）。
  // 若多指处理有误，第二根手指会额外触发一次「上移」，导致盘面不符预期。
  await setup([[2, null, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await js(`(() => {
    const board = document.getElementById('board');
    const r = board.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y, id) => board.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: id, isPrimary: id === 1, pointerType: 'touch'
    }));
    fire('pointerdown', cx, cy, 1);          // 第一根手指按下
    fire('pointermove', cx + 120, cy, 1);    // 右滑 -> 触发右移
    fire('pointerdown', cx, cy + 40, 2);     // 第二根手指插入
    fire('pointermove', cx, cy - 200, 2);    // 第二根竖直上滑 -> 必须被忽略
    fire('pointerup', cx, cy - 200, 2);
    fire('pointerup', cx + 120, cy, 1);
    return true;
  })()`);
  await sleep(430);
  await unfreezeRandom();
  s = await snap();
  // 只有右移生效：2 应在最右列；若第二根手指也被处理，会出现上移的痕迹
  check('多指触摸只认第一根手指（第二根被忽略）',
    s.grid[0][3] === 2 && s.grid[3][3] !== 2 && s.grid[1][3] === null,
    JSON.stringify(s.grid.map((r) => r[3])));
  await drain();

  // pointercancel（如系统手势打断）应干净地结束拖拽状态
  await setup([[null, null, null, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]); // 贴右墙，任何移动都无效
  const cancelled = await js(`(() => {
    const board = document.getElementById('board');
    const r = board.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y, id) => board.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: id, isPrimary: true, pointerType: 'touch'
    }));
    fire('pointerdown', cx, cy, 3);
    fire('pointercancel', cx, cy, 3);
    const dragging = window.__h2048.snapshot().dragging;
    // 取消之后继续移动不应再触发任何操作
    const before = JSON.stringify(window.__h2048.snapshot().grid);
    fire('pointermove', cx - 200, cy, 3);
    return { dragging, before, after: JSON.stringify(window.__h2048.snapshot().grid) };
  })()`);
  check('pointercancel 后拖拽状态被清除', cancelled.dragging === false,
    'dragging=' + cancelled.dragging);
  check('pointercancel 后继续移动不触发操作', cancelled.before === cancelled.after,
    `${cancelled.before} -> ${cancelled.after}`);
  // 等所有挂起的 setTimeout（补块/判负）跑完，避免污染下一个用例
  await sleep(450);

  /* ---------- 13d. 返回键：面板打开时先关面板 ---------- */
  await setup([[3, 3, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('（前置）胜利面板已打开', s.overlay === true, s.overlayMsg);

  const back1 = await js(`window.__h2048.onBackKey()`);
  await sleep(80);
  s = await snap();
  check('返回键先关闭结算面板', back1 === true && s.overlay === false,
    `handled=${back1} overlay=${s.overlay}`);

  /* ---------- 13e. 返回键：连按两次才退出 ---------- */
  const back2 = await js(`window.__h2048.onBackKey()`);
  check('第一次返回键不退出（提示再按一次）', back2 === true, `handled=${back2}`);
  const toastShown = await js(`document.getElementById('toast').classList.contains('show')`);
  check('第一次返回键弹出提示', toastShown === true);
  const back3 = await js(`window.__h2048.onBackKey()`);
  check('第二次返回键交给系统退出', back3 === false, `handled=${back3}`);

  /* ---------- 13f. 震动接口在无桥环境下应安全降级 ---------- */
  const vib = await js(`(() => {
    try {
      window.__h2048.vibrate('merge');
      window.__h2048.vibrate('win');
      window.__h2048.vibrate('lose');
      return 'ok';
    } catch (e) { return 'throw: ' + e.message; }
  })()`);
  check('无 Android 桥时震动安全降级', vib === 'ok', vib);

  /* ---------- 14. 重置按钮 / F2 ---------- */
  await setup([[2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  s = await snap();
  check('全 2 盘面左移后确实得分', s.score > 0, 'score=' + s.score);

  await js(`document.getElementById('resetBtn').click()`);
  await sleep(80);
  s = await snap();
  check('「重置」按钮重开：得分归零 / 2 个初始块 / 计时器待命 / 面板关闭',
    s.score === 0 && s.tileCount === 2 && s.timerStarted === false && s.overlay === false,
    JSON.stringify({ score: s.score, tiles: s.tileCount }));

  await setup([[2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]]);
  await freezeRandom();
  await moveAndSettle('left');
  await unfreezeRandom();
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
  await sleep(80);
  s = await snap();
  check('F2 重开：得分归零 / 2 个初始块 / 计时器待命',
    s.score === 0 && s.tileCount === 2 && s.timerStarted === false,
    JSON.stringify({ score: s.score, tiles: s.tileCount }));

  /* ---------- 15. 截图：初始局 + 中局 ---------- */
  await js(`window.__h2048.newGame()`);
  await sleep(250);
  await shot('01-initial');

  await setup([
    [4, 3, 2, 1],
    [3, 2, 1, 0],
    [2, 1, 0, null],
    [1, 0, null, null]
  ]);
  await sleep(250);
  await shot('02-playing');

  /* ---------- 16. 无控制台错误 ---------- */
  check('渲染进程无错误日志', errors.length === 0, errors.join(' | '));

  console.log('');
  console.log(failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌');
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('SMOKE CRASH', err);
  app.exit(2);
});

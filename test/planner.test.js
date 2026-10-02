'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const EPaperPlanner = require('../js/planner-core.js');

const {
  transitionsForMasks,
  transitionsForGrid,
  solvePlan,
  bruteForcePlan,
  simulate,
  createSupervisor,
  buildWorkerSource
} = EPaperPlanner;

// ---------- 工具 ----------

// 简单确定性 PRNG
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 把瓦片掩码帧序列转为转移（每个翻转瓦片计 1 像素；可注入像素数）
function transitions(frames, pixelMap) {
  return transitionsForMasks(frames, (prev, cur, t) => (pixelMap ? pixelMap(prev, cur, t) : 1));
}

// ---------- DP vs 全枚举对拍 ----------

test('DP 与全量动作序列枚举一致（大量随机小例：掩码 1 像素/瓦片）', () => {
  const rng = mulberry32(20261001);
  let cases = 0;
  for (let iter = 0; iter < 600; iter++) {
    const rows = 1 + Math.floor(rng() * 2);          // 1..2
    const cols = 1 + Math.floor(rng() * 2);          // 1..2  → T = 1..4
    const T = rows * cols;
    const N = Math.floor(rng() * 8);                 // 0..7 帧
    const maxGhost = 1 + Math.floor(rng() * 2);      // 1..2
    const fullCost = 20 + Math.floor(rng() * 400);
    const partialBase = Math.floor(rng() * 60);

    const frames = [];
    let prev = new Array(T).fill(0);
    for (let i = 0; i < N; i++) {
      const cur = new Array(T);
      // 偏向产生变化：每瓦片以 0.5 概率翻转
      for (let t = 0; t < T; t++) cur[t] = rng() < 0.5 ? (prev[t] ? 0 : 1) : prev[t];
      frames.push(cur);
      prev = cur;
    }
    const opts = { rows, cols, width: cols * 2, height: rows * 2, maxGhost, fullCost, partialBase };
    const tr = transitions(frames);

    const dp = solvePlan(tr, opts);
    const bf = bruteForcePlan(tr, opts);
    cases++;

    assert.equal(dp.totalCost, bf.totalCost, `费用不一致 iter=${iter}`);
    assert.equal(dp.fullRefreshCount, bf.fullRefreshCount, `全刷次数不一致 iter=${iter}`);
    assert.deepEqual(dp.actions, bf.actions, `动作序列不一致 iter=${iter}`);
    assert.equal(dp.totalCost, simulate(tr, dp.actions, opts).cost);

    // 每个最终步都必须准确显示目标：DP/simulate 本身即按转移执行；校验计数不越界
    for (const step of dp.steps) {
      for (const c of step.countsAfter) assert.ok(c <= maxGhost && c >= 0);
      for (const c of step.countsBefore) assert.ok(c <= maxGhost && c >= 0);
    }
    // 费用恒不劣于“全 F”与“贪心到顶再全刷”类基线（此处直接比较全 F）
    const allF = Array(N).fill('F');
    assert.ok(dp.totalCost <= simulate(tr, allF, opts).cost);
  }
  assert.ok(cases === 600);
});

test('DP 与全枚举一致（随机像素数 1..9）', () => {
  const rng = mulberry32(42);
  for (let iter = 0; iter < 300; iter++) {
    const rows = 2, cols = 2, T = 4;
    const N = 1 + Math.floor(rng() * 7);
    const opts = { rows, cols, width: 4, height: 4, maxGhost: 2, fullCost: 100, partialBase: 5 };
    const frames = [];
    let prev = new Array(T).fill(0);
    for (let i = 0; i < N; i++) {
      const cur = new Array(T);
      for (let t = 0; t < T; t++) cur[t] = rng() < 0.45 ? (prev[t] ? 0 : 1) : prev[t];
      frames.push(cur);
      prev = cur;
    }
    // 为每个 (帧, 瓦片) 预先固定像素数，手工构造 transitions
    const pixels = frames.map(() => Array.from({ length: T }, () => 1 + Math.floor(rng() * 9)));
    const tr = [];
    let prevMask = new Array(T).fill(0);
    for (let i = 0; i < N; i++) {
      const changed = new Uint8Array(T);
      const pix = new Int32Array(T);
      for (let t = 0; t < T; t++) {
        if (frames[i][t] !== prevMask[t]) { changed[t] = 1; pix[t] = pixels[i][t]; }
      }
      tr.push({ changed, pixels: pix });
      prevMask = frames[i];
    }
    const dp = solvePlan(tr, opts);
    const bf = bruteForcePlan(tr, opts);
    assert.equal(dp.totalCost, bf.totalCost);
    assert.deepEqual(dp.actions, bf.actions);
  }
});

// ---------- 规则与裁决的确定性小例（含手工可核对数值） ----------

test('规则核对：单瓦片 1 帧，F=600 vs P=31', () => {
  const tr = transitions([[1]]);
  const plan = solvePlan(tr, { rows: 1, cols: 1, width: 1, height: 1 });
  assert.deepEqual(plan.actions, ['P']);
  assert.equal(plan.totalCost, 31);
  assert.deepEqual(plan.steps[0].changedTiles, [0]);
  assert.deepEqual(plan.steps[0].countsBefore, [0]);
  assert.deepEqual(plan.steps[0].countsAfter, [1]);
});

test('规则核对：计数达到 2 后必须全刷（maxGhost=2，连续 3 帧都变化）', () => {
  const tr = transitions([[1], [0], [1]]); // 瓦片 0 每帧都翻转
  const plan = solvePlan(tr, { rows: 1, cols: 1, width: 1, height: 1, maxGhost: 2 });
  // 合法序列：PPP 非法；恰 1 次 F：FPP / PFP / PPF 各 662；
  // 2 次 F 方案至少 1200+31=1231；FFF=1800。
  // 最少全刷 1 次：662 并列，裁决 F<P，帧 0 处 F 靠前 → FPP
  assert.deepEqual(plan.actions, ['F', 'P', 'P']);
  assert.equal(plan.totalCost, 662);
  assert.equal(plan.fullRefreshCount, 1);
  // 反例：PPP 必须非法
  assert.equal(simulate(tr, ['P', 'P', 'P'], { rows: 1, cols: 1, width: 1, height: 1 }).legal, false);
  // 全刷清零效果：FPP 后计数为 2
  assert.deepEqual(plan.steps.map(s => s.countsAfter), [[0], [1], [2]]);
});

test('同价裁决①：全刷次数较少者优先（即使其动作序列字典序更大）', () => {
  // T=1，maxGhost=2，N=5，瓦片每帧翻转（每帧都变化）。
  // 0 次全刷（PPPPP）非法：连续 3 个 P 会使计数超过 2。
  // 1 次全刷合法当且仅当 F 两侧的连续 P 段各 ≤2，N=5 时 F 只能在位置 2（PPFPP）。
  // 费用 = 600 + 4*31 = 724；任何 ≥2 次 F 的方案至少 600*2 > 724。
  const tr = transitions([[1], [0], [1], [0], [1]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, maxGhost: 2 };
  const plan = solvePlan(tr, opts);
  assert.equal(plan.fullRefreshCount, 1);
  assert.deepEqual(plan.actions, ['P', 'P', 'F', 'P', 'P']);
  assert.equal(plan.totalCost, 724);

  // 反向佐证：若 N=6，1 次 F 无法同时压住两段（最长合法 P 段各 2，共 4+1=5<6），
  // 至少需要 2 次 F。
  const tr6 = transitions([[1], [0], [1], [0], [1], [0]]);
  const plan6 = solvePlan(tr6, opts);
  assert.ok(plan6.fullRefreshCount >= 2);
});

test('同价裁决②：全刷次数相同时逐帧 F 先于 P（位串小者胜）', () => {
  // 两瓦片，两帧，两帧都是两瓦片同时翻转：
  //   帧0 mask 11、帧1 mask 00；fullCost=64，P(两瓦片)=2*(31+1)=64，maxGhost=1。
  //   PP 非法（瓦片计数会到 2）；FP 与 PF 费用同为 128、全刷次数同为 1，
  //   帧 0 处 F 靠前 → FP。
  const tr = transitionsForMasks([
    [1, 1],
    [0, 0]
  ]);
  const opts = { rows: 1, cols: 2, width: 2, height: 1, maxGhost: 1, fullCost: 64, partialBase: 31 };
  assert.equal(simulate(tr, ['P', 'P'], opts).legal, false);
  const plan = solvePlan(tr, opts);
  assert.deepEqual(plan.actions, ['F', 'P']);
  assert.equal(plan.totalCost, 128);
  assert.equal(plan.fullRefreshCount, 1);
});

test('未变化帧：空操作式局刷费用 0，且优先于全刷', () => {
  const tr = transitions([[0]]); // 初始全白，第 1 帧也全白
  const plan = solvePlan(tr, { rows: 1, cols: 1, width: 1, height: 1 });
  assert.deepEqual(plan.actions, ['P']);
  assert.equal(plan.totalCost, 0);
  assert.deepEqual(plan.steps[0].changedTiles, []);
});

test('0 帧序列：费用 0，空动作', () => {
  const plan = solvePlan([], { rows: 3, cols: 3, width: 48, height: 48 });
  assert.equal(plan.totalCost, 0);
  assert.equal(plan.nFrames, 0);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.steps, []);
});

test('全刷把所有瓦片残影清零（不只是变化的）', () => {
  // T=2，maxGhost=2：瓦片1 连续两帧变化 → 计数 2；第三帧瓦片0 变化时全刷，两者都归零
  const tr = transitionsForMasks([
    [0, 1],
    [0, 0],
    [1, 0]
  ]);
  const plan = solvePlan(tr, { rows: 1, cols: 2, width: 2, height: 1 });
  // PPF? 帧0 P: [0,1], 帧1 P: [0,2], 帧2 瓦片0 若 P 则 [1,2] 合法 → PPP 费用 =31*3=93
  assert.deepEqual(plan.actions, ['P', 'P', 'P']);
  assert.deepEqual(plan.steps[2].countsAfter, [1, 2]);
  // 改为帧2 强制全刷验证清零：手动模拟 F
  const sim = simulate(tr, ['P', 'P', 'F'], { rows: 1, cols: 2, width: 2, height: 1 });
  assert.deepEqual(sim.steps[2].countsAfter, [0, 0]);
  assert.equal(sim.cost, 31 + 31 + 600);
});

// ---------- 48×48 / 3×3 真实像素模型 ----------

test('48×48 3×3：像素级转移费用正确（按瓦片统计改变像素）', () => {
  const W = 48, H = 48;
  const blank = new Uint8Array(W * H);
  const frame = new Uint8Array(W * H);
  // 瓦片 (0,0)：16×16（行/列 0..15）点亮行 0 前 10 列 = 10 个像素；
  // 瓦片 (2,2)：行/列 32..47，在行 47 的列 32..34 点亮 3 个像素。
  for (let x = 0; x < 10; x++) frame[x] = 1;
  for (let i = 0; i < 3; i++) frame[47 * 48 + 32 + i] = 1;

  const tr = transitionsForGrid([blank, frame], { rows: 3, cols: 3, width: 48, height: 48 });
  assert.equal(tr[0].changed[0], 0); // 第 0 帧是 blank vs blank
  assert.equal(tr[1].changed[0], 1);
  assert.equal(tr[1].pixels[0], 10);
  assert.equal(tr[1].changed[8], 1);
  assert.equal(tr[1].pixels[8], 3);
  let nChanged = 0;
  for (let t = 0; t < 9; t++) if (tr[1].changed[t]) nChanged++;
  assert.equal(nChanged, 2);

  const plan = solvePlan(tr, { rows: 3, cols: 3, width: 48, height: 48 });
  // 帧0：P 费用 0；帧1：P = 2*30 + 13 = 73
  assert.deepEqual(plan.actions, ['P', 'P']);
  assert.equal(plan.totalCost, 73);
  assert.equal(plan.steps[1].cost, 73);
});

test('48×48 非 3×3 网格参数被拒绝', () => {
  assert.throws(() => transitionsForGrid([new Uint8Array(10)], { rows: 3, cols: 3, width: 10, height: 48 }));
});

// ---------- Supervisor：旧 Worker 结果迟到 ----------

// 用 Node vm 执行 buildWorkerSource() 产出的【与浏览器同一份】Worker 源码，
// 通过自实现的传输层精确控制响应到达时机。
function makeFakeWorker() {
  const handlers = { message: null, error: null };
  const sandbox = {
    self: {
      onmessage: null,
      postMessage(msg) { queue.push({ data: msg }); }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(buildWorkerSource(), sandbox);
  const queue = [];

  const transport = {
    post(msg) {
      // 同步派发（把响应放入队列，由测试控制何时 flush）
      sandbox.self.onmessage({ data: msg });
    },
    terminate() { transport.terminated = true; },
    onMessage(fn) { handlers.message = fn; },
    onError(fn) { handlers.error = fn; },
    // 测试控制：投递排队中的响应（可选只投旧的/乱序）
    flush(predicate) {
      const remaining = [];
      for (const q of queue) {
        if (!predicate || predicate(q.data)) handlers.message(q);
        else remaining.push(q);
      }
      queue.length = 0;
      queue.push(...remaining);
    },
    pending: queue
  };
  return transport;
}

test('迟到结果被丢弃：solve A 未解 → solve B → A 的结果到达不 resolve A，B 正常', async () => {
  let fake;
  const sup = createSupervisor((onMsg) => {
    fake = makeFakeWorker();
    fake.onMessage(onMsg);
    return fake;
  });

  const trA = transitions([[1]]);
  const trB = transitions([[1], [0], [1]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, maxGhost: 2 };

  const pA = sup.solve({ transitions: trA, options: opts });
  const aId = sup.currentId();
  assert.equal(fake.pending.length, 1);
  assert.equal(fake.pending[0].data.id, aId);

  // 在 flush A 之前发起 B：A 应被 SUPERSEDED
  const pB = sup.solve({ transitions: trB, options: opts });
  await assert.rejects(pA, (e) => e.code === 'SUPERSEDED');
  assert.equal(fake.pending.length, 2);

  // A 的迟到结果先到达：必须被静默丢弃，B 不受影响
  fake.flush((d) => d.id === aId);
  assert.equal(sup.isBusy(), true);

  // B 的结果到达（vm 跨 realm，用 JSON 结构比较）
  fake.flush((d) => d.id !== aId);
  const planB = await pB;
  assert.deepEqual(JSON.parse(JSON.stringify(planB.actions)), ['F', 'P', 'P']);
  assert.equal(planB.totalCost, 662);
  assert.equal(sup.isBusy(), false);
});

test('终止后迟到结果同样被丢弃，待处理 Promise reject TERMINATED', async () => {
  let fake;
  const sup = createSupervisor((onMsg) => {
    fake = makeFakeWorker();
    fake.onMessage(onMsg);
    return fake;
  });
  const tr = transitions([[1]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1 };
  const p = sup.solve({ transitions: tr, options: opts });
  sup.terminate();
  await assert.rejects(p, (e) => e.code === 'TERMINATED');
  assert.equal(fake.terminated, true);
  // transport 已被废弃；迟到响应调用旧 handler 不会抛
  assert.doesNotThrow(() => fake.flush(() => true));
});

test('Worker 报错路径', async () => {
  let fake;
  const sup = createSupervisor((onMsg) => {
    fake = makeFakeWorker();
    fake.onMessage(onMsg);
    return fake;
  });
  // 帧长度与参数不匹配 → worker 返回 error
  const p = sup.solve({ frames: [new Uint8Array(5)], options: { rows: 3, cols: 3, width: 48, height: 48 } });
  fake.flush(() => true);
  await assert.rejects(p, (e) => e.code === 'WORKER_ERROR');
});

test('同输入重复求解结果确定', () => {
  const tr = transitionsForMasks([[1, 0], [1, 1], [0, 1], [0, 0]]);
  const opts = { rows: 1, cols: 2, width: 2, height: 1, maxGhost: 2, fullCost: 90, partialBase: 20 };
  const a = solvePlan(tr, opts);
  const b = solvePlan(tr, opts);
  assert.deepEqual(a.actions, b.actions);
  assert.equal(a.totalCost, b.totalCost);
});

test('真实像素网格 2×2（每瓦 2×2）随机帧：transitionsForGrid → DP 与全枚举对拍', () => {
  const rng = mulberry32(99);
  const opts = { rows: 2, cols: 2, width: 4, height: 4, maxGhost: 2, fullCost: 120, partialBase: 10 };
  for (let iter = 0; iter < 200; iter++) {
    const N = Math.floor(rng() * 11); // 0..10 → 枚举至多 1024 个序列
    const frames = [];
    const prev = new Uint8Array(16);
    for (let i = 0; i < N; i++) {
      const cur = new Uint8Array(prev);
      const flips = Math.floor(rng() * 12);
      for (let k = 0; k < flips; k++) cur[Math.floor(rng() * 16)] ^= 1;
      frames.push(cur);
      prev.set(cur);
    }
    const tr = transitionsForGrid(frames, opts);
    const dp = solvePlan(tr, opts);
    const bf = bruteForcePlan(tr, opts);
    assert.equal(dp.totalCost, bf.totalCost, `iter=${iter}`);
    assert.equal(dp.fullRefreshCount, bf.fullRefreshCount, `iter=${iter}`);
    assert.deepEqual(dp.actions, bf.actions, `iter=${iter}`);
  }
});

test('maxGhost=1 随机网格对拍（每瓦至多局刷 1 次就必须全刷）', () => {
  const rng = mulberry32(7);
  const opts = { rows: 1, cols: 3, width: 3, height: 1, maxGhost: 1, fullCost: 80, partialBase: 15 };
  for (let iter = 0; iter < 200; iter++) {
    const N = 1 + Math.floor(rng() * 9);
    const frames = [];
    const prev = new Uint8Array(3);
    for (let i = 0; i < N; i++) {
      const cur = new Uint8Array(prev);
      for (let x = 0; x < 3; x++) if (rng() < 0.4) cur[x] ^= 1;
      frames.push(cur);
      prev.set(cur);
    }
    const tr = transitionsForGrid(frames, opts);
    const dp = solvePlan(tr, opts);
    const bf = bruteForcePlan(tr, opts);
    assert.deepEqual(dp.actions, bf.actions, `iter=${iter}`);
    assert.equal(dp.totalCost, bf.totalCost, `iter=${iter}`);
  }
});

// ---------- 逐帧刷新方式约束（必须全刷 / 必须局刷） ----------

test('必须全刷：无约束最优为 P 时，帧约束改为 F 后 DP 选 F 且 simulate 合法（不再内部错误）', () => {
  const tr = transitions([[1]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, frameModes: ['F'] };
  const plan = solvePlan(tr, opts);
  assert.deepEqual(plan.actions, ['F']);
  assert.equal(plan.totalCost, 600);
  assert.deepEqual(plan.steps[0].countsAfter, [0]);
  // 被禁止的动作在 simulate 中也非法
  assert.equal(simulate(tr, ['P'], opts).legal, false);
});

test('必须局刷：强制 P 优先于同帧更贵/更便宜的 F，按约束选择', () => {
  // 两瓦片同时翻转：P=2*(30+1)=62 < F=600，但帧0强制 F → F,P；
  // 反向把帧1强制 F（无约束时帧1无变化P费用0）→ P,F 费用 662
  const tr = transitionsForMasks([[1, 1], [1, 1]]); // 帧0变化，帧1无变化
  const base = { rows: 1, cols: 2, width: 2, height: 1 };
  const pF = solvePlan(tr, Object.assign({}, base, { frameModes: ['F', 'either'] }));
  assert.deepEqual(pF.actions, ['F', 'P']);
  assert.equal(pF.totalCost, 600);
  const pP = solvePlan(tr, Object.assign({}, base, { frameModes: ['either', 'F'] }));
  assert.deepEqual(pP.actions, ['P', 'F']);
  assert.equal(pP.totalCost, 62 + 600);
});

test('不可行帧段：连续 3 帧变化且全部必须局刷 → 报 INFEASIBLE 而非内部错误', () => {
  const tr = transitions([[1], [0], [1]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, frameModes: ['P', 'P', 'P'] };
  let caught;
  assert.throws(() => { try { solvePlan(tr, opts); } catch (e) { caught = e; throw e; } },
    /第 2 帧/);
  assert.equal(caught.code, 'INFEASIBLE');
  assert.throws(() => bruteForcePlan(tr, opts), /无合法刷新方案/);
});

test('不可行帧段定位：中间强制全刷会重置计数，帧段从最近一次强制 F 之后起算', () => {
  // 帧0..2 强制 P 合法（计数最多到 2 的临界），构造帧0F,1P,2P,3P 强制：
  // 单瓦片每帧翻转，F 后连续 3 个 P 非法 → 不可行段为 1..3
  const tr = transitions([[1], [0], [1], [0]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, frameModes: ['F', 'P', 'P', 'P'] };
  let caught;
  try { solvePlan(tr, opts); } catch (e) { caught = e; }
  assert.ok(caught, '应抛出不可行错误');
  assert.equal(caught.code, 'INFEASIBLE');
  assert.match(caught.message, /第 1–3 帧/);
});

test('强制全刷帧本身恒合法（即使全部帧段被 P 约束压满）', () => {
  // 连续 3 帧翻转：帧2强制 F 后 PPP 的非法性解除 → PPF
  const tr = transitions([[1], [0], [1]]);
  const plan = solvePlan(tr, {
    rows: 1, cols: 1, width: 1, height: 1, frameModes: ['either', 'either', 'F']
  });
  assert.deepEqual(plan.actions, ['P', 'P', 'F']);
  assert.equal(plan.totalCost, 31 + 31 + 600);
});

// ---------- 逐帧费用 ----------

test('逐帧全刷费用：DP 使用当帧 fullCost 而非全局值', () => {
  const tr = transitions([[1], [0]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, frameFullCosts: [10, 600] };
  const plan = solvePlan(tr, opts);
  assert.deepEqual(plan.actions, ['F', 'P']); // 10+31=41 < 31+31=62
  assert.equal(plan.totalCost, 41);
  assert.equal(plan.steps[0].cost, 10);
  assert.equal(plan.steps[1].cost, 31);
  // simulate 口径一致
  assert.equal(simulate(tr, plan.actions, opts).cost, 41);
  assert.deepEqual(bruteForcePlan(tr, opts).actions, ['F', 'P']);
});

test('逐帧局刷基础费用：无变化帧费用恒 0；有变化帧按当帧 base 计价', () => {
  const tr = transitions([[1], [0]]);
  const opts = { rows: 1, cols: 1, width: 1, height: 1, framePartialBases: [0, 30] };
  const plan = solvePlan(tr, opts);
  assert.deepEqual(plan.actions, ['P', 'P']);
  assert.equal(plan.totalCost, 1 + 31); // 帧0 每瓦 0+1
  assert.equal(plan.steps[0].framePartialBase, 0);
  assert.equal(plan.steps[1].framePartialBase, 30);
});

test('逐帧费用+约束+maxGhost 随机对拍（DP 与全枚举完全一致）', () => {
  const rng = mulberry32(20261002);
  for (let iter = 0; iter < 400; iter++) {
    const rows = 1, cols = 1 + Math.floor(rng() * 2); // 1..2 瓦片
    const T = rows * cols;
    const N = 1 + Math.floor(rng() * 8);
    const maxGhost = 1 + Math.floor(rng() * 2);
    const frames = [];
    const prev = new Array(T).fill(0);
    for (let i = 0; i < N; i++) {
      const cur = new Array(T);
      for (let t = 0; t < T; t++) cur[t] = rng() < 0.5 ? (prev[t] ? 0 : 1) : prev[t];
      frames.push(cur);
      prev.splice(0, T, ...cur);
    }
    const tr = transitions(frames);
    const frameModes = frames.map(() => {
      const r = rng();
      return r < 0.7 ? 'either' : r < 0.85 ? 'F' : 'P';
    });
    const frameFullCosts = frames.map(() => 20 + Math.floor(rng() * 400));
    const framePartialBases = frames.map(() => Math.floor(rng() * 60));
    const opts = {
      rows, cols, width: cols * 2, height: rows * 2, maxGhost,
      fullCost: 300, partialBase: 25,
      frameModes, frameFullCosts, framePartialBases
    };
    let dp, bf;
    try {
      dp = solvePlan(tr, opts);
    } catch (e) {
      assert.equal(e.code, 'INFEASIBLE', `iter=${iter} 非不可行错误: ${e.message}`);
      assert.throws(() => bruteForcePlan(tr, opts), /无合法刷新方案/);
      continue;
    }
    bf = bruteForcePlan(tr, opts);
    assert.equal(dp.totalCost, bf.totalCost, `费用不一致 iter=${iter}`);
    assert.equal(dp.fullRefreshCount, bf.fullRefreshCount, `全刷数不一致 iter=${iter}`);
    assert.deepEqual(dp.actions, bf.actions, `动作序列不一致 iter=${iter}`);
    const sim = simulate(tr, dp.actions, opts);
    assert.equal(sim.legal, true, `DP 方案被 simulate 判非法 iter=${iter}`);
    assert.equal(sim.cost, dp.totalCost, `simulate 费用不一致 iter=${iter}`);
  }
});

test('非法约束值被拒绝（模式/费用）', () => {
  const tr = transitions([[1]]);
  const base = { rows: 1, cols: 1, width: 1, height: 1 };
  assert.throws(() => solvePlan(tr, Object.assign({}, base, { frameModes: ['x'] })), /either\/F\/P/);
  assert.throws(() => solvePlan(tr, Object.assign({}, base, { frameFullCosts: [-1] })), /非负整数/);
  assert.throws(() => solvePlan(tr, Object.assign({}, base, { framePartialBases: [NaN] })), /非负整数/);
  assert.throws(() => solvePlan(tr, Object.assign({}, base, { frameModes: 'F' })), /frameModes 必须是数组/);
});

test('Worker 源码支持逐帧约束与费用（vm 执行真实 buildWorkerSource）', async () => {
  const handlers = { message: null };
  const sandbox = {
    self: { onmessage: null, postMessage(msg) { queue.push({ data: msg }); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(buildWorkerSource(), sandbox);
  const queue = [];
  const post = (msg) => sandbox.self.onmessage({ data: msg });
  const flush = () => { const qs = queue.splice(0); qs.forEach(q => handlers.message(q)); };

  const sup = createSupervisor((onMsg) => {
    handlers.message = onMsg;
    return { post, terminate() {} };
  });

  const tr = transitions([[1], [0]]);
  const opts = {
    rows: 1, cols: 1, width: 1, height: 1,
    frameModes: ['F', 'P'], frameFullCosts: [10, 600], framePartialBases: [5, 30]
  };
  const p = sup.solve({ transitions: tr, options: opts });
  flush();
  const plan = await p;
  assert.deepEqual(JSON.parse(JSON.stringify(plan.actions)), ['F', 'P']); // vm 跨 realm
  assert.equal(plan.totalCost, 10 + 31);
});


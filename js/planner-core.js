/*!
 * 离线电子纸刷新规划 —— 纯逻辑核心（无 DOM 依赖）
 *
 * 模型：
 *   - 黑白像素画面被划分为 rows × cols 个固定瓦片。
 *   - 每个瓦片有残影计数 0..maxGhost（初始 0，上限 2）。
 *   - 每帧可选择：
 *       F（全屏刷新）：费用 fullCost（默认 600），所有瓦片残影计数清零；
 *       P（局刷）：仅对“本帧发生变化”的瓦片逐块局刷，
 *                  费用 Σ(partialBase + 该瓦片改变像素数)（partialBase 默认 30），
 *                  每个发生变化的瓦片计数 +1；未变化瓦片计数不变。
 *     任一瓦片计数不得超过 maxGhost；因此局刷前某变化瓦片计数已达上限则该动作非法。
 *   - 每帧可通过 options.frameModes[i] 指定约束：'either'（默认）/ 'F'（必须全刷）/
 *     'P'（必须局刷）；被约束禁止的动作不参与转移。
 *   - options.frameFullCosts[i] / framePartialBases[i] 可逐帧覆盖当帧全刷费用与
 *     局刷每瓦基础费用，缺位回落全局 fullCost / partialBase。
 *   - 强制局刷可能使某帧段无合法方案：solvePlan 抛出 code='INFEASIBLE' 并标出帧段。
 *
 * 在【整段帧序列】上做动态规划求总费用最小的合法方案；
 * 同价裁决顺序：① 全刷次数少  ② 动作序列逐帧“全刷先于局刷”（F < P）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EPaperPlanner = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function epaperPlannerFactory() {
  'use strict';

  var DEFAULT_OPTIONS = {
    rows: 3,
    cols: 3,
    width: 48,
    height: 48,
    fullCost: 600,
    partialBase: 30,
    maxGhost: 2
  };

  function normalizeOptions(opts) {
    opts = opts || {};
    var o = {
      rows: positiveInt(opts.rows, DEFAULT_OPTIONS.rows),
      cols: positiveInt(opts.cols, DEFAULT_OPTIONS.cols),
      width: positiveInt(opts.width, DEFAULT_OPTIONS.width),
      height: positiveInt(opts.height, DEFAULT_OPTIONS.height),
      fullCost: nonNegInt(opts.fullCost, DEFAULT_OPTIONS.fullCost),
      partialBase: nonNegInt(opts.partialBase, DEFAULT_OPTIONS.partialBase),
      maxGhost: positiveInt(opts.maxGhost, DEFAULT_OPTIONS.maxGhost),
      frameModes: sanitizeFrameModes(opts.frameModes),
      frameFullCosts: sanitizeFrameCosts(opts.frameFullCosts, 'frameFullCosts'),
      framePartialBases: sanitizeFrameCosts(opts.framePartialBases, 'framePartialBases')
    };
    if (o.width % o.cols !== 0) throw new Error('width 必须能被 cols 整除');
    if (o.height % o.rows !== 0) throw new Error('height 必须能被 rows 整除');
    return o;
  }

  var VALID_MODES = { either: true, F: true, P: true };

  function sanitizeFrameModes(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error('frameModes 必须是数组');
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var m = v[i] === undefined || v[i] === null || v[i] === '' ? 'either' : v[i];
      if (typeof m !== 'string' || !VALID_MODES[m]) {
        throw new Error('第 ' + i + ' 帧刷新方式只能是 either/F/P，得到: ' + v[i]);
      }
      out.push(m);
    }
    return out;
  }

  function sanitizeFrameCosts(v, name) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(name + ' 必须是数组');
    var out = [];
    for (var i = 0; i < v.length; i++) {
      if (v[i] === undefined || v[i] === null) continue; // 缺位回落全局值
      var cv = Number(v[i]);
      if (!isFinite(cv) || cv < 0 || Math.floor(cv) !== cv) {
        throw new Error(name + '[' + i + '] 必须是非负整数，得到: ' + v[i]);
      }
      out[i] = cv;
    }
    return out;
  }

  function frameAt(arr, i, fallback) {
    return arr && arr[i] !== undefined ? arr[i] : fallback;
  }

  function positiveInt(v, d) {
    v = v === undefined ? d : v;
    if (typeof v !== 'number' || !isFinite(v) || v < 1 || Math.floor(v) !== v) {
      throw new Error('期望正整数，得到: ' + v);
    }
    return v;
  }
  function nonNegInt(v, d) {
    v = v === undefined ? d : v;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || Math.floor(v) !== v) {
      throw new Error('期望非负整数，得到: ' + v);
    }
    return v;
  }

  function asArray(v) {
    if (v === undefined || v === null) throw new Error('缺少数据');
    if (typeof v.length !== 'number') throw new Error('数据不是数组');
    return v;
  }

  /**
   * 由完整像素帧序列生成逐帧转移信息。
   * frames: 若干个长度 width*height 的 0/1 数组；初始画面为全白（全 0）。
   * 返回 [{changed: Uint8Array(T), pixels: Int32Array(T)}]
   *   changed[t] = 该瓦片本帧是否有像素变化
   *   pixels[t]  = 该瓦片改变的像素数（changed=0 时必为 0）
   */
  function transitionsForGrid(frames, options) {
    var o = normalizeOptions(options);
    var T = o.rows * o.cols;
    var tw = o.width / o.cols;
    var th = o.height / o.rows;
    var list = asArray(frames);
    var transitions = [];
    var prev = new Uint8Array(o.width * o.height);

    for (var f = 0; f < list.length; f++) {
      var frame = asArray(list[f]);
      if (frame.length !== o.width * o.height) {
        throw new Error('第 ' + f + ' 帧像素数应为 ' + o.width * o.height + '，实际 ' + frame.length);
      }
      var changed = new Uint8Array(T);
      var pixels = new Int32Array(T);
      for (var r = 0; r < o.rows; r++) {
        for (var c = 0; c < o.cols; c++) {
          var t = r * o.cols + c;
          var diff = 0;
          for (var y = r * th; y < (r + 1) * th; y++) {
            var rowBase = y * o.width + c * tw;
            for (var x = 0; x < tw; x++) {
              var a = prev[rowBase + x] ? 1 : 0;
              var b = frame[rowBase + x] ? 1 : 0;
              if (a !== b) diff++;
            }
          }
          if (diff > 0) {
            changed[t] = 1;
            pixels[t] = diff;
          }
        }
      }
      transitions.push({ changed: changed, pixels: pixels });
      prev = typeof frame.set === 'function' ? frame : toU8(frame);
    }
    return transitions;
  }

  function toU8(a) {
    var u = new Uint8Array(a.length);
    for (var i = 0; i < a.length; i++) u[i] = a[i] ? 1 : 0;
    return u;
  }

  /**
   * 由瓦片 0/1 掩码帧序列生成转移信息（测试/抽象模型用）。
   * masks: 若干个长度 T 的 0/1 数组；初始全 0。
   * pixelForChange(prevMask, nextMask, tileIndex) 可自定义“改变像素数”，默认 1。
   */
  function transitionsForMasks(masks, pixelForChange) {
    var list = asArray(masks);
    var T = list.length ? asArray(list[0]).length : 0;
    var transitions = [];
    var prev = new Uint8Array(T);
    for (var i = 0; i < list.length; i++) {
      var cur = asArray(list[i]);
      if (cur.length !== T) throw new Error('第 ' + i + ' 帧瓦片数不一致');
      var changed = new Uint8Array(T);
      var pixels = new Int32Array(T);
      for (var t = 0; t < T; t++) {
        var a = prev[t] ? 1 : 0;
        var b = cur[t] ? 1 : 0;
        if (a !== b) {
          changed[t] = 1;
          var p = pixelForChange ? pixelForChange(prev, cur, t) : 1;
          pixels[t] = nonNegInt(p, 0);
        }
      }
      transitions.push({ changed: changed, pixels: pixels });
      prev = toU8(cur);
    }
    return transitions;
  }

  function validateTransitions(transitions, T) {
    var list = asArray(transitions);
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      if (!tr || asArray(tr.changed).length !== T) {
        throw new Error('第 ' + i + ' 帧 changed 长度应为 ' + T);
      }
      if (asArray(tr.pixels).length !== T) {
        throw new Error('第 ' + i + ' 帧 pixels 长度应为 ' + T);
      }
      for (var t = 0; t < T; t++) {
        var ch = tr.changed[t];
        var px = tr.pixels[t];
        if (ch !== 0 && ch !== 1) throw new Error('changed 只能是 0/1');
        if (typeof px !== 'number' || px < 0 || Math.floor(px) !== px) {
          throw new Error('pixels 必须是非负整数');
        }
      }
    }
    return list;
  }

  // ---- 三进制状态：state = Σ count[t] * 3^t，count[t] ∈ {0,1,2} ----
  function powersOf3(T) {
    var p = new Int32Array(T);
    var v = 1;
    for (var i = 0; i < T; i++) { p[i] = v; v *= 3; }
    return p;
  }
  function decodeState(state, T, out) {
    for (var t = 0; t < T; t++) {
      out[t] = state % 3;
      state = Math.floor(state / 3);
    }
    return out;
  }

  /**
   * 按给定动作序列模拟执行。
   * actions: 每帧 'F'（全刷）或 'P'（局刷）。
   * 返回 {legal, cost, fulls, steps}；非法时 legal=false（cost/fulls 仍为部分统计）。
   */
  function simulate(transitions, actions, options) {
    var o = normalizeOptions(options);
    var T = o.rows * o.cols;
    var list = validateTransitions(transitions, T);
    if (asArray(actions).length !== list.length) throw new Error('动作数与帧数不一致');

    var counts = new Int32Array(T);
    var total = 0;
    var fulls = 0;
    var steps = [];
    var legal = true;

    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      var before = Array.prototype.slice.call(counts);
      var changedTiles = [];
      var pixelChanges = new Int32Array(T);
      var cost = 0;
      var action = actions[i];

      var required = frameAt(o.frameModes, i, 'either');
      if (required !== 'either' && action !== required) {
        return { legal: false, cost: total, fulls: fulls, steps: steps };
      }

      if (action === 'F') {
        cost = frameAt(o.frameFullCosts, i, o.fullCost);
        fulls++;
        for (var t1 = 0; t1 < T; t1++) counts[t1] = 0;
      } else if (action === 'P') {
        var pbase = frameAt(o.framePartialBases, i, o.partialBase);
        for (var t2 = 0; t2 < T; t2++) {
          if (tr.changed[t2]) {
            if (counts[t2] >= o.maxGhost) { legal = false; }
            changedTiles.push(t2);
            pixelChanges[t2] = tr.pixels[t2];
            cost += pbase + tr.pixels[t2];
          }
        }
        if (legal) {
          for (var k = 0; k < changedTiles.length; k++) counts[changedTiles[k]]++;
        }
      } else {
        throw new Error('动作只能是 F 或 P，得到: ' + action);
      }

      total += cost;
      if (legal) {
        steps.push({
          frame: i,
          action: action,
          fullRefresh: action === 'F',
          cost: cost,
          frameFullCost: action === 'F' ? cost : frameAt(o.frameFullCosts, i, o.fullCost),
          framePartialBase: frameAt(o.framePartialBases, i, o.partialBase),
          changedTiles: changedTiles,
          pixelChanges: Array.prototype.slice.call(pixelChanges),
          countsBefore: before,
          countsAfter: Array.prototype.slice.call(counts)
        });
      } else {
        return { legal: false, cost: total, fulls: fulls, steps: steps };
      }
    }
    return { legal: true, cost: total, fulls: fulls, steps: steps };
  }

  // 比较键：(总费用, 全刷次数, 动作位串)；F 编码为 0、P 编码为 1，
  // 帧 0 占最高位，故位串的数值大小即“逐帧 F 先于 P”的字典序。
  function better(c1, f1, b1, c2, f2, b2) {
    if (c1 !== c2) return c1 < c2;
    if (f1 !== f2) return f1 < f2;
    return b1 < b2;
  }

  /**
   * 动态规划：在整段帧序列上求最优合法刷新方案。
   * transitions: transitionsForGrid / transitionsForMasks 的产物。
   */
  function solvePlan(transitions, options) {
    var o = normalizeOptions(options);
    var T = o.rows * o.cols;
    var list = validateTransitions(transitions, T);
    var N = list.length;
    var p3 = powersOf3(T);

    // 预计算每帧全刷/局刷费用与变化瓦片
    var partialCost = new Int32Array(N);
    var fullCost = new Int32Array(N);
    var mode = new Array(N);
    var changedList = [];
    for (var i = 0; i < N; i++) {
      var tiles = [];
      var base = frameAt(o.framePartialBases, i, o.partialBase);
      var pc = 0;
      for (var t = 0; t < T; t++) {
        if (list[i].changed[t]) {
          tiles.push(t);
          pc += base + list[i].pixels[t];
        }
      }
      changedList.push(tiles);
      partialCost[i] = pc;
      fullCost[i] = frameAt(o.frameFullCosts, i, o.fullCost);
      mode[i] = o.frameModes[i] || 'either';
    }

    // Map<state编码, {c费用, f全刷次数, b动作位串}>（帧 0 在最高位）
    var states = new Map();
    states.set(0, { c: 0, f: 0, b: 0 });
    var lastForcedF = -1; // 上一帧“必须全刷”的帧（用于定位不可行帧段）

    for (var frame = 0; frame < N; frame++) {
      var next = new Map();
      var bit = 1 << (N - 1 - frame); // 帧 0 → 最高位：数值小者 F 靠前
      var changed = changedList[frame];
      var required = mode[frame];

      var entries = states.entries();
      var e;
      while (!(e = entries.next()).done) {
        var s = e.value[0];
        var v = e.value[1];

        // 动作 F：全刷，状态归零（“必须局刷”帧不可走此边）
        if (required !== 'P') {
          putBest(next, 0, v.c + fullCost[frame], v.f + 1, v.b /* F → 位 0 */);
        }

        // 动作 P：“必须全刷”帧不可走；任一变化瓦片计数已达上限则非法
        if (required !== 'F') {
          var ns = s;
          var ok = true;
          for (var k = 0; k < changed.length; k++) {
            var tile = changed[k];
            var cnt = Math.floor(s / p3[tile]) % 3;
            if (cnt >= o.maxGhost) { ok = false; break; }
            ns += p3[tile];
          }
          if (ok) {
            putBest(next, ns, v.c + partialCost[frame], v.f, v.b | bit);
          }
        }
      }

      if (next.size === 0) {
        // 全 F 恒合法，故只有“必须局刷”帧可能让可达状态集为空。
        var segStart = lastForcedF + 1;
        var msg = '第 ' + frame + ' 帧被要求必须局刷，但自' +
          (segStart === 0 ? '初始全白' : ('第 ' + (segStart - 1) + ' 帧全刷')) +
          '起（第 ' + segStart + '–' + frame + ' 帧）始终存在变化瓦片在局刷前残影计数已达上限 ' +
          o.maxGhost + '，该帧段不存在合法刷新方案';
        throw PlannerError('INFEASIBLE', msg);
      }

      states = next;
      if (required === 'F') lastForcedF = frame;
    }

    var bestState = -1;
    var best = null;
    var finals = states.entries();
    var fe;
    while (!(fe = finals.next()).done) {
      var st = fe.value[0];
      var val = fe.value[1];
      if (!best || better(val.c, val.f, val.b, best.c, best.f, best.b)) {
        best = val;
        bestState = st;
      }
    }
    if (!best) throw PlannerError('INFEASIBLE', '无合法刷新方案'); // 理论不可达

    var actions = new Array(N);
    for (var a = 0; a < N; a++) actions[a] = (best.b >> (N - 1 - a)) & 1 ? 'P' : 'F';

    var sim = simulate(list, actions, o);
    if (!sim.legal) throw new Error('内部错误：DP 选出了非法方案（frameModes/费用与 simulate 不一致）');

    return {
      version: 1,
      nFrames: N,
      rows: o.rows,
      cols: o.cols,
      nTiles: T,
      width: o.width,
      height: o.height,
      fullCost: o.fullCost,
      partialBase: o.partialBase,
      maxGhost: o.maxGhost,
      frameModes: o.frameModes,
      frameFullCosts: o.frameFullCosts,
      framePartialBases: o.framePartialBases,
      totalCost: sim.cost,
      fullRefreshCount: sim.fulls,
      partialRefreshCount: N - sim.fulls,
      finalState: bestState,
      actions: actions,
      steps: sim.steps
    };
  }

  function putBest(map, state, c, f, b) {
    var old = map.get(state);
    if (!old || better(c, f, b, old.c, old.f, old.b)) {
      map.set(state, { c: c, f: f, b: b });
    }
  }

  /**
   * 暴力枚举全部 2^N 个动作序列（仅用于小瓦片数/小帧数对拍测试）。
   * 返回与 solvePlan 同形的方案；N=0 时空序列合法、费用 0。
   */
  function bruteForcePlan(transitions, options) {
    var o = normalizeOptions(options);
    var T = o.rows * o.cols;
    var list = validateTransitions(transitions, T);
    var N = list.length;
    if (N > 24) throw new Error('暴力枚举最多支持 24 帧');

    var best = null; // {c,f,b,actions}，b 以帧 0 为最高位
    var total = 1 << N;
    for (var mask = 0; mask < total; mask++) {
      var actions = new Array(N);
      var fulls = 0;
      var counts = new Int32Array(T);
      var cost = 0;
      var legal = true;
      var b = 0; // 帧 0 → 最高位，与 solvePlan 一致

      for (var i = 0; i < N; i++) {
        var isP = (mask >> i) & 1; // 枚举位：帧 0 在最低位
        var tr = list[i];
        var required = o.frameModes[i] || 'either';
        if (isP) {
          if (required === 'F') { legal = false; break; }
          actions[i] = 'P';
          b |= 1 << (N - 1 - i);
          var pbase = frameAt(o.framePartialBases, i, o.partialBase);
          for (var t = 0; t < T; t++) {
            if (tr.changed[t]) {
              if (counts[t] >= o.maxGhost) { legal = false; break; }
              cost += pbase + tr.pixels[t];
              counts[t]++;
            }
          }
        } else {
          if (required === 'P') { legal = false; break; }
          actions[i] = 'F';
          fulls++;
          cost += frameAt(o.frameFullCosts, i, o.fullCost);
          for (var k = 0; k < T; k++) counts[k] = 0;
        }
        if (!legal) break;
      }
      if (legal && (!best || better(cost, fulls, b, best.c, best.f, best.b))) {
        best = { c: cost, f: fulls, b: b, actions: actions };
      }
    }
    if (!best) throw PlannerError('INFEASIBLE', '无合法刷新方案（存在帧段的刷新方式约束无法满足）');

    var sim = simulate(list, best.actions, o);
    return {
      version: 1,
      nFrames: N,
      rows: o.rows,
      cols: o.cols,
      nTiles: T,
      width: o.width,
      height: o.height,
      fullCost: o.fullCost,
      partialBase: o.partialBase,
      maxGhost: o.maxGhost,
      frameModes: o.frameModes,
      frameFullCosts: o.frameFullCosts,
      framePartialBases: o.framePartialBases,
      totalCost: sim.cost,
      fullRefreshCount: sim.fulls,
      partialRefreshCount: N - sim.fulls,
      actions: best.actions,
      steps: sim.steps
    };
  }

  /**
   * 生成 Worker 源码（浏览器里包成 Blob URL 使用，完全离线）。
   * 协议：
   *   请求  {id, type:'solve', frames?, transitions?, options?}
   *   响应  {id, type:'result', plan} 或 {id, type:'error', message}
   */
  function buildWorkerSource() {
    return [
      'var EPaperPlanner = (', epaperPlannerFactory.toString(), ')();',
      'self.onmessage = function (ev) {',
      '  var data = (ev && ev.data) || {};',
      '  try {',
      '    var opts = data.options || data.opts || {};',
      '    var transitions;',
      '    if (data.transitions) {',
      '      transitions = data.transitions;',
      '    } else if (data.frames) {',
      '      transitions = EPaperPlanner.transitionsForGrid(data.frames, opts);',
      '    } else {',
      '      transitions = [];',
      '    }',
      '    var plan = EPaperPlanner.solvePlan(transitions, opts);',
      '    self.postMessage({ id: data.id, type: "result", plan: plan });',
      '  } catch (err) {',
      '    self.postMessage({',
      '      id: data.id,',
      '      type: "error",',
      '      message: (err && err.message) ? err.message : String(err)',
      '    });',
      '  }',
      '};'
    ].join('\n');
  }

  function PlannerError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  /**
   * 求解任务管理者：处理请求 id 关联、旧请求被取代、迟到响应丢弃。
   * makeTransport(onmessage, onerror) => { post(msg), terminate() }
   *
   * 再次调用 solve() 时，上一个未完成的 Promise 以 code='SUPERSEDED' reject；
   * 之后到达的旧 id 响应一律丢弃（“旧 Worker 结果迟到”场景）。
   */
  function createSupervisor(makeTransport) {
    var transport = null;
    var seq = 0;
    var current = null; // {id, resolve, reject}

    function ensureTransport() {
      if (!transport) {
        transport = makeTransport(handleMessage, handleError);
      }
      return transport;
    }

    function handleMessage(ev) {
      var data = (ev && ev.data) || {};
      if (!current || data.id !== current.id) return; // 迟到/过期结果：丢弃
      var pending = current;
      current = null;
      if (data.type === 'result') {
        pending.resolve(data.plan);
      } else {
        pending.reject(PlannerError('WORKER_ERROR', data.message || 'Worker 求解失败'));
      }
    }

    function handleError(ev) {
      if (!current) return;
      var pending = current;
      current = null;
      pending.reject(PlannerError('WORKER_ERROR', (ev && ev.message) || 'Worker 错误'));
    }

    function solve(payload) {
      if (current) {
        var old = current;
        current = null;
        old.reject(PlannerError('SUPERSEDED', '已被更新的求解请求取代'));
      }
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        current = { id: id, resolve: resolve, reject: reject };
        try {
          ensureTransport().post({
            id: id,
            type: 'solve',
            frames: payload && payload.frames,
            transitions: payload && payload.transitions,
            options: (payload && payload.options) || null
          });
        } catch (e) {
          if (current && current.id === id) {
            current = null;
            reject(PlannerError('WORKER_ERROR', e && e.message ? e.message : String(e)));
          }
        }
      });
    }

    function terminate() {
      if (current) {
        var pending = current;
        current = null;
        pending.reject(PlannerError('TERMINATED', '求解器已终止'));
      }
      if (transport) {
        try { transport.terminate(); } catch (e) { /* 忽略 */ }
        transport = null;
      }
    }

    function isBusy() { return !!current; }
    function currentId() { return current ? current.id : 0; }

    return { solve: solve, terminate: terminate, isBusy: isBusy, currentId: currentId };
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    normalizeOptions: normalizeOptions,
    transitionsForGrid: transitionsForGrid,
    transitionsForMasks: transitionsForMasks,
    simulate: simulate,
    solvePlan: solvePlan,
    bruteForcePlan: bruteForcePlan,
    buildWorkerSource: buildWorkerSource,
    createSupervisor: createSupervisor,
    PlannerError: PlannerError,
    decodeState: decodeState,
    powersOf3: powersOf3
  };
});

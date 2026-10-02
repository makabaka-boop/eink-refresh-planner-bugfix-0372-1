'use strict';

// 精简 DOM/浏览器桩：仅用于在 Node 中冒烟执行 index.html 的内联脚本。
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// ---- 最小 DOM ----
function makeCtx2d() {
  return {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    save() {}, restore() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
  };
}

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _classes: new Set(),
    handlers: {},
    width: 0, height: 0,
    _html: '', textContent: '', hidden: false, disabled: false, title: '', value: '',
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      toggle(c, force) { force ? el._classes.add(c) : el._classes.delete(c); },
      contains(c) { return el._classes.has(c); }
    },
    addEventListener(type, fn) {
      (el.handlers[type] = el.handlers[type] || []).push(fn);
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    remove() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 288, height: 288 }; },
    getContext() { return el._ctx || (el._ctx = makeCtx2d()); },
    querySelector(sel) {
      const tag = sel.replace(/^[.#]/, '').toUpperCase();
      for (const c of walk(el)) if (c.tagName === tag) return c;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'tr.step-row') {
        return [...walk(el)].filter(c => c.tagName === 'TR' && c._classes.has('step-row'));
      }
      return [];
    },
    click() {
      (el.handlers.click || []).forEach(fn => fn({
        target: el, preventDefault() {}, stopPropagation() {}
      }));
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(html) {
      el._html = html;
      el.children = [];
      el.textContent = '';
      parseHTMLInto(html, el);
    }
  });
  Object.defineProperty(el, 'className', {
    get() { return [...el._classes].join(' '); },
    set(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return el;
}

// 极简 HTML 解析器（仅支持本页面 innerHTML 用到的标签/属性结构）
const VOID_TAGS = new Set(['BR', 'INPUT', 'IMG', 'META', 'LINK']);
function parseHTMLInto(html, root) {
  const stack = [root];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const parent = stack[stack.length - 1];
    if (m[5] !== undefined) {
      parent.textContent += m[5];
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toUpperCase();
    const selfClose = m[4] === '/';
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node = makeElement(tag);
    parseAttrs(m[3], node);
    parent.appendChild(node);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(node);
  }
}
function parseAttrs(attrText, node) {
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let a;
  while ((a = re.exec(attrText))) {
    const name = a[1], val = a[3] !== undefined ? a[3] : a[4];
    if (name === 'class') val.split(/\s+/).filter(Boolean).forEach(c => node._classes.add(c));
    else if (name.startsWith('data-')) node.dataset[name.slice(5)] = val;
    else node[name] = val;
  }
}
function* walk(node) {
  for (const c of node.children || []) { yield c; yield* walk(c); }
}

function buildDom() {
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement('div'));
      return byId.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    querySelectorAll(sel) {
      if (sel === 'tr.step-row') {
        return [...byId.values()].flatMap(n => [...walk(n)])
          .filter(c => c.tagName === 'TR' && c._classes.has('step-row'));
      }
      return [];
    },
    body: makeElement('body')
  };
  // 预创建脚本会用到的特殊元素
  const editor = document.getElementById('editor-canvas');
  editor.width = editor.height = 48;
  const display = document.getElementById('display-canvas');
  display.width = display.height = 48;
  return { document, byId };
}

// ---- 导出捕获 ----
const downloads = [];
let lastBlobText = null;

function runSmoke() {
  return new Promise((resolve, reject) => {
    const { document, byId } = buildDom();
    let timerSeq = 0;
    const timers = new Map();

    const sandbox = {
      console,
      setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(fn, ms) { const id = ++timerSeq + 10000; timers.set(id, fn); return id; },
      clearInterval(id) { timers.delete(id); },
      btoa(s) { return Buffer.from(s, 'binary').toString('base64'); },
      atob(s) { return Buffer.from(s, 'base64').toString('binary'); },
      Date,
      FileReader: null,
      Blob: class Blob {
        constructor(parts, opts) { this.parts = parts; this.options = opts; lastBlobText = parts.join(''); }
      },
      URL: {
        createObjectURL() { return 'blob:mock/' + (downloads.length + 1); },
        revokeObjectURL() {}
      },
      document,
      window: null
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = function () {}; // window 级监听（pointerup 等）
    vm.createContext(sandbox);

    const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'planner-core.js'), 'utf8');
    vm.runInContext(coreSrc, sandbox);
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInContext(inline, sandbox);

    const pumpTimers = async () => {
      for (let i = 0; i < 50 && timers.size; i++) {
        const [id, fn] = timers.entries().next().value;
        timers.delete(id);
        fn();
        await Promise.resolve();
      }
    };

    (async () => {
      try {
        // —— 初始一帧全白：求解费用应为 0，动作为 P（无变化局刷）——
        byId.get('solve-btn').click();
        await pumpTimers();
        let tbody = byId.get('plan-tbody');
        assert.equal(tbody.children.length, 1, '1 帧 → 结果表 1 行');
        assert.match(byId.get('plan-summary').innerHTML, /总费用/);
        assert.match(byId.get('plan-summary').innerHTML, /<b>0<\/b>/);
        assert.match(byId.get('solve-status').textContent, /总费用 0/);
        assert.equal(byId.get('export-btn').disabled, false);

        // —— 在第 1 帧画 5 个黑像素（瓦片 0 内）——
        const editor = byId.get('editor-canvas');
        const down = editor.handlers.pointerdown[0];
        const move = editor.handlers.pointermove[0];
        const fakePointer = (x, y) => ({
          clientX: x * 6 + 1, clientY: y * 6 + 1, preventDefault() {}, pointerId: 1
        });
        down(fakePointer(0, 0));
        move(fakePointer(1, 0)); move(fakePointer(2, 0)); move(fakePointer(3, 0)); move(fakePointer(4, 0));
        // 加一帧（复制当前）→ 切到第 2 帧，在另一瓦片画 2 像素
        byId.get('frame-add').click();
        const strip = byId.get('frames-strip');
        assert.equal(strip.children.length, 2);
        strip.children[1].click();
        down(fakePointer(20, 20)); move(fakePointer(21, 20)); // 瓦片 (1,1)

        // 脏状态：导出禁用 + 过期横幅
        assert.equal(byId.get('export-btn').disabled, true);
        assert.equal(byId.get('stale-banner').hidden, false);

        // 重新求解
        byId.get('solve-btn').click();
        await pumpTimers();
        tbody = byId.get('plan-tbody');
        assert.equal(tbody.children.length, 2, '2 帧 → 结果表 2 行');
        // 帧0 费用 30+5=35；帧1 费用 30+2=32；总 67（均不超计数上限，全 P）
        assert.match(byId.get('plan-summary').innerHTML, /<b>67<\/b>/);
        assert.match(byId.get('plan-summary').innerHTML, />P P</);
        assert.equal(byId.get('export-btn').disabled, false);
        assert.equal(byId.get('stale-banner').hidden, true);

        // —— 播放：初始 → 下一步（帧0）→ 下一步（帧1）——
        assert.equal(byId.get('playback').hidden, false);
        const countCells = byId.get('count-grid').children;
        assert.equal(countCells.length, 9);
        assert.equal(String(countCells[0].querySelector('b').textContent), '0');
        byId.get('play-next').click();
        assert.equal(String(countCells[0].querySelector('b').textContent), '1'); // 瓦片(0,0) 计数 1
        assert.equal(String(countCells[4].querySelector('b').textContent), '0');
        byId.get('play-next').click();
        assert.equal(String(countCells[0].querySelector('b').textContent), '1');
        assert.equal(String(countCells[4].querySelector('b').textContent), '1'); // 瓦片(1,1) 计数 1
        assert.equal(byId.get('play-next').disabled, true);
        assert.equal(
          document.querySelectorAll('tr.step-row').length, 2
        );
        // 表格行点击跳转
        tbody.children[0].click();
        assert.equal(String(countCells[4].querySelector('b').textContent), '0');

        // 自动播放定时器
        byId.get('play-auto').click();
        await pumpTimers();
        assert.equal(byId.get('play-next').disabled, true);

        // —— 导出：拦截 <a>.click 并解析 Blob JSON ——
        let exported = null;
        const origCreate = sandbox.document.createElement.bind(sandbox.document);
        sandbox.document.createElement = function (tag) {
          const el = origCreate(tag);
          if (tag === 'a') {
            el.click = function () {
              exported = { href: el.href, name: el.download };
            };
          }
          return el;
        };
        byId.get('export-btn').click();
        assert.ok(exported, '应触发下载');
        const json = JSON.parse(lastBlobText);
        assert.equal(json.format, 'epaper-refresh-plan/v1');
        assert.equal(json.frames.length, 2);
        // base64 帧可还原：每帧 2304 bit
        assert.equal(Buffer.from(json.frames[0], 'base64').length, Math.ceil(2304 / 8));
        assert.equal(json.plan.totalCost, 67);
        assert.deepEqual(json.plan.actions, ['P', 'P']);
        downloads.push(exported);

        // —— 导入 base64 导出文件：自动重新求解，结果一致 ——
        const file = { name: 'x.json' };
        const fileInput = byId.get('import-file');
        sandbox.FileReader = class {
          readAsText() {
            this.result = lastBlobText;
            setTimeout(() => this.onload(), 0);
          }
        };
        Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
        fileInput.value = '';
        fileInput.handlers.change[0]({ target: fileInput });
        await pumpTimers();
        assert.match(byId.get('solve-status').textContent, /总费用 67/);

        // —— 逐帧约束：第 1 帧必须全刷，且把当帧全刷费用改为 123 ——
        // （约束/费用改动后旧方案应立即过期、导出锁定）
        strip.children[0].click();
        const modeSel = byId.get('frame-mode');
        modeSel.value = 'F';
        modeSel.handlers.change[0]({ target: modeSel });
        const fullInput = byId.get('frame-full-cost');
        fullInput.value = '123';
        fullInput.handlers.input[0]({ target: fullInput });
        assert.equal(byId.get('export-btn').disabled, true);
        assert.equal(byId.get('stale-banner').hidden, false);

        byId.get('solve-btn').click();
        await pumpTimers();
        // 帧0 强制 F=123；帧1 局刷 32 → 总 155
        assert.match(byId.get('plan-summary').innerHTML, /<b>155<\/b>/);
        assert.match(byId.get('plan-summary').innerHTML, />F P</);
        assert.equal(byId.get('export-btn').disabled, false);
        assert.equal(byId.get('stale-banner').hidden, true);
        // 播放说明必须使用当帧费用 123，而非硬编码 600
        byId.get('play-next').click();
        assert.match(byId.get('play-step-text').innerHTML, /费用 123/);
        assert.doesNotMatch(byId.get('play-step-text').innerHTML, /费用 600/);

        // 结果表费用列与累计一致：123 / 累计 123；第二行 32 / 累计 155
        const rows = document.querySelectorAll('tr.step-row');
        assert.match(tbody.children[0].innerHTML, /123/);
        assert.match(tbody.children[1].innerHTML, /累计 155/);
        assert.equal(rows.length, 2);

        // 再导出：JSON 必须携带逐帧约束与费用
        byId.get('export-btn').click();
        const constrainedJson = JSON.parse(lastBlobText);
        assert.equal(constrainedJson.constraints.frameModes[0], 'F');
        assert.equal(constrainedJson.constraints.frameFullCosts[0], 123);
        assert.equal(constrainedJson.plan.totalCost, 155);
        assert.deepEqual(constrainedJson.plan.actions, ['F', 'P']);
        assert.equal(constrainedJson.plan.steps[0].frameFullCost, 123);

        // 导入该文件：恢复约束后自动重解，必须重现 155 / F P
        sandbox.FileReader = class {
          readAsText() { this.result = lastBlobText; setTimeout(() => this.onload(), 0); }
        };
        fileInput.value = '';
        fileInput.handlers.change[0]({ target: fileInput });
        await pumpTimers();
        assert.match(byId.get('solve-status').textContent, /总费用 155/);
        assert.match(byId.get('plan-summary').innerHTML, />F P</);

        // —— 不可行约束给出明确错误而非“内部错误”：
        // 当前导入后为 2 帧（帧0 瓦片0 五像素黑；帧1 瓦片0 五像素黑 + 瓦片4 两像素黑）。
        // 新增一帧：擦掉瓦片0 的 5 个像素，使瓦片0 在第 3 帧翻转；
        // 于是瓦片0 的变化为 帧0: 白→黑、帧1: 无变化、帧2: 黑→白（仅 2 次，合法）。
        // 改为把三帧全部强制局刷并让瓦片0 连续三帧都翻转：
        //   帧1 擦掉瓦片0 五像素（黑→白），帧2 再画回（白→黑），即 有/无/有 三翻。
        strip.children[0].click();
        byId.get('tool-eraser').click();
        // 帧1：擦瓦片0
        strip.children[1].click();
        for (let xx = 0; xx < 5; xx++) down(fakePointer(xx, 0));
        // 复制帧1 得到帧2（同为擦除状态），再在帧2 画回
        byId.get('frame-add').click();
        byId.get('tool-pencil').click();
        strip.children[2].click();
        for (let xx = 0; xx < 5; xx++) down(fakePointer(xx, 0));
        // 三帧全部强制局刷
        for (let fi = 0; fi < 3; fi++) {
          strip.children[fi].click();
          modeSel.value = 'P';
          modeSel.handlers.change[0]({ target: modeSel });
        }
        byId.get('solve-btn').click();
        await pumpTimers();
        assert.equal(byId.get('solve-status').className, 'error');
        assert.match(byId.get('solve-status').textContent, /不存在合法刷新方案/);
        assert.doesNotMatch(byId.get('solve-status').textContent, /内部错误/);

        // —— 求解期间改动约束：旧结果到达时不得冒充新方案 ——
        // 恢复为合法约束（三帧自动选择）后发起求解，在定时器（worker 回包）执行前修改第 1 帧
        for (let fi = 0; fi < 3; fi++) {
          strip.children[fi].click();
          modeSel.value = 'either';
          modeSel.handlers.change[0]({ target: modeSel });
        }
        byId.get('solve-btn').click();           // worker 回包在 setTimeout 中排队
        assert.match(byId.get('solve-status').textContent, /正在整段/);
        strip.children[0].click();
        modeSel.value = 'F';
        modeSel.handlers.change[0]({ target: modeSel }); // 求解途中改动
        await pumpTimers();
        assert.equal(byId.get('export-btn').disabled, true, '迟到结果必须保持导出锁定');
        assert.equal(byId.get('stale-banner').hidden, false);
        assert.match(byId.get('solve-status').textContent, /已修改/);
        // 重新求解后恢复正常
        byId.get('solve-btn').click();
        await pumpTimers();
        assert.equal(byId.get('export-btn').disabled, false);
        assert.equal(byId.get('stale-banner').hidden, true);
        assert.match(byId.get('solve-status').textContent, /求解完成/);

        resolve({ downloads, json });
      } catch (e) {
        reject(e);
      }
    })();
  });
}

runSmoke().then((r) => {
  console.log('DOM 冒烟通过：下载文件', r.downloads.map(d => d.name).join(', '));
}).catch((e) => {
  console.error('DOM 冒烟失败:', e);
  process.exit(1);
});

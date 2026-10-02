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
    click() { (el.handlers.click || []).forEach(fn => fn({ target: el })); }
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

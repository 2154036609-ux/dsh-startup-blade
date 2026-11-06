/**
 * dsh-startup-blade —— 浏览器半边（启动动画本体）。
 *
 * 分镜（基准时长 2.4s，按 speed 缩放）：
 *   ① 0.00–0.20s  黑场落下，右缘一点刀鞘冷光
 *   ② 0.18–0.78s  拔刀：刀身自右下向左上出鞘，刀锋过处把黑幕划开一道（透出真实界面）
 *   ③ 0.78–1.10s  白闪 + 屏幕轻震，刀光在划过处留下残心线
 *   ④ 1.10–1.50s  黑幕整体溶解，火星沉降
 *   ⑤ 1.50s 起     定格：若用户放了定格图，就停在图上 hold 毫秒再淡出；没有就停在真实
 *                  界面上（那面壁纸此刻已经渲染完成，视觉上就是"定格在当前这一帧"）
 *
 * 设计上的三个硬约束：
 *   · **不挡操作**：动画期间吃掉点击/按键是为了"点一下跳过"，结束后整个浮层移除，不残留
 *     任何 pointer-events / z-index 污染。
 *   · **每次启动只播一次**：用 sessionStorage 记一次；同一次应用会话里刷新页面不重播。
 *   · **失败即退场**：配置取不到、canvas 起不来、脚本报错 —— 一律静默收摊，绝不让一个装饰
 *     性插件把界面卡在启动画面上。
 */

window.__ModuleLoader__.load({
  id: 'dsh-startup-blade',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** 与宿主 lib/index.js 的 BASE 逐字一致。 */
    const BASE = '/startup-blade';
    /** 一次应用会话只播一次（关掉窗口重开才会再播）。 */
    const PLAYED_KEY = 'dsh-startup-blade:played';
    /** 临时关闭开关：localStorage 里写 '1' 即不再播放。 */
    const OFF_KEY = 'dsh-startup-blade:off';

    /** 基准时间轴（ms，speed=1 时）。 */
    const T = {
      dawn: 200,     // ① 黑场 + 鞘光
      draw: 600,     // ② 拔刀
      flash: 320,    // ③ 白闪
      dissolve: 400, // ④ 溶解
      fade: 420,     // ⑤ 定格图淡出
    };

    const DEFAULTS = {
      enabled: true, speed: 1, hold: 620, accent: '#9fe8ff',
      mode: 'reveal', hasFrame: false, frame: null, hasClip: false, clip: null,
      hasArt: false, art: null,
    };

    let started = false;
    let finished = false;

    /* ────────────────────────────── 工具函数 ────────────────────────────── */

    function safeStorage(area) {
      try { return window[area]; } catch { return null; }
    }

    function readFlag(area, key) {
      const store = safeStorage(area);
      try { return store ? store.getItem(key) : null; } catch { return null; }
    }

    function writeFlag(area, key, value) {
      const store = safeStorage(area);
      try { if (store) store.setItem(key, value); } catch { /* 隐私模式：忽略 */ }
    }

    function reduceMotion() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    }

    /** 把 #rrggbb / #rgb 解析成 [r,g,b]，失败时用刀光默认色。 */
    function parseColor(hex) {
      const fallback = [159, 232, 255];
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return fallback;
      let s = m[1];
      if (s.length === 3) s = s.split('').map((c) => c + c).join('');
      return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    }

    function rgba(rgb, alpha) {
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    /** 缓动：先快后慢，拔刀需要"甩"出去的手感。 */
    function easeOutCubic(t) { return 1 - Math.pow(1 - clamp01(t), 3); }
    function easeInOutQuad(t) { const x = clamp01(t); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

    /** 等待 document.body 出现（immediately 装载时可能还没有）。 */
    function whenBody(fn, deadline = 6000) {
      const begin = performance.now();
      const tick = () => {
        if (document.body) { fn(); return; }
        if (performance.now() - begin > deadline) { fn(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    }

    /**
     * 等界面真的画出来再开演。
     *
     * 为什么必须有这一步：`immediately` 装载意味着本模块可能比 SPA 首屏还早执行。
     * 若一上来就拉黑幕再划开，刀光过后露出的是**还没渲染的空壳**，观感是"启动动画
     * 结束后界面还要再加载一次"。所以先等到 #root 里出现子节点（= 界面已挂载），
     * 最多等 2.5s；等不到也照常开演，绝不因为对端结构变化就永不播。
     */
    function whenAppReady(fn, deadline = 2500) {
      const begin = performance.now();
      const ready = () => {
        const root = document.getElementById ? document.getElementById('root') : null;
        if (root && root.childElementCount > 0) return true;
        // 结构兜底：body 里除了自己之外已经有两层以上节点，视为已挂载
        return !!(document.body && document.body.childElementCount > 2);
      };
      const tick = () => {
        if (ready() || performance.now() - begin > deadline) { fn(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    }

    /* ────────────────────────────── 主流程 ────────────────────────────── */

    function boot() {
      if (started) return;
      started = true;

      if (readFlag('localStorage', OFF_KEY) === '1') return;
      if (readFlag('sessionStorage', PLAYED_KEY) === '1') return;
      try {
        if (new URLSearchParams(location.search).has('nosplash')) return;
      } catch { /* ignore */ }

      whenBody(() => {
        // 先把"已播"记上：即使动画中途抛错，也不会陷入每次刷新都重播的循环。
        writeFlag('sessionStorage', PLAYED_KEY, '1');
        fetch(`${BASE}/config`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((cfg) => {
            const conf = Object.assign({}, DEFAULTS, cfg && typeof cfg === 'object' ? cfg : {});
            if (!conf.enabled) return;
            whenAppReady(() => { start(conf).catch(() => teardown()); });
          });
      });
    }

    /** 创建两层画布并跑时间轴。 */
    async function start(conf) {
      // 有真实片段就优先播片段 —— 那是「人物真的在拔刀」的唯一保真通道。
      if (conf.mode === 'clip' && conf.clip) {
        return startClip(conf);
      }
      // 有分层素材就演「人物缓慢拔刀」：底图 + 刀身层沿刀轴抽出。
      if (conf.mode === 'art' && conf.art) {
        return startArt(conf);
      }
      const accent = parseColor(conf.accent);
      const speed = Math.min(2, Math.max(0.5, Number(conf.speed) || 1));
      const hold = Math.max(0, Math.min(4000, Number(conf.hold) || 0));
      const total = (T.dawn + T.draw + T.flash + T.dissolve) / speed;

      const overlay = document.createElement('div');
      overlay.setAttribute('data-dsh-startup-blade', '');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483000',
        'pointer-events:auto', 'background:transparent',
        'will-change:opacity', 'opacity:1',
        'contain:strict',
      ].join(';');

      const cut = document.createElement('canvas');   // 黑幕 + 划开痕迹（持久，不清屏）
      const fx = document.createElement('canvas');    // 刀光/火星/白闪/定格图（每帧重画）
      for (const c of [cut, fx]) {
        c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
        overlay.appendChild(c);
      }
      document.body.appendChild(overlay);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let W = Math.max(1, window.innerWidth);
      let H = Math.max(1, window.innerHeight);
      const size = () => {
        W = Math.max(1, window.innerWidth);
        H = Math.max(1, window.innerHeight);
        for (const c of [cut, fx]) {
          c.width = Math.round(W * dpr);
          c.height = Math.round(H * dpr);
        }
        ctxCut.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctxFx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      const ctxCut = cut.getContext('2d');
      const ctxFx = fx.getContext('2d');
      if (!ctxCut || !ctxFx) { teardown(); return; }
      size();

      // 黑幕一次画好；之后只做 destination-out 的"划开"。
      ctxCut.fillStyle = '#000';
      ctxCut.fillRect(0, 0, W, H);

      // 定格图（有就预载；失败就当没有，退回纯揭示）。
      let frozen = null;
      if (conf.mode === 'freeze' && conf.frame) {
        frozen = await loadImage(conf.frame).catch(() => null);
      }

      // 不动效偏好：直接淡出，不玩刀光。
      if (reduceMotion()) {
        return new Promise((resolve) => {
          overlay.animate
            ? overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' })
              .finished.then(() => { teardown(); resolve(); })
            : setTimeout(() => { teardown(); resolve(); }, 260);
        });
      }

      // 切口：沿刀锋方向的一条斜线（右下 → 左上）。
      const from = { x: W * 1.06, y: H * 0.9 };
      const to = { x: W * -0.06, y: H * 0.08 };
      const dir = Math.atan2(to.y - from.y, to.x - from.x);
      const len = Math.hypot(to.x - from.x, to.y - from.y);

      const bladeLen = Math.min(len * 0.62, H * 0.95);
      const sparks = [];
      let lastTip = null;
      let shaken = { x: 0, y: 0 };

      const t0 = performance.now();
      let raf = 0;

      const onSkip = () => finishFast();
      window.addEventListener('pointerdown', onSkip, true);
      window.addEventListener('keydown', onSkip, true);

      function finishFast() {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointerdown', onSkip, true);
        window.removeEventListener('keydown', onSkip, true);
        cancelAnimationFrame(raf);
        teardown();
      }

      function frame(now) {
        if (finished) return;
        const t = (now - t0) * speed;

        ctxFx.clearRect(0, 0, W, H);

        /* ① 黑场 + 刀鞘冷光 */
        const dawn = clamp01(t / T.dawn);
        if (t < T.dawn + 180) {
          const a = 1 - dawn;
          const g = ctxFx.createLinearGradient(W * 0.86, H * 0.2, W * 0.98, H * 0.85);
          g.addColorStop(0, rgba(accent, 0));
          g.addColorStop(0.5, rgba(accent, 0.28 * a));
          g.addColorStop(1, rgba(accent, 0));
          ctxFx.fillStyle = g;
          ctxFx.fillRect(W * 0.8, 0, W * 0.2, H);
        }

        /* ② 拔刀：刀身沿斜线扫出 */
        const drawP = clamp01((t - T.dawn) / T.draw);
        if (drawP > 0 && drawP < 1) {
          const tipT = easeOutCubic(drawP);
          const tip = { x: from.x + (to.x - from.x) * tipT, y: from.y + (to.y - from.y) * tipT };
          const tailT = Math.max(0, tipT - bladeLen / len);
          const tail = { x: from.x + (to.x - from.x) * tailT, y: from.y + (to.y - from.y) * tailT };

          // 屏幕轻震：随刀速衰减
          const shakeAmp = 5 * Math.sin(drawP * Math.PI);
          shaken = { x: (Math.random() - 0.5) * shakeAmp, y: (Math.random() - 0.5) * shakeAmp };
          ctxFx.save();
          ctxFx.translate(shaken.x, shaken.y);

          drawBlade(ctxFx, tail, tip, dir, accent, drawP);
          spawnSparks(sparks, tip, dir, drawP);
          drawSparks(ctxFx, sparks, accent);

          ctxFx.restore();

          // 刀锋过处把黑幕划开（destination-out）
          if (lastTip) {
            cutOpen(ctxCut, lastTip, tip, 22 + 26 * drawP);
          }
          lastTip = tip;
        }

        /* ③ 白闪 + 残心线 */
        if (t >= T.dawn + T.draw && t < T.dawn + T.draw + T.flash) {
          const p = clamp01((t - T.dawn - T.draw) / T.flash);
          const a = Math.pow(1 - p, 2) * 0.85;
          const cx = W * 0.45, cy = H * 0.42;
          const r = Math.max(W, H) * (0.15 + 0.55 * easeOutCubic(p));
          const g = ctxFx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, `rgba(255,255,255,${a})`);
          g.addColorStop(0.45, rgba(accent, a * 0.35));
          g.addColorStop(1, rgba(accent, 0));
          ctxFx.fillStyle = g;
          ctxFx.fillRect(0, 0, W, H);

          // 残心：一条细长的过刀痕
          const lineA = Math.pow(1 - p, 1.6) * 0.5;
          ctxFx.save();
          ctxFx.globalCompositeOperation = 'lighter';
          ctxFx.strokeStyle = `rgba(255,255,255,${lineA})`;
          ctxFx.lineWidth = 1.4;
          ctxFx.shadowColor = rgba(accent, lineA);
          ctxFx.shadowBlur = 18;
          ctxFx.beginPath();
          ctxFx.moveTo(from.x, from.y);
          ctxFx.lineTo(to.x, to.y);
          ctxFx.stroke();
          ctxFx.restore();
        }

        /* ④ 黑幕溶解 + 尘埃沉降 */
        if (t >= T.dawn + T.draw) {
          const p = clamp01((t - T.dawn - T.draw) / T.dissolve);
          ctxCut.save();
          ctxCut.globalCompositeOperation = 'destination-out';
          ctxCut.fillStyle = `rgba(0,0,0,${0.55 * p})`;
          ctxCut.fillRect(0, 0, W, H);
          ctxCut.restore();
        }

        drawSparks(ctxFx, sparks, accent);

        /* ⑤ 定格 */
        if (t >= total) {
          if (frozen) {
            drawFrozen(ctxFx, frozen, W, H, 1 - clamp01((t - total) / 260));
          }
          // 暗角，让"定格"更像一句收尾
          drawVignette(ctxFx, W, H, 0.45 * clamp01((t - total) / 260));

          if (t >= total + hold) {
            // 定格图淡出，露出真实界面（壁纸就在下面，视觉上无缝）
            const out = clamp01((t - total - hold) / T.fade);
            if (frozen) drawFrozen(ctxFx, frozen, W, H, 0, 1 - out);
            overlay.style.opacity = String(1 - out);
            if (out >= 1) { finishFast(); return; }
          }
        }

        raf = requestAnimationFrame(frame);
      }

      raf = requestAnimationFrame(frame);

      // 兜底：任何异常路径下最多 12s 必须收摊
      setTimeout(() => finishFast(), 12000);
    }

    /**
     * 播真实片段（录屏 / 渲染好的 mp4·webm）。
     *
     * 为什么需要这条通道：壁纸里的「人物」通常是 Wallpaper Engine 的骨骼（puppet）场景，
     * 拔刀的动作存在 `.mdl` 骨骼里，**没有任何可直接取用的视频素材**。要让启动动画里是
     * 同一个角色真的把刀拔出来，最靠谱的做法是把那段画面录成 3~5 秒的片段，交给这里播。
     *
     * 行为：整段放完 → 停在最后一帧 hold 毫秒（这就是「定格」）→ 淡出露出真实界面。
     * 点击/按键可立即跳过；片段解码失败则退回刀光版，绝不留一块黑屏。
     */
    function startClip(conf) {
      return new Promise((resolve) => {
        const hold = Math.max(0, Math.min(4000, Number(conf.hold) || 0));
        const overlay = document.createElement('div');
        overlay.setAttribute('data-dsh-startup-blade', '');
        overlay.style.cssText = [
          'position:fixed', 'inset:0', 'z-index:2147483000',
          'pointer-events:auto', 'background:#000', 'opacity:1',
          'will-change:opacity', 'contain:strict',
        ].join(';');

        const video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.preload = 'auto';
        video.src = conf.clip;
        video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
          + 'opacity:0;transition:opacity 200ms linear;background:#000;';
        overlay.appendChild(video);
        document.body.appendChild(overlay);

        let finished = false;
        let timer = 0;
        const cleanup = () => {
          window.removeEventListener('pointerdown', onSkip, true);
          window.removeEventListener('keydown', onSkip, true);
          clearTimeout(timer);
        };

        function finish() {
          if (finished) return;
          finished = true;
          cleanup();
          try { video.pause(); } catch { /* 已卸载 */ }
          teardown();
          resolve();
        }

        function onSkip() {
          if (finished) return;
          finished = true;
          cleanup();
          try { video.pause(); } catch { /* ignore */ }
          overlay.style.transition = 'opacity 180ms linear';
          overlay.style.opacity = '0';
          setTimeout(() => { teardown(); resolve(); }, 220);
        }

        const fadeOut = (ms) => {
          overlay.style.transition = `opacity ${ms}ms linear`;
          overlay.style.opacity = '0';
          timer = setTimeout(finish, ms + 40);
        };

        function onError() {
          if (finished) return;
          finished = true;
          cleanup();
          teardown();
          // 退回刀光版：装饰性插件不允许把界面卡在黑屏上。
          start(Object.assign({}, conf, { mode: 'reveal', clip: null })).catch(() => teardown());
          resolve();
        }

        window.addEventListener('pointerdown', onSkip, true);
        window.addEventListener('keydown', onSkip, true);
        video.addEventListener('playing', () => { video.style.opacity = '1'; }, { once: true });
        video.addEventListener('ended', () => { timer = setTimeout(() => fadeOut(420), hold); }, { once: true });
        video.addEventListener('error', onError, { once: true });

        const playing = video.play && video.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => onError());

        // 兜底：片段再长也不拖过 15 秒
        setTimeout(() => { if (!finished) fadeOut(200); }, 15000);
      });
    }

    /** 取 JSON（失败返回 null）。 */
    async function fetchJson(url) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }

    /**
     * 分层「缓慢拔刀」。
     *
     * 素材是同一张壁纸拆出来的两层：`base`（刀身被压暗，像还插在鞘里）与 `blade`
     * （透明底的发光刀身）。时间轴：
     *
     *   ① 0.00–0.32s  黑场淡入，镜头推近，人物只在暗部里
     *   ② 0.32–2.52s  **缓慢拔刀**：一条沿刀轴的裁切带从刀镡往刀尖推进，刀身随之被"拉出来"；
     *                 同时整体亮度从 8% 抬到全亮，镜头 1.10 → 1.00 回正，落雪飘过
     *   ③ 2.52s 起     定格（原图状态），保持 hold 毫秒
     *   ④ 之后        淡出露出真实界面
     *
     * 关键取舍：不做整图位移（那会露出被刀盖住的空白），只做"沿刀轴的显影 + 微量抽出"，
     * 观感是刀从鞘里被慢慢抽出来，而不是把一张图整体平移。
     */
    /**
     * 分层「缓慢拔刀」（暗版 / 亮版 + 沿刀轴扫光）。
     *
     * 早期版本是把刀单独抠成 PNG 再平移，但刀与袖子、护手在同一片色域里，
     * 抠出来必然带碎片（用户实测右下角出现"撕纸"）。现在改成**不做任何抠图**：
     *
     *   · dark.jpg 整幅压暗到 22% —— 暗场里的刀像还插在鞘中
     *   · lit.jpg  原始亮度 —— 刀光真正亮起后的样子
     *
     * 时间轴：黑场 → 沿刀轴从刀镡向刀尖"扫"出亮版（扫过的区域就是刀被抽出的部分），
     * 扫到刀尖后整幅交叉淡入亮版 → 定格 → 淡出。前缘始终压一条辉光，既像刀光，
     * 又刚好把亮/暗交界那条硬边盖住。
     */
    async function startArt(conf) {
      let meta = null;
      let dark = null;
      let lit = null;
      try {
        meta = await fetchJson(conf.art.meta);
        dark = await loadImage(conf.art.dark);
        lit = await loadImage(conf.art.lit);
      } catch { /* 落到下面的回退 */ }
      if (!meta || !dark || !lit || !meta.width || !meta.height) {
        return start(Object.assign({}, conf, { mode: 'reveal', art: null }));
      }

      const speed = Math.min(2, Math.max(0.5, Number(conf.speed) || 1));
      const hold = Math.max(0, Math.min(4000, Number(conf.hold) || 0)) || 700;
      const ENTER = 320;
      const DRAW = 2200;
      const FADE = 450;
      const iw = meta.width;
      const ih = meta.height;

      const overlay = document.createElement('div');
      overlay.setAttribute('data-dsh-startup-blade', '');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483000',
        'pointer-events:auto', 'background:#05070b', 'opacity:1',
        'will-change:opacity', 'contain:strict',
      ].join(';');

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
      overlay.appendChild(canvas);
      document.body.appendChild(overlay);

      const ctx = canvas.getContext('2d');
      if (!ctx) { teardown(); return; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let W = 1;
      let H = 1;
      const resize = () => {
        W = Math.max(1, window.innerWidth);
        H = Math.max(1, window.innerHeight);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      };
      resize();
      window.addEventListener('resize', resize);

      // 落雪（图像坐标）
      const snow = Array.from({ length: 70 }, () => ({
        x: Math.random() * iw,
        y: Math.random() * ih,
        r: 0.8 + Math.random() * 2.2,
        vy: 12 + Math.random() * 26,
        vx: -6 - Math.random() * 12,
        a: 0.18 + Math.random() * 0.4,
      }));

      // 刀轴（图像坐标）
      const Hp = { x: meta.bx * iw, y: meta.by * ih };   // 刀镡端
      const Tp = { x: meta.ax * iw, y: meta.ay * ih };   // 刀尖端
      const dx = Tp.x - Hp.x;
      const dy = Tp.y - Hp.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const bandHalf = 300;                              // 扫光带半宽（够覆盖刀身+两侧过渡）

      let finished = false;
      let raf = 0;
      let last = 0;
      const t0 = performance.now();

      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointerdown', onSkip, true);
        window.removeEventListener('keydown', onSkip, true);
        window.removeEventListener('resize', resize);
        cancelAnimationFrame(raf);
        teardown();
      };

      function onSkip() {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointerdown', onSkip, true);
        window.removeEventListener('keydown', onSkip, true);
        window.removeEventListener('resize', resize);
        cancelAnimationFrame(raf);
        overlay.style.transition = 'opacity 200ms linear';
        overlay.style.opacity = '0';
        setTimeout(() => teardown(), 240);
      }
      window.addEventListener('pointerdown', onSkip, true);
      window.addEventListener('keydown', onSkip, true);

      function frame(now) {
        if (finished) return;
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
        last = now;
        const t = (now - t0) * speed;

        const enter = clamp01(t / ENTER);
        const draw = clamp01((t - ENTER) / DRAW);
        const eased = easeInOutQuad(draw);
        const litAll = clamp01((draw - 0.72) / 0.28);   // 扫到后段后整幅抬亮

        // 镜头：推近 1.10 → 1.00
        const zoom = 1 + 0.10 * (1 - eased);
        const fit = Math.max(W / iw, H / ih) * zoom;
        const dw = iw * fit;
        const dh = ih * fit;
        // 关键：把可视窗口钳制在画面内部，任何时刻都不留黑边
        const ox = Math.min(0, Math.max(W - dw, W / 2 - 0.52 * dw));
        const oy = Math.min(0, Math.max(H - dh, H / 2 - 0.34 * dh));

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(ox, oy);
        ctx.scale(fit, fit);

        // ① 暗场
        ctx.drawImage(dark, 0, 0, iw, ih);

        // ② 扫光：裁切带沿刀轴推进，带内换成亮版
        if (draw > 0) {
          const reveal = easeOutCubic(draw);
          const front = { x: Hp.x + ux * len * reveal, y: Hp.y + uy * len * reveal };
          const back = { x: Hp.x - ux * 40, y: Hp.y - uy * 40 };
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(back.x + nx * bandHalf, back.y + ny * bandHalf);
          ctx.lineTo(front.x + nx * bandHalf, front.y + ny * bandHalf);
          ctx.lineTo(front.x - nx * bandHalf, front.y - ny * bandHalf);
          ctx.lineTo(back.x - nx * bandHalf, back.y - ny * bandHalf);
          ctx.closePath();
          ctx.clip();
          ctx.globalAlpha = 0.35 + 0.65 * reveal;
          ctx.drawImage(lit, 0, 0, iw, ih);
          ctx.restore();

          // 前缘刀光：一条压住亮/暗交界的辉光
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(front.x, front.y, 0, front.x, front.y, 150);
          g.addColorStop(0, `rgba(180,240,255,${0.55 * (1 - reveal * 0.45)})`);
          g.addColorStop(1, 'rgba(90,190,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(front.x, front.y, 150, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // ③ 整幅抬亮（扫到后段，暗版之上叠亮版）
        if (litAll > 0) {
          ctx.save();
          ctx.globalAlpha = litAll * 0.96;
          ctx.drawImage(lit, 0, 0, iw, ih);
          ctx.restore();
        }

        // ④ 落雪
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of snow) {
          s.y += s.vy * dt;
          s.x += s.vx * dt;
          if (s.y > ih + 8) { s.y = -8; s.x = Math.random() * iw; }
          if (s.x < -8) s.x = iw + 8;
          ctx.fillStyle = `rgba(215,236,255,${s.a * (0.5 + 0.5 * (1 - litAll))})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        ctx.restore();

        // ⑤ 入场黑场 + 暗角
        if (enter < 1) {
          ctx.fillStyle = `rgba(0,0,0,${1 - enter})`;
          ctx.fillRect(0, 0, W, H);
        }
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.85);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, `rgba(0,0,0,${0.5 - 0.32 * litAll})`);
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);

        // ⑥ 定格 → 淡出
        const total = ENTER + DRAW;
        if (t >= total + hold) {
          const out = clamp01((t - total - hold) / FADE);
          overlay.style.opacity = String(1 - out);
          if (out >= 1) { finish(); return; }
        }

        raf = requestAnimationFrame(frame);
      }

      raf = requestAnimationFrame(frame);
      setTimeout(() => { if (!finished) finish(); }, 20000);
    }

    /* ────────────────────────────── 绘制 ────────────────────────────── */

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('frame load failed'));
        img.src = src;
      });
    }

    /** 在持久黑幕上擦出一道软边切口（destination-out）。 */
    function cutOpen(ctx, a, b, width) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      // 主切口：实心细带
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineCap = 'round';
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // 羽化：更宽的一条低透明度带，避免切边像刀切豆腐
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = width * 2.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    /** 画刀身：一个由刀尖到刀柄渐细的锥形 + 高光芯 + 刀镡。 */
    function drawBlade(ctx, tail, tip, angle, accent, progress) {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const nx = -dy, ny = dx;
      const halfW = Math.max(3, Math.min(tail && tip ? Math.hypot(tip.x - tail.x, tip.y - tail.y) * 0.012 : 4, 9));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 刀体（锥形）
      const g = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.35, `rgba(255,255,255,${0.55 + 0.35 * progress})`);
      g.addColorStop(0.86, 'rgba(255,255,255,0.98)');
      g.addColorStop(1, rgba(accent, 0.95));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(tail.x + nx * halfW * 0.35, tail.y + ny * halfW * 0.35);
      ctx.lineTo(tip.x + nx * 0.6, tip.y + ny * 0.6);
      ctx.lineTo(tip.x - nx * 0.6, tip.y - ny * 0.6);
      ctx.lineTo(tail.x - nx * halfW * 0.35, tail.y - ny * halfW * 0.35);
      ctx.closePath();
      ctx.fill();

      // 刀光外晕
      ctx.strokeStyle = rgba(accent, 0.5);
      ctx.lineWidth = 1.2;
      ctx.shadowColor = rgba(accent, 0.85);
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      // 刀镡：刀柄与刀身交界处的一枚小圆环
      const guard = { x: tail.x, y: tail.y };
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(guard.x, guard.y, halfW * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      // 刀柄：一小段深色
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(18,22,30,0.85)';
      ctx.lineWidth = halfW * 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(guard.x, guard.y);
      ctx.lineTo(guard.x - dx * 34, guard.y - dy * 34);
      ctx.stroke();

      ctx.restore();
    }

    /** 刀尖擦出的火星。 */
    function spawnSparks(list, tip, angle, progress) {
      if (list.length > 120) return;
      const count = 3;
      for (let i = 0; i < count; i++) {
        const spread = (Math.random() - 0.5) * 1.5;
        const a = angle + Math.PI + spread;
        const v = 90 + Math.random() * 260 * (0.4 + progress);
        list.push({
          x: tip.x, y: tip.y,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          life: 1, decay: 0.9 + Math.random() * 1.4,
          size: 0.8 + Math.random() * 1.8,
        });
      }
    }

    function drawSparks(ctx, list, accent) {
      if (list.length === 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        s.x += s.vx * 0.016;
        s.y += s.vy * 0.016;
        s.vy += 520 * 0.016;     // 重力
        s.vx *= 0.985;
        s.life -= s.decay * 0.016;
        if (s.life <= 0) { list.splice(i, 1); continue; }
        ctx.fillStyle = rgba(accent, 0.9 * s.life);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * (0.4 + s.life), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /** 定格图 cover 铺满，可指定透明度与缩放。 */
    function drawFrozen(ctx, img, W, H, alpha = 1, scale = 0) {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (!iw || !ih) return;
      const k = Math.max(W / iw, H / ih) * (1 + 0.02 * (1 - Math.min(1, scale + 1)));
      const dw = iw * k, dh = ih * k;
      ctx.save();
      ctx.globalAlpha = clamp01(alpha);
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }

    function drawVignette(ctx, W, H, alpha) {
      if (alpha <= 0) return;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.78);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${clamp01(alpha)})`);
      ctx.save();
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* ────────────────────────────── 收尾 ────────────────────────────── */

    function teardown() {
      const el = document.querySelector('[data-dsh-startup-blade]');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    // 契约：DSH 会把 host 侧的插件行跑起来；浏览器侧若被显式 apply 就立即开工。
    // 同时留一个兜底 —— 某些宿主版本只加载模块不调 apply，动画同样要出得来。
    exports.apply = () => { try { boot(); } catch { teardown(); } };
    exports.inject = [];
    setTimeout(() => { try { boot(); } catch { teardown(); } }, 0);

    return module.exports;
  },
});

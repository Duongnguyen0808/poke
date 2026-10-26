// ==UserScript==
// @name         PokeSurvivor Bot
// @author       Duongnguyen0808
// @homepageURL  https://github.com/Duongnguyen0808/poke
// @match        https://pokesurvivor.doofcraft.com/*
// @match        https://pokesurvivor.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// PokeSurvivor Bot — https://github.com/Duongnguyen0808/poke
// MIT License (xem LICENSE): dùng lại / chỉnh sửa thì phải giữ dòng bản quyền và giấy phép.
//
// Paste into DevTools Console, install as a Tampermonkey userscript, or load this folder as a Chrome extension (manifest.json).
// F6 = danh mục mọi sprite (ảnh + chỉ số + nút gắn nhãn) · F7 = gắn nhãn bằng click (1 tốt / 2 nguy hiểm / 3 rift / 4 vật cản / 5 buff / 6 kinh nghiệm / 7 vali / 0 xoá)
// F8 = bật/tắt bot · F9 = overlay · PSBot.catalog() = in + copy danh mục · PSBot.tags() = xem nhãn đã lưu
// PSBot.exportConfig() / nút "Xuất data.js" (F6) = tải data.js chứa nhãn + build; chép đè vào thư mục extension để máy khác có sẵn
// While loaded, Firestore/RTDB writes whose path matches CFG.rankRe are replaced by no-ops.
// Reload the page to play normally (unblocked) again.
(function start() {
  // Capture game instance via canvas assignment on GameHost / bd prototype
  try {
    if (!window.__psGameHooked) {
      window.__psGameHooked = true;
      Object.defineProperty(Object.prototype, 'canvas', {
        set(val) {
          if (val instanceof HTMLCanvasElement && (val.id === 'game' || val.classList?.contains('ps-canvas'))) {
            window.__psGame = this;
          }
          Object.defineProperty(this, 'canvas', { value: val, writable: true, configurable: true, enumerable: true });
        },
        get() { return undefined; },
        configurable: true
      });
    }
  } catch {}

  // Wait until document.body is available so UI can attach immediately on menu
  if (!document.body) return void setTimeout(start, 200);
  if (window.PSBot) window.PSBot.unload();
  // Keep VERSION equal to "version" in manifest.json: a higher version on GitHub shows the update notice
  const VERSION = '1.2.0';
  const REPO = 'https://github.com/Duongnguyen0808/poke';

  const CFG = {
    // Each frame one target is chosen: rift > good item (within goodRange) > nearest enemy.
    contact: 40,          // world units (from enemy edge): safe buffer distance kept from monsters
    engage: 140,          // world units: distance kept from the targeted enemy while fighting it (ranged kiting)
    huntWeight: 3,
    goodRange: 2200,      // world units: good items (chests, potions) within this become the target
    goodWeight: 16,
    riftWeight: 18,
    magnet: 100,          // world units: initial XP pickup radius; re-learned while playing (state.magnet)
    xpRange: 900,         // world units: XP orbs within this (but outside the pickup radius) become the target
    xpWeight: 8,
    caseReach: 25,        // world units: player must stand on top of a suitcase ("case" tag) to open it
    caseTime: 5500,       // ms of (unpaused) game time to stay next to a suitcase
    buffReach: 80,        // world units: this close to a buff shrine (gem pillar) counts as "visited"
    buffCooldown: 30000,  // ms before going back to the same shrine
    lookahead: 140,       // world units: how far ahead each candidate direction is evaluated
    aim: false,           // true = move the mouse cursor onto the nearest enemy (if moves aim at the cursor)
    hazardMargin: 50,     // world units added around hazard effects
    autoTelegraph: true,  // Automatically detect boss attack telegraphs, red beams, laser lines and warning zones
    enemyRe: /(?:\/sprites\/|\/assets\/pokemon\/)(?:[^\/]+\/)*(?!Faint)[a-zA-Z0-9_-]+\.png/i,
    // src -> 'good' | 'hazard' | 'rift' | 'wall' | 'buff' | 'safe'; edit with F6/F7, saved in localStorage
    tags: {
      'fill:#7b3cff': 'rift',
      'fill:#a855f7': 'rift',
      'fill:#8b5cf6': 'rift',
      'fill:#9333ea': 'rift',
      'fill:#7c3aed': 'rift',
      'fill:#c084fc': 'rift',
      'fill:#6d28d9': 'rift',
    },
    autoPick: true,
    // Consumable item slots (hotkeys 5-8): pressed blindly while a run is unpaused, so any item gets used at once
    useItems: true,
    itemKeys: ['5', '6', '7', '8'],
    itemEvery: 1000,      // ms between presses
    // Only the active move fires: cycle it (E = next) so every move's cooldown gets used
    swapSkills: true,
    swapEvery: 10,        // ms between switches; the bot loop runs once per frame (~16 ms), so below that = every frame
    // Held items to drop for any other item, even an unknown one
    swapAwayItems: ['choice band', 'life orb'],
    // Held items ("An item! You can only hold one"): higher = better. The site lists them unranked,
    // so this ranking favours damage/cooldown, then survival, then utility. Edit freely.
    itemScores: {
      'shell bell': 100,    // heal 4% of damage dealt ("nấm vàng hồi máu" - giữ vĩnh viễn, tuyệt đối không đổi)
      'quick claw': 9,      // -20% cooldown on every move, no downside
      'leftovers': 7,       // 1.5% max HP/s regen
      'assault vest': 7,    // -20% damage taken
      'focus sash': 6,      // survive a KO hit once per 60 s
      'lucky egg': 6,       // +30% XP -> more levels
      'choice scarf': 5,    // +35% speed
      'amulet coin': 4,     // more coins at the end of the run, no combat effect
      'rocky helmet': 3,    // only punishes melee attackers
      'choice band': 0,     // +40% damage, but locks moves (breaks E skill cycling): only when nothing else is offered
      'life orb': -100,     // tuyệt đối không chọn (tăng dame mà đánh mất máu)
    },
    // Card text that marks "this pick unlocks the evolution of a maxed skill" (adjust once the real wording is known)
    evoRe: /evol|evoluc|awaken|despert|unlock|desbloq|tiến hoá|★|⭐/i,
    maxSkills: 2,         // total active skills (incl. the starting one) when the pokémon has no build
    // Pokémon name (as shown in the HUD, lower-case) -> moves in priority order. Build moves are always
    // taken/levelled first; moves outside the build are avoided. Set them in the "Moveset" popup (saved to data.js on export).
    builds: {},
    // Auto replay: when no run is active, click the first visible button matching these, in order
    autoRestart: true,
    restartSteps: [
      /^(play again|try again|retry|restart|jugar de nuevo|volver a jugar|reintentar|otra vez|chơi lại)$/i,
      /^(back to menu|volver al men[uú]|về menu|exit|thoát)$/i,
      /^(solo)$/i,
      /^(hyper)$/i,
      /^(play|jugar|chơi)$/i,
      /^(start|go!?|let'?s go|comenzar|empezar|bắt đầu)$/i,
      /^(back|menu|volver|ok|aceptar|close|cerrar|đóng|continue|tiếp tục)$/i,
    ],
    restartAvoid: /together|juntos|friend|amigo|gacha|shop|tienda|log ?out|sign|link|delete|borrar|revive|revivir|gem|buy|comprar|halloween/i,
    gameMode: 'hyper',    // 'hyper' (mặc định) | 'normal' | 'waves'
    background: true,     // keep the game running when the tab is hidden / window covered (see "keep running")
    blockRank: true,
    rankRe: /rank|leader|board|score|season/i,
    logNet: true,
  };

  const getCanvas = () => {
    return document.getElementById('game') ||
           document.querySelector('canvas.ps-canvas') ||
           document.querySelector('.ps-game canvas') ||
           document.querySelector('canvas:not(.backdrop):not([data-psbot-ui])');
  };
  const isGameCanvas = ctx => {
    const cv = getCanvas();
    return !!cv && ctx.canvas === cv;
  };
  const state = {
    // Idle until ▶ Chạy in the control panel (or F8); target = runs to play (0 = forever), done = runs finished
    on: true, target: 0, done: 0, debug: true, keys: {}, dir: null, frame: [], lastFrame: [], texts: [], hudTexts: new Set(),
    posHist: [], walls: [], ignore: [], stuck: [], escape: null, pickAt: 0, netBlocked: 0, picks: {}, newSkills: 0,
    magnet: CFG.magnet, prevXp: [], slotX: {}, slotMoves: {}, playerMoves: [], hasBonded: false, bondedSlot: 0, lastBondedAt: 0, riftSlotAt: 0, bondedLockAt: 0, runCounted: false,
    currentMon: '', insideRift: false, insideRiftAt: 0, water: [], waterPoints: [], waterRipples: [],
    lastPos: null, immobileSince: 0, unstuckMode: false, unstuckDir: null, unstuckIdx: 0, unstuckDirChangedAt: 0, stuckPos: null, failedDirs: [], prevBulletMap: null,
    mission: null, missions: [], cageDwell: null, cageIndicator: null, objIndicator: null, objDwell: null, dwell: null,
  };
  const log = (...a) => console.log('%c[PSBot]', 'color:#7cf', ...a);
  // Priority: defaults above < data.js (bundled with the extension, same on every machine) < localStorage (this browser)
  const DATA = window.PSBotData || {};
  Object.assign(CFG.tags, DATA.tags);
  const userBuilds = { ...DATA.builds };
  const TAG_KEY = 'psbot.tags';
  try { Object.assign(CFG.tags, JSON.parse(localStorage.getItem(TAG_KEY) || '{}')); } catch {}
  delete CFG.tags['canvas:16x14'];
  delete CFG.tags['canvas:24x20'];
  const saveTags = () => { try { localStorage.setItem(TAG_KEY, JSON.stringify(CFG.tags)); } catch {} };
  saveTags();
  const BUILD_KEY = 'psbot.builds';
  try { Object.assign(userBuilds, JSON.parse(localStorage.getItem(BUILD_KEY) || '{}')); } catch {}
  Object.assign(CFG.builds, userBuilds);
  for (const k in CFG.builds) if (!CFG.builds[k].length) delete CFG.builds[k];   // [] = build deleted on this machine

  // ---------- frame capture ----------
  const P = CanvasRenderingContext2D.prototype;
  const origDraw = P.drawImage, origArc = P.arc;
  // Offscreen canvases are keyed by size + pixel hash so same-sized sprites (chest vs bush) differ
  const canvasKeys = new WeakMap();
  const srcName = img => {
    if (img.src) return img.src.replace(location.origin, '');
    let k = canvasKeys.get(img);
    if (!k) {
      k = `canvas:${img.width}x${img.height}`;
      try {
        const d = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3] * 17) | 0;
        k += '#' + (h >>> 0).toString(36);
      } catch {}
      canvasKeys.set(img, k);
    }
    return k;
  };
  // Exact key first, then the size-only key (older tags / defaults)
  const tagOf = src => (src && typeof src === 'string') ? (CFG.tags[src] || CFG.tags[src.split('#')[0]]) : undefined;
  const record = (ctx, src, cx, cy, w, h, img, rect) => {
    const m = ctx.getTransform();
    state.frame.push({ src, x: m.a * cx + m.c * cy + m.e, y: m.b * cx + m.d * cy + m.f, w: w * m.a, h: h * m.d, s: m.a, e: m.e, f: m.f, img, rect });
  };
  P.drawImage = function (img, ...a) {
    if (isGameCanvas(this)) {
      const [dx, dy, dw, dh] = a.length === 8 ? a.slice(4) : a.length === 4 ? a : [a[0], a[1], img.width, img.height];
      record(this, srcName(img), dx + dw / 2, dy + dh / 2, dw, dh, img, a.length === 8 ? a.slice(0, 4) : null);
    }
    return origDraw.call(this, img, ...a);
  };
  P.arc = function (x, y, r, a0, a1, ccw) {
    if (isGameCanvas(this)) addArc(this, x, y, r, r, 0, a0 ?? 0, a1 ?? (Math.PI * 2), ccw);
    return origArc.call(this, x, y, r, a0, a1, ccw);
  };
  // HUD text (move names, timer) tells which skills the player already owns
  const origText = P.fillText;
  P.fillText = function (text, ...a) {
    if (isGameCanvas(this)) {
      const s = String(text).trim();
      state.texts.push(s);
      const hpMatch = s.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (hpMatch) {
        state.hp = +hpMatch[1];
        state.maxHp = +hpMatch[2];
        if (state.maxHp > 0) state.hpRatio = state.hp / state.maxHp;
      }
      if (s && CFG.builds[s.toLowerCase()]) state.currentMon = s.toLowerCase();
      const x = a[0], y = a[1];
      const cv = this.canvas;
      const isHudY = typeof y === 'number' && cv && y > cv.height - 100;
      // Track slot number positions at bottom of screen
      if (/^[1-4]$/.test(s) && isHudY && typeof x === 'number') {
        state.slotX[+s] = x;
      }
      // Track move names drawn above slots at bottom of screen (e.g. "Meteor Mash")
      if (typeof y === 'number' && cv && y > cv.height - 160 && typeof x === 'number') {
        const sClean = s.replace(/\s*\+.*$/, '').trim();
        const movesList = (window.PSBotMoves?.moves) || [];
        const isMoveName = movesList.some(m => m.name.toLowerCase() === sClean.toLowerCase()) ||
                           Object.values(CFG.builds || {}).some(b => b.some(m => m.toLowerCase() === sClean.toLowerCase()));
        if (isMoveName) {
          let closestSlot = 0;
          let minDx = 75;
          for (let slot = 1; slot <= 4; slot++) {
            const sx = state.slotX[slot];
            if (sx !== undefined && Math.abs(x - sx) < minDx) {
              minDx = Math.abs(x - sx);
              closestSlot = slot;
            }
          }
          if (closestSlot) {
            state.slotMoves[closestSlot] = sClean;
            if (!state.playerMoves) state.playerMoves = [];
            state.playerMoves[closestSlot - 1] = sClean;
          }
        }
      }
      // Track bonded / combined move names (e.g. "Quick Attack +1", "Razor Leaf+", "Vine Whip+")
      // Any move with "+" drawn in HUD means bonded moves exist
      if (/\b[a-zA-Z]{3,}\s*\+/i.test(s) && isHudY && typeof x === 'number') {
        state.hasBonded = true;
        state.lastBondedAt = performance.now();
        state.bondedSlot = 1; // Luôn cố định chiêu 1 theo yêu cầu người dùng
      }
      if (/\b(?:melmetal)\b/i.test(s) || /\brift\b[^\d]*\d+:\d{2}/i.test(s)) {
        state.insideRift = true;
        state.insideRiftAt = performance.now();
        state.riftIndicator = null;
      } else if (/\brift\b/i.test(s) && /(?:\d+\s*m|\d+\s*s)\b/i.test(s)) {
        state.insideRift = false;
        const m = this.getTransform();
        const screenX = m.a * (a[0] || 0) + m.c * (a[1] || 0) + m.e;
        const screenY = m.b * (a[0] || 0) + m.d * (a[1] || 0) + m.f;
        state.riftIndicator = { x: screenX || m.e, y: screenY || m.f, text: s, at: performance.now() };
      }
      if (/\b(?:cage|caged|free.*pok[eé]mon)\b/i.test(s)) {
        const m = this.getTransform();
        if (m.e || m.f) state.cageIndicator = { x: m.e, y: m.f, text: s, at: performance.now() };
      }
      // Objective distance label drawn near indicator arrow (e.g. "Light the lanterns · 27 m" or "Minun · 48 m")
      const distMatch = s.match(/(?:·|\b)\s*(\d+)\s*m\b/i) || s.match(/(\d+)\s*m\s*$/i);
      if (distMatch) {
        const m = this.getTransform();
        const screenX = m.a * (a[0] || 0) + m.c * (a[1] || 0) + m.e;
        const screenY = m.b * (a[0] || 0) + m.d * (a[1] || 0) + m.f;
        const nowMs = performance.now();
        if (!state.activeIndicators) state.activeIndicators = [];
        state.activeIndicators = state.activeIndicators.filter(ind => nowMs - ind.at < 3000 && ind.text !== s);
        const item = {
          text: s,
          meters: +distMatch[1],
          sx: (screenX !== 0 || screenY !== 0) ? screenX : m.e,
          sy: (screenX !== 0 || screenY !== 0) ? screenY : m.f,
          arrowDir: null,
          arrowAt: 0,
          at: nowMs
        };
        state.activeIndicators.push(item);
        // Sort indicators by distance (closest objective first)
        state.activeIndicators.sort((i1, i2) => i1.meters - i2.meters);
        state.objIndicator = state.activeIndicators[0];
      }
    }
    return origText.call(this, text, ...a);
  };

  const origRotate = P.rotate;
  P.rotate = function (angle) {
    if (isGameCanvas(this)) {
      const m = this.getTransform();
      const cv = this.canvas;
      if (cv && m.e > cv.width * 0.35 && m.f < cv.height * 0.55) {
        state.hudRotateAngle = angle;
        state.hudRotateAt = performance.now();
      }
    }
    return origRotate.call(this, angle);
  };

  // Detect triangle mission arrow anywhere on screen (screen edges, corners, radar)
  const checkMissionArrow = (ctx, pts, style) => {
    if (!pts || pts.length !== 3) return;
    const cv = getCanvas();
    if (!cv) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const avgX = xs.reduce((a, b) => a + b, 0) / 3;
    const avgY = ys.reduce((a, b) => a + b, 0) / 3;

    const d01 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const d12 = Math.hypot(pts[1].x - pts[2].x, pts[1].y - pts[2].y);
    const d20 = Math.hypot(pts[2].x - pts[0].x, pts[2].y - pts[0].y);
    const minD = Math.min(d01, d12, d20);
    const maxD = Math.max(d01, d12, d20);
    if (maxD < 8 || maxD > 90) return; // realistic arrow size

    let tip, baseM;
    if (minD === d01) {
      tip = pts[2];
      baseM = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    } else if (minD === d12) {
      tip = pts[0];
      baseM = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 };
    } else {
      tip = pts[1];
      baseM = { x: (pts[2].x + pts[0].x) / 2, y: (pts[2].y + pts[0].y) / 2 };
    }
    const vx = tip.x - baseM.x, vy = tip.y - baseM.y;
    const len = Math.hypot(vx, vy);
    if (len > 3) {
      const dir = [vx / len, vy / len];
      const nowMs = performance.now();
      // Check purple triangle arrow pointing towards Rift portal
      const isPurple = typeof style === 'string' && /#(?:7b3cff|8b5cf6|9333ea|a855f7|7c3aed|c084fc|6d28d9|9945ff)/i.test(style);
      if (isPurple || (state.riftIndicator && Math.hypot(avgX - state.riftIndicator.x, avgY - state.riftIndicator.y) < 220)) {
        state.riftArrowDir = dir;
        state.riftArrowAt = nowMs;
        if (state.riftIndicator) {
          state.riftIndicator.arrowDir = dir;
          state.riftIndicator.arrowAt = nowMs;
        }
      }
      // Only associate triangle if it is close (< 160px) to a known distance indicator text
      if (state.activeIndicators && state.activeIndicators.length) {
        let matched = false;
        for (const ind of state.activeIndicators) {
          const dInd = Math.hypot(avgX - ind.sx, avgY - ind.sy);
          if (dInd < 160) {
            ind.arrowDir = dir;
            ind.arrowAt = nowMs;
            matched = true;
          }
        }
        if (matched) {
          state.missionArrow = { dir, x: avgX, y: avgY, at: nowMs };
        }
      }
    }
  };

  // Attack telegraphs (lines, beams, circles, cones) are drawn as paths, not sprites.
  // Path points are tracked in screen space; on fill/stroke the shape is recorded as
  // a frame item with geometry (poly / line) keyed "fill:<style>" or "stroke:<style>".
  const PATH = { subs: [], cur: null };
  const pathOrig = { beginPath: P.beginPath, moveTo: P.moveTo, lineTo: P.lineTo, rect: P.rect, ellipse: P.ellipse, fill: P.fill, stroke: P.stroke, fillRect: P.fillRect, clip: P.clip };
  const tp = (ctx, x, y) => { const m = ctx.getTransform(); return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; };
  const addPt = (ctx, x, y, fresh) => {
    if (fresh || !PATH.cur) PATH.subs.push(PATH.cur = []);
    PATH.cur.push(tp(ctx, x, y));
  };
  const addArc = (ctx, x, y, rx, ry, rot, a0, a1, ccw) => {
    let span = ccw ? a0 - a1 : a1 - a0;
    while (span < 0) span += Math.PI * 2;
    while (span > Math.PI * 2 + 1e-5) span -= Math.PI * 2;
    if (span < 1e-5 && a0 !== a1) span = Math.PI * 2;
    const n = Math.max(12, Math.ceil(span / (Math.PI / 12)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (ccw ? -1 : 1) * span * i / n;
      const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
      addPt(ctx, x + ex * Math.cos(rot) - ey * Math.sin(rot), y + ex * Math.sin(rot) + ey * Math.cos(rot));
    }
  };
  const styleKey = s => typeof s === 'string' ? s.replace(/\s+/g, '') : 'gradient';
  const recordShape = (ctx, kind, pts, style) => {
    const m = ctx.getTransform();
    const s = Math.hypot(m.a, m.b);
    if ((m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0) || pts.length < 2) return; // HUD / UI is untransformed
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const lw = kind === 'line' ? ctx.lineWidth * s : 0;
    if ((x1 - x0 + lw) * (y1 - y0 + lw) < 150) return;              // ignore tiny particles
    state.frame.push({ src: `${kind === 'line' ? 'stroke' : 'fill'}:${styleKey(style)}`, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0 + lw, h: y1 - y0 + lw,
      s, e: m.e, f: m.f, shape: kind, pts, lw, alpha: ctx.globalAlpha });
  };
  P.beginPath = function () { if (isGameCanvas(this)) { PATH.subs = []; PATH.cur = null; } return pathOrig.beginPath.call(this); };
  P.moveTo = function (x, y) { if (isGameCanvas(this)) addPt(this, x, y, true); return pathOrig.moveTo.call(this, x, y); };
  P.lineTo = function (x, y) { if (isGameCanvas(this)) addPt(this, x, y); return pathOrig.lineTo.call(this, x, y); };
  P.rect = function (x, y, w, h) {
    if (isGameCanvas(this)) { addPt(this, x, y, true); addPt(this, x + w, y); addPt(this, x + w, y + h); addPt(this, x, y + h); }
    return pathOrig.rect.call(this, x, y, w, h);
  };
  P.ellipse = function (x, y, rx, ry, rot, a0, a1, ccw) {
    if (isGameCanvas(this)) addArc(this, x, y, rx, ry, rot, a0, a1, ccw);
    return pathOrig.ellipse.call(this, x, y, rx, ry, rot, a0, a1, ccw);
  };
  P.fill = function (...a) {
    if (isGameCanvas(this) && !(a[0] instanceof Path2D)) {
      PATH.subs.forEach(sp => {
        if (sp.length >= 3) {
          checkMissionArrow(this, sp, this.fillStyle);
          recordShape(this, 'poly', sp, this.fillStyle);
        }
      });
      PATH.subs = []; PATH.cur = null;
    }
    return pathOrig.fill.apply(this, a);
  };
  P.stroke = function (...a) {
    if (isGameCanvas(this)) {
      const style = String(this.strokeStyle || '').replace(/\s+/g, '').toLowerCase();
      // Pink/magenta border marking bonded/combined move slots in HUD
      const isPinkBorder = /#ff8ad8|#de6bb5|#df6cb5|#d49eeb|#e7a5ee|#cc81d6|#cb8fc5/i.test(style) ||
        style.includes('255,138,216') || style.includes('222,107,181') ||
        (/^#[0-9a-f]{6}$/i.test(style) && (() => {
          const r = parseInt(style.slice(1, 3), 16), g = parseInt(style.slice(3, 5), 16), b = parseInt(style.slice(5, 7), 16);
          return r > 180 && b > 160 && g >= 70 && g <= 190;
        })());
      if (isPinkBorder) {
        state.hasBonded = true;
        state.lastBondedAt = performance.now();
        state.bondedSlot = 1;
        if (PATH.cur && PATH.cur.length) {
          const xs = PATH.cur.map(p => p.x);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          let bestSlot = 1, minDiff = Infinity;
          for (const slot of [1, 2, 3, 4]) {
            const sx = state.slotX[slot];
            if (sx !== undefined) {
              const diff = Math.abs(cx - sx);
              if (diff < minDiff) { minDiff = diff; bestSlot = slot; }
            }
          }
          state.bondedSlot = bestSlot;
        }
      }
      if (!(a[0] instanceof Path2D)) {
        PATH.subs.forEach(sp => sp.length >= 2 && recordShape(this, 'line', sp, this.strokeStyle));
        PATH.subs = []; PATH.cur = null;
      }
    }
    return pathOrig.stroke.apply(this, a);
  };
  P.clip = function (...a) {
    if (isGameCanvas(this)) { PATH.subs = []; PATH.cur = null; }
    return pathOrig.clip ? pathOrig.clip.apply(this, a) : undefined;
  };
  P.fillRect = function (x, y, w, h) {
    if (isGameCanvas(this)) {
      if ((w === 4 || w === 6) && h === 2) {
        const m = this.getTransform();
        if (!state.waterRipples) state.waterRipples = [];
        state.waterRipples.push({ sx: m.a * (x + w / 2) + m.e, sy: m.d * (y + h / 2) + m.f });
      } else {
        recordShape(this, 'poly', [tp(this, x, y), tp(this, x + w, y), tp(this, x + w, y + h), tp(this, x, y + h)], this.fillStyle);
      }
    }
    return pathOrig.fillRect.call(this, x, y, w, h);
  };
  // Untagged shapes in warning/attack colours (red beams, purple, yellow, poison green) are treated as hazards
  const isTelegraph = d => {
    if (d.src && d.src.includes('gradient')) return true; // Boss laser gradient strips
    const m = d.src.match(/(?:fill|stroke):(?:#([0-9a-f]{6}|[0-9a-f]{3})|rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\))/i);
    if (!m) return false;
    let r, g, b;
    if (m[1]) {
      const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
      [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    } else {
      [r, g, b] = [+m[2], +m[3], +m[4]];
    }
    // Skip portal vortex colors (#7b3cff, rgba(123, 60, 255))
    if ((r >= 110 && r <= 135 && b >= 235) || (r === 123 && g === 60 && b === 255)) return false;
    // 1) Reddish / crimson / pink translucent laser beams (tia đỏ tấn công của Boss Melmetal)
    if ((r >= 115 && (r > g * 1.15 || g <= 160) && (r > b * 1.15 || b <= 160)) ||
        (r >= 150 && g <= 150 && b <= 160) ||
        (r >= 85 && g <= 40 && b <= 45)) return true;
    // 2) Purple / magenta / shadow ball attacks
    if (r > 90 && b > 110 && g < 100) return true;
    // 3) Danger electric yellow / orange
    if (r >= 220 && g >= 160 && b <= 70) return true;
    // 4) Toxic poison sludge green
    if (g >= 170 && r <= 90 && b <= 110) return true;
    return false;
  };

  // ---------- input ----------
  const KEYS = { up: ['w', 'KeyW', 87], down: ['s', 'KeyS', 83], left: ['a', 'KeyA', 65], right: ['d', 'KeyD', 68] };
  const sendKey = (type, key, code, keyCode) => {
    const ev = new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    document.dispatchEvent(ev);
    if (document.body) document.body.dispatchEvent(ev);
    const cv = getCanvas();
    if (cv) cv.dispatchEvent(ev);
  };
  const setKey = (k, down) => {
    if (!!state.keys[k] === down) return;
    state.keys[k] = down;
    sendKey(down ? 'keydown' : 'keyup', ...KEYS[k]);
  };
  const releaseAll = () => Object.keys(KEYS).forEach(k => setKey(k, false));
  const tap = (key, code, keyCode) => {
    sendKey('keydown', key, code, keyCode);
    sendKey('keypress', key, code, keyCode);
    setTimeout(() => sendKey('keyup', key, code, keyCode), 50);
  };
  const simulateClick = el => {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
        el.dispatchEvent(new MouseEvent(t, opts));
      });
      if (typeof el.click === 'function') el.click();
    } catch {}
  };

  function applyDir(dir) {
    state.dir = dir;
    const [x, y] = dir || [0, 0];
    setKey('left', x < -0.38); setKey('right', x > 0.38);
    setKey('up', y < -0.38); setKey('down', y > 0.38);
  }

  // ---------- movement ----------
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  // Screen-space distance from point p to a recorded shape; negative when inside
  function shapeDist(h, p) {
    const pts = h.pts;
    let edge = Infinity;
    for (let i = 0; i < pts.length - 1; i++) edge = Math.min(edge, segDist(p, pts[i], pts[i + 1]));
    if (h.shape === 'line') return edge - h.lw / 2;
    edge = Math.min(edge, segDist(p, pts[pts.length - 1], pts[0]));
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i].y > p.y) !== (pts[j].y > p.y) && p.x < (pts[j].x - pts[i].x) * (p.y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
    }
    return inside ? -edge : edge;
  }
  const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);

  function tick(frame) {
    const world = frame.filter(d => d.s !== 1);
    if (!world.length) return;
    const s = world[0].s;
    const cv = getCanvas();
    if (!cv) return;
    const now = performance.now();
    const me = { x: cv.width / 2, y: cv.height / 2 };
    const pokes = world.filter(d => CFG.enemyRe.test(d.src));
    // The sprite closest to the camera centre is the player itself
    const self = pokes.reduce((b, d) => { const r = Math.hypot(d.x - me.x, d.y - me.y); return r < 40 * s && (!b || r < b.r) ? { d, r } : b; }, null);
    if (self) { me.x = self.d.x; me.y = self.d.y; }
    const e0 = world[0].e, f0 = world[0].f;
    const toScreen = w => ({ x: w.x * s + e0, y: w.y * s + f0 });
    const meW = { x: (me.x - e0) / s, y: (me.y - f0) / s };

    // --- Scan ALL active missions from DOM overlay (top-right panel) ---
    const allTexts = [...state.hudTexts];
    try {
      const domEls = document.querySelectorAll('body *');
      for (const el of domEls) {
        if (!el.children.length && visible(el) && el.innerText && el.innerText.length < 120) {
          allTexts.push(el.innerText.trim());
        }
      }
    } catch {}

    // Collect ALL simultaneous active missions (each has a progress counter or keyword)
    const activeMissions = [];
    const seenTypes = new Set();
    for (const t of allTexts) {
      const prog = t.match(/(\d+)\s*\/\s*(\d+)/);
      const cur = prog ? +prog[1] : 0, tot = prog ? +prog[2] : 0;
      if (cur === tot && tot > 0) continue; // already completed, skip
      if (/lantern/i.test(t) && !seenTypes.has('lantern')) {
        seenTypes.add('lantern');
        activeMissions.push({ type: 'lantern', text: t, current: cur, total: tot });
      } else if (/trick.or.treat|trick_or_treat|treat/i.test(t) && !seenTypes.has('trick')) {
        seenTypes.add('trick');
        activeMissions.push({ type: 'trick', text: t, current: cur, total: tot });
      } else if (/caged?\b|free.*pok[eé]mon|stand by.*cage/i.test(t) && !seenTypes.has('cage')) {
        seenTypes.add('cage');
        activeMissions.push({ type: 'cage', text: t, current: cur, total: tot || 2 });
      } else if (/defeat\b|slay\b|hunt\b|kill\b/i.test(t) && !seenTypes.has('defeat')) {
        seenTypes.add('defeat');
        activeMissions.push({ type: 'defeat', text: t, current: cur, total: tot });
      } else if (/survive\b/i.test(t) && !seenTypes.has('survive')) {
        seenTypes.add('survive');
        activeMissions.push({ type: 'survive', text: t });
      } else if (/bomb\b|plant\b|crystal\b|altar\b|shrine\b/i.test(t) && !seenTypes.has('interact')) {
        seenTypes.add('interact');
        activeMissions.push({ type: 'interact', text: t, current: cur, total: tot });
      }
    }
    state.missions = activeMissions;
    // Primary: first non-defeat/non-survive mission (objectives player must walk to)
    const objMission = activeMissions.find(m => m.type !== 'defeat' && m.type !== 'survive');
    state.mission = objMission || activeMissions[0] || null;

    const isCageMission   = activeMissions.some(m => m.type === 'cage');
    const isLanternMission = activeMissions.some(m => m.type === 'lantern');
    const isTrickMission   = activeMissions.some(m => m.type === 'trick');
    const isInteractMission = activeMissions.some(m => m.type === 'interact');
    const hasDistanceIndicator = !!(state.objIndicator && (performance.now() - state.objIndicator.at < 3500));
    const hasObjMission    = isCageMission || isLanternMission || isTrickMission || isInteractMission || hasDistanceIndicator;

    // --- Objective sprite collection (lanterns, treat spots, cages, interactive objects) ---
    const cages = [];
    const objTargets = []; // lantern / trick-or-treat / generic interactive objectives
    for (const d of world) {
      const tg = tagOf(d.src);
      if (tg === 'cage' || /cage|jail|prison/i.test(d.src)) {
        cages.push(d);
      } else if (tg === 'lantern' || /lantern/i.test(d.src)) {
        objTargets.push(d);
      } else if (tg === 'trick' || /trick|treat|candy|pumpkin|jack.o/i.test(d.src)) {
        objTargets.push(d);
      } else if (tg === 'interact' || /altar|crystal|bomb|shrine|pillar/i.test(d.src)) {
        objTargets.push(d);
      }
    }
    // Also detect objectives by slow/stationary sprites with matching catalog speed in relevant missions
    if (hasObjMission) {
      for (const d of world) {
        if (self && d === self.d) continue;
        if (CFG.enemyRe.test(d.src)) continue;
        const tg = tagOf(d.src);
        if (tg === 'xp' || tg === 'good' || tg === 'buff' || tg === 'case' || tg === 'rift' || tg === 'wall' || tg === 'safe' || tg === 'cage' || tg === 'lantern' || tg === 'trick' || tg === 'interact') continue;
        const c = catalog.get(d.src);
        // Novel slow-moving or stationary sprites near center that haven't been seen as hazards
        if (c && c.frames > 5 && c.speed < 0.5 && !objTargets.includes(d) && !cages.includes(d)) {
          // Check if they have a distance label nearby (objIndicator text)
          const label = state.objIndicator?.text || '';
          const keyword = label.match(/\b(lantern|trick|treat|candy|cage|bomb|altar)\b/i)?.[1];
          if (keyword) objTargets.push(d);
        }
      }
    }

    const enemies = [];
    for (const d of pokes) {
      if (self && d === self.d) continue;
      let isObjSprite = false;
      if (isCageMission) {
        // Stationary Pokémon inside or very near a cage = treat as cage objective
        const c = catalog.get(d.src);
        if (cages.some(cg => Math.hypot(d.x - cg.x, d.y - cg.y) / s < 35) ||
            (c && c.frames > 3 && c.speed < 0.35)) {
          cages.push(d);
          isObjSprite = true;
        }
      }
      if (!isObjSprite) enemies.push(d);
    }

    // Query nearby solid props (fences, gravestones, crypts, trees, rocks, pillars)
    const gameWorld = window.__psGame?.run?.world;
    let nearbyProps = [];
    if (gameWorld?.view?.propsInRect) {
      try {
        nearbyProps = (gameWorld.view.propsInRect(meW.x - 260, meW.y - 260, meW.x + 260, meW.y + 260) || []).filter(pr =>
          (pr.r && pr.r > 0) || !pr.type || !/grass|flower|ground|path|floor|decal|shadow|blood/i.test(pr.type)
        );
      } catch {}
    }

    const byTag = t => world.filter(d => tagOf(d.src) === t);
    // Only sprites inside real impassable terrain walls count as scenery (bushes and rocks are destructible)
    const isPropOrWall = d => {
      const wx = (d.x - e0) / s, wy = (d.y - f0) / s;
      if (gameWorld?.terrainAt && gameWorld.terrainAt(wx, wy) === 'wall') return true;
      return false;
    };

    // Automatic collectible items detection: Chests, Candies, Potions, Magnets, Gems, Relics, Pickups
    const isGoodItem = d => {
      if (d.shape) return false;
      const tg = tagOf(d.src);
      if (tg === 'good' || tg === 'buff' || tg === 'case') return true;
      if (tg === 'hazard' || tg === 'wall' || tg === 'rift' || tg === 'xp') return false;
      if (/chest|treasure|coffer|crate|box|candy|treat|sweet|corn|magnet|potion|heal|heart|relic|drop|pickup|item|present|gift/i.test(d.src)) return true;
      // Traps, hazards, spikes, and scenery are NOT collectibles!
      if (/spike|trap|mine|toxic|poison|thorn|shadow|caltrop|grass|bush|flower|tree|plant|shrub|foliage|weed|rock|stone|grave|tomb|crypt|fence|bench|pillar|ground|floor|tile|wall|decor|prop|rubble/i.test(d.src)) return false;
      // Novel non-enemy, non-player stationary sprites with reasonable pickup size
      const maxDim = Math.max(d.w, d.h) / s;
      if (maxDim >= 10 && maxDim <= 50 && !CFG.enemyRe.test(d.src) && (!self || d !== self.d)) {
        const c = catalog.get(d.src);
        if (c && c.speed < 0.35 && !c.isHazard) return true;
      }
      return false;
    };

    // Automatic XP item detection: gems, diamonds, crystals, orbs, shards, drops
    const isXpItem = d => {
      if (d.shape) return false;
      const tg = tagOf(d.src);
      if (tg === 'xp') return true;
      if (tg === 'hazard' || tg === 'wall' || tg === 'rift' || tg === 'good') return false;
      if (/xp|exp|gem|shard|orb|crystal|diamond|point|energy|spark|coin|gold/i.test(d.src)) return true;
      if (/spike|trap|mine|toxic|poison|thorn|shadow|caltrop|grass|bush|flower|tree|plant|rock|stone|tomb|grave|tile|wall|decor/i.test(d.src)) return false;
      // Small stationary non-enemy drops on ground (< 30x30)
      const maxDim = Math.max(d.w, d.h) / s;
      if (maxDim >= 4 && maxDim <= 30 && !CFG.enemyRe.test(d.src) && (!self || d !== self.d)) {
        const c = catalog.get(d.src);
        if (c && c.speed < 0.4 && !c.isHazard) return true;
        if (!c) return true; // novel small drop
      }
      return false;
    };

    const goods = world.filter(d => isGoodItem(d) && !isPropOrWall(d) && (self ? d !== self.d : true));
    const isRiftSprite = d => {
      if (tagOf(d.src) === 'rift') return true;
      if (/rift|portal|void|teleport|wormhole|dimension|gate/i.test(d.src)) return true;
      if (/#(?:7b3cff|8b5cf6|9333ea|a855f7|7c3aed|c084fc|6d28d9|581c87)/i.test(d.src)) return true;
      const m = d.src.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m && +m[1] >= 90 && +m[3] >= 140 && +m[2] <= 100) return true;
      // Large stationary non-enemy sprite near riftIndicator (the portal vortex)
      if (state.riftIndicator && (now - state.riftIndicator.at < 35000)) {
        if (!CFG.enemyRe.test(d.src) && Math.hypot(d.x - state.riftIndicator.x, d.y - state.riftIndicator.y) < 160) {
          if (Math.max(d.w, d.h) / s >= 18) return true;
        }
      }
      return false;
    };
    const rifts = world.filter(d => isRiftSprite(d));
    const buffs = byTag('buff');
    const xps = world.filter(d => isXpItem(d) && !isPropOrWall(d) && (self ? d !== self.d : true));
    const cases = byTag('case');
    const hazards = world.filter(d => !isGoodItem(d) && (tagOf(d.src) === 'hazard' || (d.shape && !tagOf(d.src) && CFG.autoTelegraph && isTelegraph(d))));

    // Bullets: only direct engine projectiles or explicit hazard tags (never guess from player attacks!)
    const bullets = [];
    for (const d of world) {
      if (self && d === self.d) continue;
      if (CFG.enemyRe.test(d.src)) continue;
      if (tagOf(d.src) === 'hazard') {
        const wx = (d.x - e0) / s, wy = (d.y - f0) / s;
        bullets.push({
          x: wx, y: wy,
          sx: d.x, sy: d.y,
          vx: 0, vy: 0, speed: 0,
          r: Math.max(10, Math.max(d.w, d.h) / 2 / s),
          src: d.src
        });
      }
    }

    // Direct game engine projectiles if available
    try {
      const g = window.__psGame?.run?.conn?.game || window.__psGame?.run;
      const list = g?.projectiles || g?.bullets || g?.attacks;
      if (Array.isArray(list)) {
        const selfId = window.__psGame?.run?.conn?.selfId;
        for (const b of list) {
          if (!b || b.owner === selfId || b.friendly) continue;
          const bx = b.x ?? b.pos?.x ?? 0, by = b.y ?? b.pos?.y ?? 0;
          const bvx = b.vx ?? b.vel?.x ?? 0, bvy = b.vy ?? b.vel?.y ?? 0;
          const spd = Math.hypot(bvx, bvy);
          bullets.push({
            x: bx, y: by,
            sx: bx * s + e0, sy: by * s + f0,
            vx: bvx, vy: bvy, speed: spd,
            r: b.r || b.radius || 12, src: 'engine'
          });
        }
      }
    } catch {}

    // Convert incoming water ripples into persistent world water points (60s lifetime)
    if (!state.waterPoints) state.waterPoints = [];
    state.waterPoints = state.waterPoints.filter(wp => wp.until > now);
    if (state.waterRipples?.length) {
      for (const r of state.waterRipples) {
        const wx = (r.sx - e0) / s, wy = (r.sy - f0) / s;
        if (!state.waterPoints.some(wp => Math.hypot(wp.x - wx, wp.y - wy) < 22)) {
          state.waterPoints.push({ x: wx, y: wy, sx: r.sx, sy: r.sy, until: now + 60000 });
        }
      }
      state.waterRipples.length = 0;
    }

    state.walls = state.walls.filter(w => w.until > now);
    state.ignore = state.ignore.filter(w => w.until > now);

    // Solid terrain wall, water & dynamically learned obstacle checker
    const isSolid = (wx, wy, pad = 6) => {
      // 1) Impassable terrain from game world
      if (gameWorld?.terrainAt) {
        try {
          const isImpassable = t => t === 'wall' || t === 'liquid' || t === 'water' || t === 'river' || t === 'lake' || t === 'sea' || t === 'void' || t === 'chasm' || t === 'cliff';
          if (isImpassable(gameWorld.terrainAt(wx, wy))) return true;
          if (pad > 0) {
            if (isImpassable(gameWorld.terrainAt(wx + pad, wy))) return true;
            if (isImpassable(gameWorld.terrainAt(wx - pad, wy))) return true;
            if (isImpassable(gameWorld.terrainAt(wx, wy + pad))) return true;
            if (isImpassable(gameWorld.terrainAt(wx, wy - pad))) return true;
          }
        } catch {}
      }
      // 2) Dynamically learned walls / obstacle points where movement was blocked
      if (state.walls?.length) {
        for (const w of state.walls) {
          if (Math.hypot(wx - w.x, wy - w.y) < (w.r || 24)) return true;
        }
      }
      // 3) Water / river points (with safe margin)
      if (state.waterPoints?.length) {
        for (const wp of state.waterPoints) {
          if (Math.hypot(wx - wp.x, wy - wp.y) < 32) return true;
        }
      }
      return false;
    };

    // Calculate maximum clearance distance in direction dir (world units)
    const clearanceInDir = (wx, wy, dir, maxDist = 160, step = 12, pad = 6) => {
      for (let dist = step; dist <= maxDist; dist += step) {
        if (isSolid(wx + dir[0] * dist, wy + dir[1] * dist, pad)) return dist - step;
      }
      return maxDist;
    };

    // Detect if player is trapped inside a corner, narrow alcove or pocket (3+ sides blocked)
    let pocketBlockedCount = 0;
    const pocketEscape = [0, 0];
    const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71]];
    for (const [cdx, cdy] of CARDINALS) {
      if (isSolid(meW.x + cdx * 24, meW.y + cdy * 24, 6)) {
        pocketBlockedCount++;
        pocketEscape[0] -= cdx; // push away from blocked side
        pocketEscape[1] -= cdy;
      }
    }
    const inPocket = pocketBlockedCount >= 3;
    const pocketLen = Math.hypot(pocketEscape[0], pocketEscape[1]);
    if (pocketLen > 0.01) { pocketEscape[0] /= pocketLen; pocketEscape[1] /= pocketLen; }

    state.view = { me, enemies, goods, hazards, bullets, cages, rifts, buffs, xps, cases, s, nearbyProps };

    // Watchdog for movement & dynamic obstacle learning:
    const paused = now - (state.timerChangedAt || now) > 1500;
    if (paused) {
      state.immobileSince = now;
      state.posHist = [];
    } else {
      if (!state.lastPos) state.lastPos = { x: meW.x, y: meW.y };
      if (!state.failedDirs) state.failedDirs = [];
      state.failedDirs = state.failedDirs.filter(fd => fd.until > now);

      // Cập nhật lịch sử toạ độ liên tục (mỗi ~80ms)
      if (!state.posHist) state.posHist = [];
      const lastHist = state.posHist[state.posHist.length - 1];
      if (!lastHist || now - lastHist.at >= 80) {
        state.posHist.push({ x: meW.x, y: meW.y, at: now });
        if (state.posHist.length > 40) state.posHist.shift();
      }

      // Kiểm tra xem nhân vật có bị kẹt / đứng 1 chỗ quá lâu không (380ms và 850ms)
      const p400 = state.posHist.find(p => now - p.at >= 380);
      const d400 = p400 ? Math.hypot(meW.x - p400.x, meW.y - p400.y) : 100;
      const p900 = state.posHist.find(p => now - p.at >= 850);
      const d900 = p900 ? Math.hypot(meW.x - p900.x, meW.y - p900.y) : 100;
      const isStuckImmobile = state.on && ((p400 && d400 < 8) || (p900 && d900 < 18));

      // Kiểm tra hoàn thành lệnh escape khi đã di chuyển ra xa vùng kẹt:
      if (state.escape && state.escape.origin) {
        const dEscape = Math.hypot(meW.x - state.escape.origin.x, meW.y - state.escape.origin.y);
        if (dEscape > 40) {
          state.escape = null;
          state.unstuckMode = false;
          state.unstuckDir = null;
          state.posHist.length = 0;
          log('Đã di chuyển thoát khỏi góc kẹt thành công!');
        }
      }

      if (isStuckImmobile) {
        const blockedDir = state.dir || state.unstuckDir || [0, 1];
        // 1) Ghi nhận ngay toạ độ vật cản phía trước để né vĩnh viễn
        const blockedX = meW.x + blockedDir[0] * 22;
        const blockedY = meW.y + blockedDir[1] * 22;
        if (!state.walls.some(w => Math.hypot(w.x - blockedX, w.y - blockedY) < 20)) {
          state.walls.push({ x: blockedX, y: blockedY, r: 35, until: now + 45000 });
        }
        state.failedDirs.push({ dir: blockedDir, until: now + 4000 });

        // 2) Bỏ qua mọi target (XP, đồ, buff) nằm về hướng bị cản để không bị hút về phía vực/tường nữa
        [...goods, ...xps, ...buffs].forEach(item => {
          const ix = (item.x - me.x) / s, iy = (item.y - me.y) / s;
          const idist = Math.hypot(ix, iy);
          if (idist > 5 && idist < 350) {
            const dot = (ix * blockedDir[0] + iy * blockedDir[1]) / idist;
            if (dot > 0.2) {
              state.ignore.push({ x: (item.x - e0) / s, y: (item.y - f0) / s, r: 60, until: now + 25000 });
            }
          }
        });

        // 3) BẮT BUỘC RỜI KHỎI KHU VỰC NÀY: Tìm hướng có khoảng trống (clearance) lớn nhất ngược với hướng bị cản
        let bestEscapeDir = null, maxEscapeScore = -Infinity;
        DIRS.forEach(d => {
          const dotBlocked = d[0] * blockedDir[0] + d[1] * blockedDir[1];
          if (dotBlocked > 0.15) return; // Tuyệt đối không đi tiếp về phía bị cản
          const clr = clearanceInDir(meW.x, meW.y, d, 250, 14, 6);
          if (clr < 22) return;
          const score = clr * 1.5 - dotBlocked * 90;
          if (score > maxEscapeScore) {
            maxEscapeScore = score;
            bestEscapeDir = d;
          }
        });
        if (!bestEscapeDir) {
          bestEscapeDir = [-blockedDir[0], -blockedDir[1]];
        }

        state.escape = { dir: bestEscapeDir, until: now + 2000, origin: { x: meW.x, y: meW.y } };
        state.unstuckMode = true;
        state.unstuckDir = bestEscapeDir;
        log('Đứng 1 chỗ quá lâu -> BẮT BUỘC RỜI KHỎI KHU VỰC BỊ CHẶN để sang vùng đất mới!');
      }
    }

    // Learn the XP pickup radius
    const xpNow = xps.map(d => ({ x: (d.x - e0) / s, y: (d.y - f0) / s, sx: d.x, sy: d.y, rest: false }));
    for (const p of xpNow) p.rest = state.prevXp.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 4);
    for (const q of state.prevXp) {
      if (!q.rest || xpNow.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 4)) continue;
      const onScreen = q.sx > 30 && q.sy > 30 && q.sx < cv.width - 30 && q.sy < cv.height - 30;
      const d = Math.hypot(q.x - state.prevMe.x, q.y - state.prevMe.y);
      if (onScreen && d > 20 && d < state.magnet * 3) state.magnet = state.magnet * 0.8 + d * 0.2;
    }
    state.prevXp = xpNow; state.prevMe = meW;
    if (!state.on) return;

    // Refresh player HP ratio
    try {
      const selfConn = window.__psGame?.run?.conn?.game;
      const selfPlayer = selfConn?.players?.find(p => p.id === window.__psGame?.run?.conn?.selfId) || selfConn?.self;
      if (selfPlayer) {
        if (selfPlayer.hp !== undefined && selfPlayer.maxHp) {
          state.hp = selfPlayer.hp;
          state.maxHp = selfPlayer.maxHp;
          state.hpRatio = state.hp / state.maxHp;
        }
        if (Array.isArray(selfPlayer.moves) && selfPlayer.moves.length) {
          state.playerMoves = selfPlayer.moves.map(m => {
            if (!m) return '';
            if (typeof m === 'string') return m.toLowerCase().trim();
            return (m.name || m.title || m.id || m.key || '').toLowerCase().trim();
          }).filter(Boolean);
        }
        if (selfPlayer.bonds?.length > 0 || selfPlayer.bondedMoves?.length > 0 ||
            (Array.isArray(selfPlayer.moves) && selfPlayer.moves.some(m => m && (m.subMoves?.length || m.bonds?.length || m.bonded || m.isBond)))) {
          state.hasBonded = true;
          if (!state.bondedSlot) state.bondedSlot = 1;
        }
      }
    } catch {}

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / s;
    const nearestTo = list => list.reduce((b, d) => (!b || dist(d, me) < dist(b, me) ? d : b), null);
    const reachable = list => list.filter(d => !state.ignore.some(w => Math.hypot((d.x - e0) / s - w.x, (d.y - f0) / s - w.y) < 50));
    const walls = state.walls.map(toScreen).concat(byTag('wall'));

    // Check boss room presence (MELMETAL / Steel Fortress / Rift countdown timer)
    const isBossRiftText = t => (
      /\brift\b[^\d]*\d+:\d{2}/i.test(t) ||
      /\bmelmetal\b/i.test(t) ||
      /\bsteel fortress\b/i.test(t) ||
      /\bboss\s*rift\b/i.test(t)
    );
    const insideRift = [...state.hudTexts].some(isBossRiftText);
    state.insideRift = insideRift;
    if (insideRift) {
      state.insideRiftAt = now;
      state.riftIndicator = null;
    }

    // Overworld rift: check DOM for HUD indicator ("RIFT · 141 m · 4 s")
    if (!insideRift && cv) {
      try {
        const cvRect = cv.getBoundingClientRect();
        const domEls = document.querySelectorAll('body *:not(#psb-dock):not([data-psbot-ui])');
        for (const el of domEls) {
          if (el.closest('#psb-dock, [data-psbot-ui], [data-ctl], [data-ms]')) continue;
          if (!el.children.length && visible(el) && el.innerText) {
            const txt = el.innerText.trim();
            if (isBossRiftText(txt)) {
              state.insideRift = true;
              state.insideRiftAt = now;
              state.riftIndicator = null;
              break;
            } else if (/\brift\b/i.test(txt) && /(?:\d+\s*m|\d+\s*s)\b/i.test(txt)) {
              const r = el.getBoundingClientRect();
              const sx = (r.left + r.width / 2 - cvRect.left) * cv.width / cvRect.width;
              const sy = (r.top + r.height / 2 - cvRect.top) * cv.height / cvRect.height;
              state.riftIndicator = { x: sx, y: sy, text: txt, at: now, arrowDir: state.riftArrowDir };
              break;
            }
          }
        }
      } catch {}
    }

    // Overworld rift: check rifts sprites or state.riftIndicator (lasts ~6s)
    const riftSprite = insideRift ? null : nearestTo(reachable(rifts));
    let activeRift = null;
    if (!insideRift) {
      if (riftSprite) {
        activeRift = { ...riftSprite, isRift: true, isSprite: true };
      } else if (state.riftIndicator && (now - state.riftIndicator.at < 6000)) {
        // Priority: triangle arrow direction -> or vector from player to indicator
        let uDir = null;
        if (state.riftArrowDir && (now - state.riftArrowAt < 3000)) {
          uDir = state.riftArrowDir;
        } else if (state.riftIndicator.arrowDir && (now - state.riftIndicator.arrowAt < 3000)) {
          uDir = state.riftIndicator.arrowDir;
        } else {
          const rdx = state.riftIndicator.x - me.x;
          const rdy = state.riftIndicator.y - me.y;
          const rlen = Math.hypot(rdx, rdy) || 1;
          uDir = [rdx / rlen, rdy / rlen];
        }
        // Project target point 3000 units in arrow direction so bot runs straight along vector
        activeRift = {
          x: me.x + uDir[0] * 3000,
          y: me.y + uDir[1] * 3000,
          dir: uDir,
          text: state.riftIndicator.text,
          isIndicator: true,
          isRift: true
        };
      }
    }

    const good = nearestTo(reachable(goods)), foe = nearestTo(enemies);
    const buff = nearestTo(reachable(buffs));
    if (buff && dist(buff, me) < CFG.buffReach) state.ignore.push({ x: (buff.x - e0) / s, y: (buff.y - f0) / s, until: now + CFG.buffCooldown });

    // Suitcase dwelling
    const kase = nearestTo(reachable(cases));
    const dt = Math.min(100, now - (state.lastTick || now)); state.lastTick = now;
    if (kase && dist(kase, me) < CFG.caseReach) {
      const kw = { x: (kase.x - e0) / s, y: (kase.y - f0) / s };
      if (!state.dwell || Math.hypot(state.dwell.x - kw.x, state.dwell.y - kw.y) > 30) state.dwell = { ...kw, t: 0 };
      if (!paused) state.dwell.t += dt;
      if (state.dwell.t > CFG.caseTime) { state.ignore.push({ ...kw, until: now + 60000 }); state.dwell = null; log('mở vali xong'); }
    } else state.dwell = null;

    // High priority: close items, chests, candies, buffs, and cases on screen!
    const nearbyGood = good && dist(good, me) < 320 ? good : null;
    const nearbyCase = kase && dist(kase, me) < 320 ? kase : null;
    const nearbyBuff = buff && dist(buff, me) >= CFG.buffReach && dist(buff, me) < 320 ? buff : null;
    const outsideMagnetXps = reachable(xps).filter(d => dist(d, me) > state.magnet * 0.6);
    const nearbyXp = nearestTo(outsideMagnetXps);

    // Target priority: RIFT PORTAL (ABSOLUTE TOP PRIORITY!) > Boss in Rift > Items > XP > Hit-and-run survival
    let target = null, weight = 0, stop = 0, hold = false;
    if (activeRift && !insideRift) {
      // RIFT PORTAL: Enter Rift immediately as soon as it appears! Only 30s-35s portal duration!
      target = activeRift;
      weight = 300;
      hold = false;
      stop = 0;
      state.view.riftDist = dist(activeRift, me);
    }
    else if (insideRift && foe) {
      // Inside Rift chamber: fighting the Legendary Boss is #1 priority!
      target = foe; weight = 8; stop = CFG.engage || 130;
    }
    // Collectible items / chests / candies right near player: ALWAYS grab them!
    else if (nearbyGood) {
      target = nearbyGood; weight = 20; hold = dist(nearbyGood, me) < 22;
    }
    else if (nearbyCase) {
      target = nearbyCase; weight = CFG.goodWeight; hold = dist(nearbyCase, me) < CFG.caseReach;
    }
    else if (nearbyBuff) {
      target = nearbyBuff; weight = CFG.goodWeight;
    }
    // If nearby XP is waiting, vacuum it up!
    else if (nearbyXp && dist(nearbyXp, me) < 350) {
      target = nearbyXp; weight = 16; stop = state.magnet * 0.4;
    }
    else if (good && dist(good, me) < CFG.goodRange) {
      target = good; weight = 16; hold = dist(good, me) < 22;
    }
    else if (nearbyXp && dist(nearbyXp, me) < CFG.xpRange) {
      target = nearbyXp; weight = CFG.xpWeight; stop = state.magnet * 0.4;
    }
    else if (kase && dist(kase, me) < CFG.goodRange) {
      target = kase; weight = CFG.goodWeight; hold = dist(kase, me) < CFG.caseReach;
    }
    else if (buff && dist(buff, me) >= CFG.buffReach && dist(buff, me) < CFG.goodRange) {
      target = buff; weight = CFG.goodWeight;
    }
    // Fallback: Hit-and-Run against nearest enemy (keeping distance to let skills shred them)
    else if (foe) {
      target = foe; weight = 6; stop = CFG.engage || 140;
    }
    if (state.escape && state.escape.until > now) {
      target = null; // Khi đang chạy thoát khỏi vùng kẹt: không để target kéo ngược trở lại!
    }
    state.view.target = target;
    state.view.prevTarget = target && { enemy: target === foe, w: { x: (target.x - e0) / s, y: (target.y - f0) / s } };
    state.view.walls = walls;
    const escape = state.escape && state.escape.until > now ? state.escape.dir : null;

    // Precompute hazard danger at player position
    let minHazardDistMe = Infinity;
    let nearestHazardMe = null;
    for (const h of hazards) {
      const d = h.shape ? shapeDist(h, me) / s : dist(me, h) - Math.max(h.w, h.h) / 2 / s;
      if (d < minHazardDistMe) { minHazardDistMe = d; nearestHazardMe = h; }
    }
    const isMeInDanger = minHazardDistMe < CFG.hazardMargin;

    // Calculate swarm center of nearby enemies for Hit-and-Run kiting
    let swarmX = 0, swarmY = 0, swarmCount = 0;
    for (const e of enemies) {
      if (dist(me, e) < 240) {
        swarmX += e.x;
        swarmY += e.y;
        swarmCount++;
      }
    }

    const cost = dir => {
      const at = k => ({ x: me.x + (dir ? dir[0] : 0) * CFG.lookahead * s * k, y: me.y + (dir ? dir[1] : 0) * CFG.lookahead * s * k });
      const p = at(1);
      const pW = { x: meW.x + (dir ? dir[0] : 0) * CFG.lookahead, y: meW.y + (dir ? dir[1] : 0) * CFG.lookahead };
      let c = 0;
      const hasGoodHp = (state.hpRatio === undefined || state.hpRatio >= 0.35);

      const isHeadingToRift = !!(target && target.isRift);

      for (const e of enemies) {
        const d = dist(p, e) - Math.max(e.w, e.h) / 2 / s;
        // Never step straight into an enemy body!
        if (d < 12) {
          c += hasGoodHp ? (400 + 40 * (12 - d)) : (900 + 100 * (12 - d));
        } else if (d < CFG.contact) {
          const contactPenalty = isHeadingToRift ? 6 : 35;
          c += contactPenalty * ((CFG.contact - d) / CFG.contact);
        }
      }

      // Hit-and-Run / Swarm kiting: run away from enemy horde and herd them into line of fire
      // BUT when rushing towards Rift Portal, DO NOT kite away from swarm: prioritize diving into the portal!
      if (swarmCount > 0 && dir && !isHeadingToRift) {
        const awayX = me.x - (swarmX / swarmCount), awayY = me.y - (swarmY / swarmCount);
        const awayLen = Math.hypot(awayX, awayY);
        if (awayLen > 10) {
          const dotAway = (dir[0] * awayX + dir[1] * awayY) / awayLen;
          c -= dotAway * 75; // Run away from swarm center into open space!
          const tanX = -awayY / awayLen, tanY = awayX / awayLen;
          const dotTan = Math.abs(dir[0] * tanX + dir[1] * tanY);
          c -= dotTan * 35; // Circle around swarm to herd them!
        }
      }

      // BOSS KITING & ORBITING inside Rift Chamber:
      // Luôn di chuyển lượn tròn (orbit/strafe) quanh Boss ở cự ly an toàn 130-150px
      // Tránh đứng yên hoặc chạy thẳng mặt vào Boss làm ăn trọn tia đỏ / chùm đạn!
      if (insideRift && foe && dir) {
        const toBossX = foe.x - me.x, toBossY = foe.y - me.y;
        const bLen = Math.hypot(toBossX, toBossY) || 1;
        // Vector tiếp tuyến (tangent) quanh boss
        const tanX = -toBossY / bLen, tanY = toBossX / bLen;
        const dotTan = Math.abs(dir[0] * tanX + dir[1] * tanY);
        c -= dotTan * 220; // Thưởng cực lớn cho việc liên tục lượn vòng quanh boss
        // Tránh bị boss áp sát dưới 90px (tránh đòn dậm cận chiến)
        const bossDist = bLen / s;
        if (bossDist < 95) {
          const awayDot = (dir[0] * (-toBossX) + dir[1] * (-toBossY)) / bLen;
          c -= awayDot * 300;
        }
      }

      // Hazard evaluation & active red beam dodging (tia đỏ cảnh báo)
      let minHazardDistP = Infinity;
      if (hazards.length) {
        for (const q of [at(0.33), at(0.66), p]) {
          for (const h of hazards) {
            const d = h.shape ? shapeDist(h, q) / s : dist(q, h) - Math.max(h.w, h.h) / 2 / s;
            if (d < minHazardDistP) minHazardDistP = d;
          }
        }
      }

      let inDanger = isMeInDanger;
      if (minHazardDistP < 0) {
        inDanger = true;
        // Điểm dự kiến rơi vào trong tia đỏ / hazard -> PHẠT CỰC NẶNG!
        c += 3500 + 1500 * ((-minHazardDistP) / CFG.hazardMargin);
      } else if (minHazardDistP < CFG.hazardMargin) {
        const f = (CFG.hazardMargin - minHazardDistP) / CFG.hazardMargin;
        c += 600 * f * f;
      } else if (hazards.length) {
        c -= 120;
      }

      // CHỦ ĐỘNG NÉ TIA ĐỎ TẤN CÔNG (Perpendicular Dodge):
      // Khi có tia đỏ (line/laser/telegraph) nhắm vào người chơi, bước vuông góc thoát ngay lập tức!
      if (isMeInDanger && nearestHazardMe && dir) {
        if (nearestHazardMe.shape === 'line' && nearestHazardMe.pts && nearestHazardMe.pts.length >= 2) {
          const pts = nearestHazardMe.pts;
          const p0 = pts[0], p1 = pts[pts.length - 1];
          const lx = p1.x - p0.x, ly = p1.y - p0.y;
          const llen = Math.hypot(lx, ly) || 1;
          // Pháp tuyến vuông góc với đường tia laser đỏ
          const nx = -ly / llen, ny = lx / llen;
          const pCandidate1 = { x: me.x + nx * 60, y: me.y + ny * 60 };
          const pCandidate2 = { x: me.x - nx * 60, y: me.y - ny * 60 };
          const d1 = segDist(pCandidate1, p0, p1);
          const d2 = segDist(pCandidate2, p0, p1);
          const bestNx = d1 >= d2 ? nx : -nx, bestNy = d1 >= d2 ? ny : -ny;
          const dotNormal = dir[0] * bestNx + dir[1] * bestNy;
          // Thưởng điểm rất lớn khi bước vuông góc ra khỏi tia đỏ!
          c -= 1100 * dotNormal;
          // Phạt nặng nếu chạy dọc theo chiều dài tia đỏ
          const dotParallel = Math.abs(dir[0] * (lx / llen) + dir[1] * (ly / llen));
          c += 700 * dotParallel;
        } else if (nearestHazardMe.shape === 'poly' && nearestHazardMe.pts && nearestHazardMe.pts.length >= 3) {
          const pts = nearestHazardMe.pts;
          if (pts.length === 4) {
            // DẢI LASER ĐỎ HÌNH CHỮ NHẬT KÉO DÀI (như chiêu của Boss Melmetal)
            const d01 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const d12 = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
            let lx, ly, llen, nx, ny, nlen;
            if (d01 >= d12) {
              lx = pts[1].x - pts[0].x; ly = pts[1].y - pts[0].y; llen = d01;
              nx = pts[2].x - pts[1].x; ny = pts[2].y - pts[1].y; nlen = d12;
            } else {
              lx = pts[2].x - pts[1].x; ly = pts[2].y - pts[1].y; llen = d12;
              nx = pts[1].x - pts[0].x; ny = pts[1].y - pts[0].y; nlen = d01;
            }
            if (nlen > 0 && llen > 0) {
              const unx = nx / nlen, uny = ny / nlen;
              const p1 = { x: me.x + unx * 60, y: me.y + uny * 60 };
              const p2 = { x: me.x - unx * 60, y: me.y - uny * 60 };
              const dMe1 = shapeDist(nearestHazardMe, p1);
              const dMe2 = shapeDist(nearestHazardMe, p2);
              const bestNx = dMe1 >= dMe2 ? unx : -unx;
              const bestNy = dMe1 >= dMe2 ? uny : -uny;
              const dotNormal = dir[0] * bestNx + dir[1] * bestNy;
              // Thưởng cực lớn khi tạt ngang vuông góc ra khỏi dải laser đỏ!
              c -= 1800 * dotNormal;
              // Phạt rất nặng nếu chạy dọc theo luồng tia laser đỏ!
              const dotParallel = Math.abs(dir[0] * (lx / llen) + dir[1] * (ly / llen));
              c += 1200 * dotParallel;
            }
          } else {
            // Vùng nổ đa giác / nón đỏ: bước ra khỏi tâm vùng nguy hiểm
            const xs = pts.map(pt => pt.x), ys = pts.map(pt => pt.y);
            const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
            const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
            const vx = me.x - cx, vy = me.y - cy;
            const vlen = Math.hypot(vx, vy) || 1;
            const dot = (dir[0] * vx + dir[1] * vy) / vlen;
            c -= 800 * dot;
          }
        } else {
          const vx = me.x - nearestHazardMe.x, vy = me.y - nearestHazardMe.y;
          const vlen = Math.hypot(vx, vy);
          if (vlen > 0.1) {
            const dot = (dir[0] * vx + dir[1] * vy) / vlen;
            if (minHazardDistMe < 0) c -= 500 * dot;
            else c -= 250 * dot;
          }
        }
      }

      // Projectile / Bullet dodge: CHỦ ĐỘNG NÉ ĐƯỜNG ĐẠN
      let isBulletThreat = false;
      for (const b of bullets) {
        const safeR = (b.r || 14) + 40;
        if (b.speed >= 1.0) {
          const bEnd = { x: b.x + b.vx * 25, y: b.y + b.vy * 25 };
          const dTraj = segDist(pW, b, bEnd);
          if (dTraj < safeR) {
            c += 3500 * ((safeR - dTraj) / safeR) ** 2;
          }
          const dMeTraj = segDist(meW, b, bEnd);
          if (dMeTraj < safeR) {
            isBulletThreat = true;
            if (dir && b.speed > 0.1) {
              // Hướng vuông góc với đường bay của viên đạn
              const nx = -b.vy / b.speed, ny = b.vx / b.speed;
              const pW1 = { x: meW.x + nx * 50, y: meW.y + ny * 50 };
              const pW2 = { x: meW.x - nx * 50, y: meW.y - ny * 50 };
              const d1 = segDist(pW1, b, bEnd), d2 = segDist(pW2, b, bEnd);
              const bestNx = d1 >= d2 ? nx : -nx, bestNy = d1 >= d2 ? ny : -ny;
              const dot = dir[0] * bestNx + dir[1] * bestNy;
              c -= 850 * dot;
            }
          }
        } else {
          const d = Math.hypot(pW.x - b.x, pW.y - b.y) - (b.r || 14);
          if (d < 40) c += 2200 * (1 - Math.max(0, d) / 40);
        }
      }
      if (isBulletThreat) inDanger = true;

      for (const w of walls) {
        const d = dist(p, w), r = (w.w ? Math.max(w.w, w.h) / 2 / s : 0) + 70;
        if (d < 25) return Infinity;
        if (d < r) c += 350 * (1 - d / r) + 80;
      }

      // Native terrain & solid obstacle avoidance
      if (dir) {
        if (isSolid(meW.x + dir[0] * 14, meW.y + dir[1] * 14, 6)) return Infinity;
        if (isSolid(meW.x + dir[0] * 26, meW.y + dir[1] * 26, 6)) return Infinity;
        if (isSolid(meW.x + dir[0] * 42, meW.y + dir[1] * 42, 6)) c += 400;
        if (isSolid(meW.x + dir[0] * 65, meW.y + dir[1] * 65, 4)) c += 180;

        // Clearance bonus: prefer paths that open into spacious corridors
        const clr = clearanceInDir(meW.x, meW.y, dir, 160, 12, 6);
        if (clr < 20) return Infinity; // Truly dead blocked within 20 units
        // Strong bonus for open space (disabled when rushing to Rift so player doesn't run away)
        if (!isHeadingToRift) c -= (clr / 160) * 120;

        // Directional momentum: keep running smoothly, prevent jittery vibrating!
        if (state.dir) {
          const dotMomentum = dir[0] * state.dir[0] + dir[1] * state.dir[1];
          c -= dotMomentum * 40; // Smooth human-like running arcs!
        }

        // Penalize recently failed directions where player bumped into obstacles (ĐỔI HƯỚNG LIỀN)
        if (state.failedDirs?.length) {
          for (const fd of state.failedDirs) {
            const dot = dir[0] * fd.dir[0] + dir[1] * fd.dir[1];
            if (dot > 0.25) c += 1600 * dot;
          }
        }

        // Pocket / Alcove escape: when trapped in a corner or 3-sided alcove, forcefully guide out
        if (inPocket) {
          const dot = dir[0] * pocketEscape[0] + dir[1] * pocketEscape[1];
          c -= dot * 600;
        }
      }
      if (escape) {
        c -= dir ? 220 * (dir[0] * escape[0] + dir[1] * escape[1]) : 0;
      } else if (target && hold) {
        c += weight * dist(p, target) / CFG.lookahead; // already on top: stay put
      } else if (target) {
        const isRiftTarget = !!(target && target.isRift);
        if (isRiftTarget) {
          // Vector projection towards target: massive pull!
          const tvx = target.x - me.x, tvy = target.y - me.y;
          const tlen = Math.hypot(tvx, tvy) || 1;
          const dot = (dir[0] * tvx + dir[1] * tvy) / tlen;
          c -= dot * 1600; // MASSIVE bonus: prioritizes moving towards rift above all else
          if (target.isSprite) {
            c += 80 * dist(p, target) / CFG.lookahead;
          }
        } else {
          const isCollect = target === nearbyGood || target === good || target === nearbyXp || target === xps;
          const effWeight = (escape || inPocket) ? (weight * 0.4) : (inDanger || state.unstuckMode) ? (isCollect ? 14 : weight * 0.6) : weight;
          if (!stop) c += effWeight * (segDist(target, me, p) / s + 0.2 * dist(p, target)) / CFG.lookahead;
          else c += effWeight * Math.abs(dist(p, target) - stop) / CFG.lookahead;
        }
      }
      if (dir && dir === state.dir) c -= 15; // keep heading, avoid jitter
      return c;
    };

    // Direction picking
    let pick = null;

    // 1) Khi có lệnh Escape / Gỡ kẹt: Bắt buộc di chuyển theo hướng thoát ra ngoài (trừ khi đang né đòn nguy hiểm)
    const activeEscapeDir = (state.escape && state.escape.until > now) ? state.escape.dir : (state.unstuckMode ? state.unstuckDir : null);
    if (activeEscapeDir && !isMeInDanger) {
      pick = activeEscapeDir;
    }

    // 2) Đánh giá chi phí các hướng nếu không trong trạng thái escape bắt buộc:
    if (!pick) {
      let minCost = Infinity;
      DIRS.forEach(d => {
        const c = cost(d);
        if (c < minCost) { pick = d; minCost = c; }
      });
      // Nếu tất cả các hướng đều bị cản hoặc không có hướng hợp lệ:
      if (minCost === Infinity || !pick) {
        let bestEscapeDir = DIRS[0], maxClear = -Infinity;
        DIRS.forEach(d => {
          let clr = clearanceInDir(meW.x, meW.y, d, 250, 14, 6);
          if (inPocket) clr += (d[0] * pocketEscape[0] + d[1] * pocketEscape[1]) * 50;
          if (clr > maxClear) { maxClear = clr; bestEscapeDir = d; }
        });
        pick = bestEscapeDir;
      }
    }

    // 3) Tuyệt đối không bao giờ đứng yên trong trận (trừ khi đang đứng 5s mở vali):
    if (!pick && !state.dwell) {
      pick = state.dir || DIRS[0];
    }
    applyDir(pick);

    const isChestTarget = target && target.src && (/chest|treasure|box/i.test(target.src));
    const aimTarget = isChestTarget ? target : (CFG.aim ? foe : null);
    if (aimTarget) {
      const cv = getCanvas();
      if (cv) {
        const r = cv.getBoundingClientRect();
        const clientX = r.left + aimTarget.x * r.width / cv.width, clientY = r.top + aimTarget.y * r.height / cv.height;
        window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }));
      }
    }
  }

  // ---------- level-up ----------
  // Priority: level up an owned skill (most-levelled first) > offensive passive > new skill
  // (only while under CFG.maxSkills) > defensive passive. Status / no-damage moves are avoided.
  // getClientRects (not offsetParent, which is null for position:fixed menus) + not hidden
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ATK_RE = /damage|dmg|power|attack|crit|cooldown|hit|area|projectile|range|pierce|burst|daño|dano|ataque|dégât/i;
  const DEF_RE = /hp|health|heal|regen|armor|armour|defen|shield|speed|magnet|pickup|vida|salud/i;
  const fontSize = el => parseFloat(getComputedStyle(el).fontSize) || 0;
  // The HUD draws the current pokémon's name; use it to look up its build
  const currentBuild = () => {
    const allKeys = Object.keys(CFG.builds).filter(k => CFG.builds[k] && CFG.builds[k].length);
    if (!allKeys.length) return null;
    if (allKeys.length === 1) return CFG.builds[allKeys[0]];

    // 1. Cached current pokemon from hud/ui
    if (state.currentMon && CFG.builds[state.currentMon.toLowerCase()]) {
      return CFG.builds[state.currentMon.toLowerCase()];
    }

    // 2. Scan hudTexts
    for (const t of state.hudTexts) {
      const lower = t.toLowerCase().trim();
      if (CFG.builds[lower] && CFG.builds[lower].length) {
        state.currentMon = lower;
        return CFG.builds[lower];
      }
    }
    for (const t of state.hudTexts) {
      const lower = t.toLowerCase().trim();
      const match = allKeys.find(k => lower === k || lower.includes(k) || k.includes(lower));
      if (match) {
        state.currentMon = match;
        return CFG.builds[match];
      }
    }

    // 3. Scan DOM for pokemon name
    const domMon = document.querySelector('.player-name, [data-testid^="player-"], #mon-name, .character-name');
    if (domMon) {
      const dt = (domMon.innerText || domMon.dataset.testid || '').toLowerCase().replace('player-', '').trim();
      const match = allKeys.find(k => dt === k || dt.includes(k) || k.includes(dt));
      if (match) {
        state.currentMon = match;
        return CFG.builds[match];
      }
    }

    // 4. Input in Moveset panel if open or set
    const monInput = document.getElementById('psb-mon-name') || document.querySelector('[data-ms="mon"]');
    if (monInput && monInput.value) {
      const val = monInput.value.toLowerCase().trim();
      if (CFG.builds[val]) {
        state.currentMon = val;
        return CFG.builds[val];
      }
    }

    // 5. Scan text in HUD, picks, or DOM for known skills in builds (e.g. Vine Whip -> kartana)
    const allTextToScan = [...state.hudTexts, ...Object.keys(state.picks), document.body?.innerText || ''].join(' ').toLowerCase();
    let bestBuildKey = null;
    let bestBuildMatchCount = 0;
    for (const k of allKeys) {
      const moves = CFG.builds[k];
      let matches = 0;
      for (const m of moves) {
        if (allTextToScan.includes(m.toLowerCase())) matches++;
      }
      if (matches > bestBuildMatchCount) {
        bestBuildMatchCount = matches;
        bestBuildKey = k;
      }
    }
    if (bestBuildKey && bestBuildMatchCount > 0) {
      state.currentMon = bestBuildKey;
      return CFG.builds[bestBuildKey];
    }

    // 6. Default to first build (e.g. kartana)
    return CFG.builds[allKeys[0]];
  };
  function readCard(k, idx = 0) {
    let card = k;
    while (card.parentElement && card.parentElement !== document.body) {
      if (card.parentElement.offsetHeight > 350) break;
      const digitsInParent = [...card.parentElement.querySelectorAll('*')].filter(e => !e.children.length && visible(e) && /^[1-4]$/.test((e.innerText || '').trim()));
      if (digitsInParent.length > 1) break;
      card = card.parentElement;
    }
    const t = card.innerText || '';
    // In PokéSurvivor, title is in div.nm (alongside span.tag-chip).
    // If div.nm exists, clone it and strip .tag-chip to get clean move/card name.
    let name = '';
    const nmEl = card.querySelector('.nm, [class*="name"]');
    if (nmEl) {
      const clone = nmEl.cloneNode(true);
      clone.querySelectorAll('.tag-chip, [class*="chip"], [class*="tag"]').forEach(c => c.remove());
      name = clone.innerText.trim();
    }
    if (!name) {
      const leaves = [...card.querySelectorAll('*')].filter(e => !e.children.length && e !== k && /\D/.test(e.innerText || ''));
      const title = leaves.reduce((b, e) => (!b || fontSize(e) > fontSize(b) ? e : b), null);
      name = title ? title.innerText.trim() : '';
    }
    // Clean name from arrows, level text
    name = name.replace(/\s*→.*$/, '').replace(/\s*\b(?:Lv|Nv|Niv)\.?\s*\d+.*$/i, '').trim();

    let currLevel = 0;
    const targetLvMatch = t.match(/(?:Lv|Nv|Niv)\.?\s*\d+\s*(?:>|→)\s*(\d+)/i);
    if (targetLvMatch) {
      currLevel = +targetLvMatch[1] - 1;
    } else {
      const singleLv = t.match(/\b(?:Lv|Nv|Niv)\.?\s*(\d+)/i);
      if (singleLv) currLevel = +singleLv[1];
    }
    const isNew = /\bNew\b|Nuevo|Novo|Mới/i.test(t);
    const isEvo = CFG.evoRe.test(t) || /evo|awaken|ultimate/i.test(card.className + ' ' + [...card.querySelectorAll('[class]')].map(e => e.className).join(' '));
    const isUpgrade = />|→/i.test(t) || /\b(?:Lv|Nv|Niv)\.?\s*\d+\s*>/i.test(t);
    const inHud = state.hudTexts.has(name) || [...state.hudTexts].some(ht => ht.toLowerCase() === name.toLowerCase());
    const hasPicks = (state.picks[name] || 0) > 0;
    const hasLevel = currLevel >= 1;
    const isOwnedUpgrade = isEvo || isUpgrade || (!isNew && (hasLevel || inHud || hasPicks));
    const level = Math.max(currLevel, (state.picks[name] || 0) + (inHud ? 1 : 0), isOwnedUpgrade ? 1 : 0);

    const build = currentBuild() || [];
    const move1 = ((state.playerMoves && state.playerMoves[0]) || state.slotMoves?.[1] || build[0] || '').toLowerCase().trim();
    const move2 = ((state.playerMoves && state.playerMoves[1]) || state.slotMoves?.[2] || build[1] || '').toLowerCase().trim();
    const move3 = (build[2] || '').toLowerCase().trim();
    const move4 = (build[3] || '').toLowerCase().trim();

    const matchName = targetMove => {
      if (!targetMove) return false;
      const nb = name.toLowerCase().trim();
      const tb = t.toLowerCase();
      if (nb === targetMove) return true;
      if (nb && (nb.startsWith(targetMove) || targetMove.startsWith(nb))) return true;
      const re = new RegExp('\\b' + targetMove.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'i');
      return re.test(tb) || re.test(nb);
    };

    const isMove1 = matchName(move1);
    const isMove2 = matchName(move2);
    const isMove3 = matchName(move3);
    const isMove4 = matchName(move4);
    const buildIdx = build ? build.findIndex(m => matchName((m || '').toLowerCase().trim())) : -1;

    const why = [];
    let score = 0;

    // Thứ tự ưu tiên chính xác theo yêu cầu người dùng:
    // 1. Tiến hoá (Evo / Awaken)
    // 2. Skill 1 đã chọn (Slot 1 của người chơi)
    // 3. Skill 2 đã chọn (Slot 2 của người chơi)
    // 4. Skill 3 trong Moveset
    // 5. Skill 4 trong Moveset
    // 6. Skill khác trong Moveset
    // 7. Dame > Cooldown > Thủ / Máu > Tiện ích > Chọn đại

    if (isEvo) {
      score += 2500;
      why.push('tiến hoá skill');
    } else if (isMove1) {
      // Ưu tiên cao nhất: Skill 1 người chơi đã chọn!
      score += 2200 + level * 20;
      why.push(`★ Skill 1 đã chọn (${move1 || name}) cấp ${level}`);
    } else if (isMove2) {
      // Ưu tiên thứ hai: Skill 2 người chơi đã chọn!
      score += 1900 + level * 20;
      why.push(`★ Skill 2 đã chọn (${move2 || name}) cấp ${level}`);
    } else if (isMove3) {
      // Ưu tiên thứ ba: Skill 3 trong Moveset!
      score += 1500 + level * 15;
      why.push(`★ Skill 3 moveset (${move3 || name}) cấp ${level}`);
    } else if (isMove4) {
      // Ưu tiên thứ tư: Skill 4 trong Moveset!
      score += 1200 + level * 15;
      why.push(`★ Skill 4 moveset (${move4 || name}) cấp ${level}`);
    } else if (buildIdx >= 0) {
      score += 1000 + level * 10;
      why.push(`Skill moveset #${buildIdx + 1} (${build[buildIdx]}) cấp ${level}`);
    } else {
      const isDmgBuff = /damage|dmg|power|attack|crit|might|strength|sát thương|tấn công|dame|area|pierce|projectile|fuerza|daño|ataque|dégât/i.test(t);
      const isCooldownBuff = !isDmgBuff && /cooldown|cool[- ]down|recharge|reflex|reflexes|hồi chiêu|giảm.*hồi|reducci[oó]n.*enfriamiento/i.test(t);
      const isDefBuff = /hp|health|heal|regen|armor|armour|defense|defen|phòng thủ|giáp|máu|hồi phục|shield|barrier|vigor|resilience|vida|salud|defensa/i.test(t);
      const isUtilityBuff = /speed|movement|magnet|pickup|xp|exp|egg|lucky|gold|coin/i.test(t);

      if (isDmgBuff) {
        score += 350 + (isOwnedUpgrade ? level * 5 : 0);
        why.push(`buff dame (${name || 'sát thương'}) cấp ${level}`);
      } else if (isCooldownBuff) {
        score += 280 + (isOwnedUpgrade ? level * 5 : 0);
        why.push(`buff cooldown (${name || 'hồi chiêu'}) cấp ${level}`);
      } else if (isDefBuff) {
        score += 180 + (isOwnedUpgrade ? level * 5 : 0);
        why.push(`buff thủ / máu (${name || 'thủ'}) cấp ${level}`);
      } else if (isUtilityBuff) {
        score += 90 + (isOwnedUpgrade ? level * 3 : 0);
        why.push('buff tiện ích');
      } else if (isOwnedUpgrade) {
        score += 60 + level * 3;
        why.push(`nâng cấp skill đang có (${name}) cấp ${level}`);
      } else {
        score += 20;
        why.push('chọn đại buff khác');
      }
    }

    if (card.querySelector('.fit-low')) { score -= 2; why.push('hợp kém với pokémon'); }
    if (card.querySelector('.fit-high')) { score += 2; why.push('hợp tốt'); }
    if (CFG.bonusRe && CFG.bonusRe.test(t)) { score += CFG.bonusScore || 0; why.push('ưu tiên preset'); }

    let keyStr = (k.innerText || '').trim();
    if (!/^[1-4]$/.test(keyStr)) {
      const m = t.match(/\b([1-4])\b/);
      keyStr = m ? m[1] : String(idx + 1);
    }

    return {
      key: keyStr,
      keyEl: k,
      name: name || t.split('\n')[0].slice(0, 30),
      isNew,
      isEvo,
      isMove1,
      isMove2,
      isMove3,
      isMove4,
      isOwnedUpgrade,
      buildIdx,
      score,
      why: why.join(', '),
      text: t.replace(/\s+/g, ' ').slice(0, 100),
      el: card
    };
  }

  const isChoiceOpen = () => {
    const lvl = document.getElementById('lvl-num');
    if (lvl && visible(lvl)) return true;
    const choice = document.querySelector('.ps-choice:not(.hidden), [data-testid="choice"]:not(.hidden)');
    if (choice && visible(choice)) return true;
    // Check if ANY VISIBLE element contains "Level X!" or "Choose a reward"
    const visibleHeaders = [...document.querySelectorAll('h1, h2, h3, h4, div, span')].filter(el => {
      if (!visible(el) || el.children.length > 2) return false;
      const t = (el.innerText || '').trim();
      return /\b(?:Level\s*\d+!|Choose a reward)\b/i.test(t);
    });
    if (visibleHeaders.length > 0) return true;
    const rr = document.querySelector('[data-testid="reroll"], button.reroll') ||
               [...document.querySelectorAll('button, div')].find(b => visible(b) && /^Reroll/i.test((b.innerText || '').trim()));
    if (rr && visible(rr)) return true;
    return false;
  };

  function findChoiceKeys() {
    let keys = [...document.querySelectorAll('div.key, .ps-card .key, [class*="card"] [class*="key"], [data-choice] [class*="key"]')].filter(visible);
    if (keys.length) return keys;

    // Search for leaf elements with text "1", "2", "3" inside choice modal or on screen
    const allDigits = [...document.querySelectorAll('div, button, span, p')].filter(e => {
      if (!visible(e) || e.children.length) return false;
      const t = (e.innerText || '').trim();
      if (!/^[1-4]$/.test(t)) return false;
      if (e.closest('#psb-dock, [data-psbot-ui], [data-ms]')) return false;
      return true;
    });
    const cardDigits = allDigits.filter(d => {
      let p = d.parentElement;
      while (p && p !== document.body && p.innerText.length < 250) {
        if (/Lv|Nv|cooldown|damage|HP|Common|Rare|Epic|stack|power|move/i.test(p.innerText)) return true;
        p = p.parentElement;
      }
      return false;
    });
    return cardDigits.length ? cardDigits : allDigits;
  }

  function levelUp() {
    if (!CFG.autoPick || !isChoiceOpen() || performance.now() < state.pickAt) return;
    const keys = findChoiceKeys();
    if (!keys.length) return;
    const cards = keys.map((k, idx) => readCard(k, idx)).sort((a, b) => b.score - a.score);
    state.pickAt = performance.now() + 400;

    // Current modal identifier (e.g. "15" from "Level 15!") to track reroll once per level
    const modalHeaders = [...document.querySelectorAll('h1, h2, h3, h4, div')].filter(e => visible(e) && /Level\s*\d+!/i.test(e.innerText || ''));
    const lvlText = modalHeaders[0] ? modalHeaders[0].innerText : cards.map(c => c.name).join('|');
    if (state.currentModalLvl !== lvlText) {
      state.currentModalLvl = lvlText;
      state.rerolledThisLvl = false;
    }

    // Check if reroll button is actually available and usable
    const rrBtn = document.querySelector('[data-testid="reroll"], button.reroll') ||
                  [...document.querySelectorAll('button, div')].find(b => visible(b) && /\breroll\b/i.test(b.innerText));
    let canReroll = false;
    if (rrBtn && visible(rrBtn) && !rrBtn.disabled && !rrBtn.classList.contains('disabled') && rrBtn.getAttribute('aria-disabled') !== 'true') {
      const txt = (rrBtn.innerText || '').trim();
      const m = txt.match(/\((\d+)\)/) || txt.match(/\b(\d+)\b/);
      if (m) {
        canReroll = parseInt(m[1], 10) > 0;
      } else {
        const rrEl = document.getElementById('lvl-rr-n');
        if (rrEl) canReroll = (parseInt(rrEl.innerText, 10) || 0) > 0;
        else canReroll = !state.rerolledThisLvl;
      }
    }

    // Kiểm tra xem trong các thẻ thưởng có thẻ ưu tiên không:
    // Tiến hoá (Evo) | Skill 1 đã chọn | Skill 2 đã chọn | Skill 3 moveset | Skill 4 moveset | Skill trong build
    const hasPriorityMatch = cards.some(c => c.isEvo || c.isMove1 || c.isMove2 || c.isMove3 || c.isMove4 || c.buildIdx >= 0);

    // Nếu không có bất kỳ skill ưu tiên nào trong các lựa chọn và còn lượt Reroll -> Reroll tìm skill
    if (!hasPriorityMatch && canReroll && !state.rerolledThisLvl) {
      state.rerolledThisLvl = true;
      log(`Không có skill ưu tiên (Skill 1, 2, 3, 4 hoặc Tiến hoá) -> thử Reroll`);
      state.pickAt = performance.now() + 450;
      if (rrBtn) simulateClick(rrBtn);
      tap('r', 'KeyR', 82);
      return;
    }

    // Tiến hành chọn thẻ có điểm ưu tiên cao nhất:
    const c = cards[0];
    state.picks[c.name] = (state.picks[c.name] || 0) + 1;
    if (c.isNew) {
      state.newSkills++;
      if (!state.playerMoves) state.playerMoves = [];
      if (!state.playerMoves.includes(c.name)) state.playerMoves.push(c.name);
    }
    log('TỰ ĐỘNG CHỌN THƯỞNG:', c.key, c.name, '—', c.why, `(điểm: ${c.score})`);

    // 1. Mouse click simulation on card, inner button, and digit key element
    if (c.el) {
      simulateClick(c.el);
      const btn = c.el.tagName === 'BUTTON' ? c.el : c.el.closest('button, [role="button"]');
      if (btn) simulateClick(btn);
    }
    if (c.keyEl && c.keyEl !== c.el) {
      simulateClick(c.keyEl);
    }

    // 2. Dispatch key only to the dialog element if needed, NEVER send Digit3/Digit4 to canvas!
    try {
      const keyNum = parseInt(c.key, 10);
      const ev = new KeyboardEvent('keydown', { key: c.key, code: !isNaN(keyNum) ? `Digit${keyNum}` : `Key${c.key.toUpperCase()}`, bubbles: true });
      if (c.el) c.el.dispatchEvent(ev);
    } catch {}

    // Sau khi chọn thẻ xong, lập tức reset về Skill 1 ưu tiên
    setTimeout(() => {
      tap('1', 'Digit1', 49);
    }, 120);
  }

  // Only while the run timer is ticking and no level-up is open: the dialogs also use digit hotkeys
  function useItems(t) {
    if (!CFG.useItems || !state.on || t < (state.itemAt || 0)) return;
    if (!state.timerText || t - state.timerChangedAt > 1100 || isChoiceOpen()) return;
    state.itemAt = t + CFG.itemEvery;
    CFG.itemKeys.forEach(k => tap(k, `Digit${k}`, 48 + +k));
  }

  function swapSkills(t) {
    if (!state.on || !state.timerText || t - state.timerChangedAt > 1100 || isChoiceOpen()) return;

    // 1) Khi có Rift: CHUYỂN QUA SKILL 2 ĐỂ CHẠY/DASH VÔ CỔNG RIFT!
    const isRushingToRift = !state.insideRift && (
      (state.view?.target && state.view.target.isRift) ||
      (state.riftIndicator && (t - state.riftIndicator.at < 6000)) ||
      (state.view?.rifts && state.view.rifts.length > 0)
    );
    if (isRushingToRift) {
      if (t > (state.riftSlotAt || 0)) {
        state.riftSlotAt = t + 250;
        tap('2', 'Digit2', 50);
      }
      return;
    }

    // 2) Khi ở trong Rift đánh Boss (insideRift):
    // Dùng Skill 1 và 2 luân phiên để đánh boss (nếu đã kết hợp thì khóa Skill 1)
    if (state.insideRift) {
      if (state.hasBonded) {
        if (t > (state.bondedLockAt || 0)) {
          state.bondedLockAt = t + 200;
          tap('1', 'Digit1', 49);
        }
        return;
      }
      if (t > (state.swapAt || 0)) {
        state.swapAt = t + 100; // Đổi qua lại giữa skill 1 và 2 liên tục để đánh boss
        state.skillToggle = state.skillToggle === 1 ? 2 : 1;
        const slot = state.skillToggle;
        tap(String(slot), `Digit${slot}`, 48 + slot);
      }
      return;
    }

    // 3) Bình thường ở ngoài map (chưa có Rift):
    // SKILL 1 LÀ ƯU TIÊN DUY NHẤT! TUYỆT ĐỐI KHÔNG ĐỔI QUA SKILL 2, 3 HAY 4!
    if (t > (state.overworldSkill1At || 0)) {
      state.overworldSkill1At = t + 250;
      tap('1', 'Digit1', 49);
    }
  }

  // ---------- choice dialogs: held item ("An item!") and move bonding ("Bond!") ----------
  // Climb from the header to the first ancestor that `isDialog` accepts, then split it into
  // option rows: one per single-digit hotkey, widened while the ancestor holds only that digit.
  function dialogRows(head, isDialog) {
    let dialog = head;
    while (dialog.parentElement && !isDialog(dialog)) dialog = dialog.parentElement;
    const digits = [...dialog.querySelectorAll('*')].filter(e => !e.children.length && visible(e) && /^\d$/.test((e.innerText || '').trim()));
    return digits.map(k => {
      let row = k;
      while (row.parentElement && row.parentElement !== dialog && [...row.parentElement.querySelectorAll('*')].filter(e => digits.includes(e)).length === 1) row = row.parentElement;
      return { key: k.innerText.trim(), text: row.innerText.replace(/\s+/g, ' ').trim(), el: row };
    }).filter(o => o.text.length > 3);
  }
  function pickRow(kind, opts) {
    if (!opts.length) return;
    opts.sort((a, b) => b.score - a.score);
    state.pickAt = performance.now() + 800;
    console.table(opts);
    log(kind, opts[0].key, opts[0].name || '?', opts[0].why || '');
    if (kind === 'bond') {
      state.hasBonded = true;
      state.bondedSlot = 1;
      log('đã chọn kết hợp chiêu -> tự động chọn & khoá dùng chiêu 1 kết hợp vĩnh viễn');
    }
    if (opts[0].el) {
      const btn = opts[0].el.tagName === 'BUTTON' ? opts[0].el : opts[0].el.closest('button');
      if (btn) btn.click();
    }
    // Sau khi chọn item/bond, lập tức đưa về Skill 1
    setTimeout(() => {
      tap('1', 'Digit1', 49);
    }, 120);
  }
  function dialogPick() {
    const now = performance.now();
    if (!CFG.autoPick || !state.on || now < state.pickAt || now < (state.itemScanAt || 0)) return;
    state.itemScanAt = now + 300;                                     // full DOM scan, so not every frame
    const head = [...document.querySelectorAll('body *')].find(e => !e.children.length && visible(e) && /only hold one|An item!|Bond!|to bond/i.test(e.innerText || ''));
    if (!head) return;

    if (/bond/i.test(head.innerText)) {
      // TUYỆT ĐỐI CHỈ KẾT HỢP CHIÊU 1 VỚI CHIÊU 2, KHÔNG KẾT HỢP TỪA LƯA!
      const g = window.__psGame?.run?.conn?.game;
      const selfP = g?.players?.find(p => p.id === window.__psGame?.run?.conn?.selfId) || g?.self;
      const engineMoves = (Array.isArray(selfP?.moves) && selfP.moves.length) ? selfP.moves.map(m => {
        if (!m) return '';
        if (typeof m === 'string') return m.toLowerCase().trim();
        return (m.name || m.title || m.id || m.key || '').toLowerCase().trim();
      }).filter(Boolean) : (state.playerMoves || []);
      const build = currentBuild() || [];
      const m1 = (engineMoves[0] || state.slotMoves?.[1] || (build[0] || '')).toLowerCase().trim();
      const m2 = (engineMoves[1] || state.slotMoves?.[2] || (build[1] || '')).toLowerCase().trim();

      const rows = dialogRows(head, el => el.querySelector?.('.bond-title') || el.classList?.contains('dialog') || (el.innerText.match(/\b(?:Nv|Lv|Niv)\.?\s*\d/gi) || []).length >= 2 || el.querySelector?.('.key, button'));
      pickRow('bond', rows.map(o => {
        const textLower = o.text.toLowerCase();
        const keyNum = parseInt(o.key, 10);
        let score = 0;
        let why = '';

        const hasM1 = m1 && (textLower.includes(m1) || m1.includes(textLower));
        const hasM2 = m2 && (textLower.includes(m2) || m2.includes(textLower));

        // 1. Cặp kết hợp chứa cả Chiêu 1 VÀ Chiêu 2: Ưu tiên tuyệt đối cao nhất!
        if (hasM1 && hasM2) {
          score = 3000;
          why = `CẶP CHIÊU 1 + 2 (${m1} + ${m2}) · ƯU TIÊN SỐ 1`;
        }
        // 2. Chọn Chiêu 1 (Base move):
        else if (hasM1) {
          score = 2500;
          why = `CHIÊU 1 (${m1}) làm chiêu gốc kết hợp`;
        }
        // 3. Chọn Chiêu 2 (Secondary move để gộp vào chiêu 1):
        else if (hasM2) {
          score = 2200;
          why = `CHIÊU 2 (${m2}) kết hợp vào chiêu 1`;
        }
        // 4. Nếu không nhận dạng được tên text: dùng thứ tự Slot 1 và Slot 2
        else if (keyNum === 1) {
          score = 1500;
          why = `Slot 1 (chiêu 1)`;
        } else if (keyNum === 2) {
          score = 1200;
          why = `Slot 2 (chiêu 2)`;
        } else {
          // TUYỆT ĐỐI KHÔNG CHỌN CHIÊU 3 HAY CHIÊU 4!
          score = -1000 - (keyNum || 0);
          why = `Chiêu khác không phải 1 & 2 (BỎ QUA)`;
        }
        return { ...o, name: o.text, score, why };
      }));
      return;
    }

    // Held item: keep / switch by CFG.itemScores
    const names = Object.keys(CFG.itemScores);
    pickRow('chọn đồ', dialogRows(head, el => names.some(n => el.innerText.toLowerCase().includes(n)) || /shell|bell|heal|orb|nấm/i.test(el.innerText)).map(o => {
      const lower = o.text.toLowerCase();
      const name = names.find(n => lower.includes(n));
      const keep = /^keep|giữ|mantener|conservar/i.test(o.text);
      const isShellBell = /shell[- ]bell|heal.*damage|hồi máu|damage.*deal|nấm/i.test(lower);
      const isLifeOrb = /life[- ]orb|drain.*hp|mất máu/i.test(lower);

      let score = -1;
      let why = '';
      if (isLifeOrb) {
        score = -999;
        why = '(bỏ qua - tăng dame mất máu)';
      } else if (keep && isShellBell) {
        score = 9999;       // Tuyệt đối giữ Shell Bell (nấm vàng hồi máu), không bao giờ đổi!
        why = '(giữ Shell Bell / nấm vàng hồi máu vĩnh viễn)';
      } else if (isShellBell) {
        score = 100;
        why = '(ưu tiên Shell Bell / nấm vàng hồi máu)';
      } else {
        const dump = keep && (CFG.swapAwayItems.includes(name) || isLifeOrb);
        score = dump ? -2 : name ? CFG.itemScores[name] + (keep ? 0.5 : 0) : -1;
        why = dump ? '(giữ — muốn bỏ)' : keep ? '(giữ)' : '';
      }
      return { ...o, name, keep, score, why };
    }));
  }

  // ---------- auto replay ----------
  // Runs forever (game over -> Back to menu -> Play -> ...) until the bot is switched off with F8.
  // Acts when the game-over screen or the main menu's Play button is on screen, or as a fallback
  // when the HUD timer has stopped ticking (the menu background may keep rendering the map).
  // Helper to find clickable button / link / div matching regex
  function findClickable(re, avoidRe) {
    const candidates = [...document.querySelectorAll('button, [role="button"], a, div, span')].filter(el => {
      if (!visible(el)) return false;
      if (el.closest('#psb-dock, [data-psbot-ui], [data-ms]')) return false;
      const text = (el.innerText || '').trim();
      if (!text || text.length > 50) return false;
      if (avoidRe && avoidRe.test(text)) return false;
      return re.test(text);
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aBtn = (a.tagName === 'BUTTON' || a.getAttribute('role') === 'button') ? 1 : 0;
      const bBtn = (b.tagName === 'BUTTON' || b.getAttribute('role') === 'button') ? 1 : 0;
      if (aBtn !== bBtn) return bBtn - aBtn;
      return a.children.length - b.children.length;
    });
    return candidates[0];
  }

  function clickBtn(b, desc) {
    if (!b) return false;
    log('tự chơi lại:', desc || b.innerText.trim());
    simulateClick(b);
    const parentBtn = b.closest('button, [role="button"]');
    if (parentBtn && parentBtn !== b) simulateClick(parentBtn);
    return true;
  }

  function autoRestart(now) {
    // 1) Chỉ tự động chơi lại khi bot đang BẬT (state.on === true)
    if (!CFG.autoRestart || !state.on || now < (state.restartAt || 0)) return;

    // Nếu đã hoàn thành đủ số ván mục tiêu (ví dụ đặt 5 ván, 999 ván nếu đặt mục tiêu):
    if (state.target && state.done >= state.target) {
      log(`Đã hoàn thành ${state.done}/${state.target} ván! Tự động dừng bot.`);
      control.stop();
      return;
    }

    state.restartAt = now + 700;

    // 2) Nếu đang trong trận đấu (timer đang chạy), tuyệt đối không restart!
    if (state.timerText && (now - state.timerChangedAt < 1200)) return;

    // 3) Paused for a choice (level-up / item / bond) is not the end of a run
    if (isChoiceOpen()) return;
    const leaves = [...document.querySelectorAll('body *')].filter(e => !e.children.length && visible(e));
    if (leaves.some(e => /only hold one|An item!|Bond!|to bond/i.test(e.innerText || ''))) return;

    // 4) Đang mở Menu Tạm Dừng (Pause Menu / Settings) khi ấn ESC: KHÔNG TỰ CLICK GÌ CẢ!
    const isPauseMenu = leaves.some(e => /^(resume|abandon run|give up|surrender|tiếp tục trận|bỏ cuộc)$/i.test((e.innerText || '').trim()));
    if (isPauseMenu) return;

    // 1) Màn hình Kết quả / Thất bại / Chiến thắng (Results / Game Over screen):
    // Check for "Play Again" / "Retry" / "Chơi lại" first (nếu có, chơi lại ngay tại chỗ)
    const playAgainBtn = findClickable(/play again|try again|retry|restart|jugar de nuevo|volver a jugar|chơi lại/i, CFG.restartAvoid);
    if (playAgainBtn) {
      if (!state.runCounted) {
        state.runCounted = true;
        state.done++;
        log(`Kết thúc ván! Đã hoàn thành ${state.done}${state.target ? `/${state.target}` : ''} ván`);
        renderCtl();
      }
      clickBtn(playAgainBtn, 'bấm Play Again / Chơi lại');
      return;
    }

    // Check for "Back to menu" / "Menu" / "Exit" button on results screen
    const exitBtn = document.querySelector('[data-testid="game-exit"], button.exit, .game-over button') ||
                    findClickable(/back to menu|volver al men[uú]|về menu|^(back|menu|exit|thoát)$/i, CFG.restartAvoid);
    if (exitBtn) {
      if (!state.runCounted) {
        state.runCounted = true;
        state.done++;
        log(`Kết thúc ván! Đã hoàn thành ${state.done}${state.target ? `/${state.target}` : ''} ván`);
        renderCtl();
      }
      clickBtn(exitBtn, 'bấm Back to menu / Về sảnh');
      return;
    }

    // Check for "Continue" / "OK" / "Next" dialog (e.g. results screen or level rewards popup)
    const continueBtn = findClickable(/^(continue|tiếp tục|continuar|next|ok|aceptar|close|cerrar|đóng)$/i, CFG.restartAvoid);
    if (continueBtn) {
      clickBtn(continueBtn, `bấm ${continueBtn.innerText.trim()}`);
      return;
    }

    // 2) Saved run on menu: if it is targetMode (Hyper), continue it; if other mode, end it to switch to targetMode
    const targetMode = CFG.gameMode || 'hyper';
    const isTargetMode = t => new RegExp(targetMode, 'i').test(t || '');
    const savedBox = document.querySelector('[data-testid="saved-run"]');
    if (savedBox && visible(savedBox)) {
      if (isTargetMode(savedBox.innerText)) {
        const contBtn = [...savedBox.querySelectorAll('button, [role="button"], div')].find(b => visible(b) && /continue|tiếp tục/i.test(b.innerText || ''));
        if (contBtn) {
          clickBtn(contBtn, `tiếp tục ván ${targetMode}`);
          return;
        }
      } else {
        const endBtn = [...savedBox.querySelectorAll('button, [role="button"], div')].find(b => visible(b) && /end|kết thúc|bỏ/i.test(b.innerText || ''));
        if (endBtn) {
          clickBtn(endBtn, `bỏ ván cũ để chuyển sang chế độ ${targetMode}`);
          return;
        }
      }
    }

    // 3) Check if Solo Setup / Picker is ALREADY OPEN (has confirmBtn, picker-foot, or mode buttons)
    const confirmBtn = document.querySelector('[data-testid$="-confirm"], .picker-foot button.primary, button.wide-btn, [data-testid="play-btn"]') ||
                       findClickable(/^(play|start|go!?|let'?s go|comenzar|empezar|bắt đầu|confirm|chơi)$/i, CFG.restartAvoid);
    const isSoloSetupOpen = !!(confirmBtn || document.querySelector('.picker-foot, .solo-setup, .mon-grid, .picker-container, [data-testid="picker"], [data-testid="solo-setup"]'));

    if (isSoloSetupOpen) {
      // 3a) On Solo setup: ensure target mode (Hyper) is selected!
      const isModeSelected = b => {
        if (b.classList.contains('on') || b.classList.contains('active') || b.classList.contains('selected') || b.classList.contains('is-active')) return true;
        if (b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true') return true;
        try {
          const bg = window.getComputedStyle(b).backgroundColor;
          const m = bg.match(/\d+/g);
          if (m && +m[0] > 140 && +m[1] > 120) return true; // filled button style
        } catch {}
        return false;
      };
      const targetModeBtn = findClickable(new RegExp(`^${targetMode}$`, 'i'), CFG.restartAvoid);
      if (targetModeBtn && !isModeSelected(targetModeBtn)) {
        clickBtn(targetModeBtn, `chọn chế độ ${targetMode}`);
        return;
      }

      // 3b) Click confirm / Play button to start run!
      if (confirmBtn && !confirmBtn.disabled) {
        state.runCounted = false; // Chuẩn bị cho ván mới
        clickBtn(confirmBtn, `bắt đầu trận mới: ${confirmBtn.innerText.trim()}`);
        return;
      }
    }

    // 4) If Solo setup is not yet open: click Solo on main menu
    const soloMenuBtn = document.querySelector('[data-testid="menu-solo"], [data-mode="solo"]') ||
                        findClickable(/^(solo)$/i, CFG.restartAvoid);
    if (soloMenuBtn && !isSoloSetupOpen) {
      clickBtn(soloMenuBtn, 'bấm Solo để vào cài đặt ván mới');
      return;
    }

    // 5) Fallback button clicking for any remaining menu steps
    for (const re of CFG.restartSteps) {
      const b = findClickable(re, CFG.restartAvoid);
      if (b) {
        clickBtn(b, `bấm ${b.innerText.trim()}`);
        return;
      }
    }
  }

  // ---------- leaderboard guard ----------
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, WS = WebSocket.prototype.send;
  const noopWrite = name => ({
    update: { name: name.replace(/\/documents\/.*$/, `/documents/profiles/${firebase.auth().currentUser.uid}`), fields: {} },
    updateMask: { fieldPaths: [] },
  });
  function filterFirestore(body) {
    const p = new URLSearchParams(body);
    let changed = false;
    for (const [k, v] of [...p]) {
      if (!/^req\d+___data__$/.test(k)) continue;
      let msg; try { msg = JSON.parse(v); } catch { continue; }
      if (!Array.isArray(msg.writes)) continue;
      msg.writes = msg.writes.map(w => {
        const name = (w.update && w.update.name) || w.delete || (w.transform && w.transform.document) || '';
        const path = name.replace(/^.*?\/documents\//, '');
        const hit = CFG.blockRank && CFG.rankRe.test(path);
        if (CFG.logNet) log(`firestore ${hit ? 'CHẶN' : 'ghi'}: ${path}`, hit ? '' : Object.keys((w.update && w.update.fields) || {}));
        if (!hit) return w;
        changed = true; state.netBlocked++;
        return noopWrite(name);
      });
      p.set(k, JSON.stringify(msg));
    }
    return changed ? p.toString() : body;
  }
  function filterRtdb(data) {
    let m; try { m = JSON.parse(data); } catch { return data; }
    const a = m && m.d && m.d.a, b = m && m.d && m.d.b;
    if (!b || (a !== 'p' && a !== 'm')) return data;
    const hit = CFG.blockRank && CFG.rankRe.test(b.p || '');
    if (CFG.logNet) log(`rtdb ${hit ? 'CHẶN' : 'ghi'}: ${b.p}`);
    if (!hit) return data;
    state.netBlocked++;
    m.d.a = 'm'; b.d = {};
    return JSON.stringify(m);
  }
  XMLHttpRequest.prototype.open = function (method, url, ...r) { this._psUrl = String(url); return XO.call(this, method, url, ...r); };
  XMLHttpRequest.prototype.send = function (body) {
    if (typeof body === 'string' && this._psUrl && this._psUrl.includes('/Firestore/Write/channel') && body.includes('___data__')) body = filterFirestore(body);
    return XS.call(this, body);
  };
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string' && /firebaseio|firebasedatabase/.test(this.url)) data = filterRtdb(data);
    return WS.call(this, data);
  };

  // ---------- overlay + HUD ----------
  const ov = document.createElement('canvas');
  ov.dataset.psbotUi = '';
  ov.style.cssText = 'position:fixed;pointer-events:none;z-index:99999';
  // Top-left dock (60px down: the pokémon's HP bar sits in that corner) stacking the control panel, the HUD line and the F6 catalog (CSS order keeps that order)
  const dock = document.createElement('div');
  dock.style.cssText = 'position:fixed;top:60px;left:0;z-index:99999;display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-height:calc(100vh - 44px);pointer-events:none';
  const hud = document.createElement('div');
  hud.style.cssText = 'order:2;font:12px monospace;background:#000a;color:#7cf;padding:4px 6px;border-radius:4px;pointer-events:none';
  dock.append(hud);
  document.body.append(ov, dock);
  function draw() {
    const cv = getCanvas();
    if (!cv) { ov.style.display = 'none'; return; }
    ov.style.display = 'block';
    const r = cv.getBoundingClientRect();
    Object.assign(ov.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    if (ov.width !== cv.width || ov.height !== cv.height) { ov.width = cv.width; ov.height = cv.height; }
    const g = ov.getContext('2d');
    g.clearRect(0, 0, ov.width, ov.height);
    const v = state.view;
    hud.textContent = tag.on
      ? (tag.pending ? `${tag.pending}: 1=tốt 2=nguy hiểm 3=rift 4=vật cản 5=buff 6=kinh nghiệm 7=vali 8=lồng 0=xoá nhãn Esc=huỷ` : 'GẮN NHÃN (F7): click vào vật trên màn hình')
      : `bot ${state.on ? 'ON' : 'OFF'} (F8) · ván ${state.done + 1}${state.target ? `/${state.target}` : ''} · [HYPER]${state.insideRift ? ' · [BOSS RIFT]' : (v?.riftDist || (state.riftIndicator && performance.now() - state.riftIndicator.at < 4500)) ? ' · [VÀO RIFT NGAY]' : ''}${state.hasBonded ? ` · [KHOÁ CHIÊU ${state.bondedSlot || 1} KẾT HỢP]` : ''}${state.unstuckMode ? ' · [GỠ KẸT VẬT CẢN]' : ' · [HIT & RUN]'}${state.dwell ? ` · mở vali ${(state.dwell.t / 1000).toFixed(1)}/${CFG.caseTime / 1000}s` : ''} · địch ${v ? v.enemies.length : 0} · đạn ${v ? (v.bullets?.length || 0) : 0} · exp ${v ? v.xps.length : 0} (hút ${Math.round(state.magnet)}) · vật phẩm ${v ? v.goods.length : 0} · cản đã nhớ ${state.walls.length} · chặn rank ${state.netBlocked}`;
    if (tag.on && tag.box) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(tag.box.x - tag.box.w / 2, tag.box.y - tag.box.h / 2, tag.box.w, tag.box.h); }
    if (state.highlight) {
      g.strokeStyle = '#0ff'; g.lineWidth = 2;
      state.lastFrame.forEach(d => { if (d.src === state.highlight) g.strokeRect(d.x - Math.abs(d.w) / 2 - 3, d.y - Math.abs(d.h) / 2 - 3, Math.abs(d.w) + 6, Math.abs(d.h) + 6); });
    }
    // Hide world markers while the game is paused / on menus (they'd be drawn over the dialogs)
    if (!state.debug || !v || performance.now() - (state.timerChangedAt || 0) > 1500) return;
    g.lineWidth = 2;
    const ring = (list, color, r) => { g.strokeStyle = color; list.forEach(d => { g.beginPath(); g.arc(d.x, d.y, r(d), 0, 7); g.stroke(); }); };
    ring(v.enemies, '#f44', () => 10);
    // Cages / Caged Pokémon (bright amber ring + inner gold ring)
    if (v.cages?.length) {
      ring(v.cages, '#f80', () => 20);
      ring(v.cages, '#ff4', () => 14);
    }
    ring(v.hazards.filter(d => !d.shape), '#f90', d => Math.max(d.w, d.h) / 2 + CFG.hazardMargin * v.s);
    g.strokeStyle = '#f90';
    v.hazards.filter(d => d.shape).forEach(d => {
      g.lineWidth = d.shape === 'line' ? Math.max(2, d.lw) : 2;
      g.beginPath(); d.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (d.shape === 'poly') g.closePath();
      g.stroke();
    });
    // Bullets / projectiles (magenta ring + velocity vector line)
    if (v.bullets?.length) {
      ring(v.bullets.map(b => ({ x: b.sx, y: b.sy })), '#f0f', () => 6);
      g.strokeStyle = '#f0f'; g.lineWidth = 2;
      v.bullets.forEach(b => {
        if (b.speed > 0.5) {
          g.beginPath();
          g.moveTo(b.sx, b.sy);
          g.lineTo(b.sx + b.vx * v.s * 15, b.sy + b.vy * v.s * 15);
          g.stroke();
        }
      });
    }
    g.lineWidth = 2;
    ring(v.goods, '#4f4', () => 14);
    ring(v.rifts, '#f4f', () => 16);
    ring(v.buffs, '#ff0', () => 14);
    ring(v.xps, '#0fc', () => 4);
    ring(v.cases, '#fa0', () => Math.max(6, CFG.caseReach * v.s));
    g.strokeStyle = '#0fc6'; g.setLineDash([2, 6]); g.beginPath(); g.arc(v.me.x, v.me.y, state.magnet * v.s, 0, 7); g.stroke(); g.setLineDash([]);
    ring(v.walls || [], '#88f', d => (d.w ? Math.max(d.w, d.h) / 2 : 0) + 70 * v.s);
    g.strokeStyle = '#ff4'; g.beginPath(); g.arc(v.me.x, v.me.y, CFG.contact * v.s, 0, 7); g.stroke();
    if (v.target) { g.strokeStyle = '#fff8'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(v.me.x, v.me.y); g.lineTo(v.target.x, v.target.y); g.stroke(); g.setLineDash([]); }
    if (state.dir) { g.strokeStyle = '#4cf'; g.beginPath(); g.moveTo(v.me.x, v.me.y); g.lineTo(v.me.x + state.dir[0] * 40, v.me.y + state.dir[1] * 40); g.stroke(); }
  }

  // ---------- control panel: ▶ play N runs (0 = forever), ⏸ pause / resume, ■ stop ----------
  const RUNS_KEY = 'psbot.runs';
  // Events stopped at the bot's panels so typing / clicks / touches there never reach the game (keys, touch joystick)
  const UI_EVENTS = ['keydown', 'keyup', 'pointerdown', 'mousedown', 'click', 'touchstart', 'touchmove', 'touchend'];
  const ctl = document.createElement('div');
  ctl.dataset.psbotCtl = ctl.dataset.psbotUi = '';
  ctl.style.cssText = 'order:0;pointer-events:auto;font:12px monospace;background:#101418ee;color:#ddd;border:1px solid #345;border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px;min-width:190px';
  const btnCss = 'font:12px monospace;padding:3px 8px;border:1px solid #456;border-radius:4px;cursor:pointer;color:#000';
  ctl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-weight:bold;color:#7cf"><span style="flex:1">PokeSurvivor Bot v${VERSION} <a href="${REPO}" target="_blank" rel="noopener" style="font-weight:normal;color:#9ab;text-decoration:none" title="Repo gốc trên GitHub">· GitHub</a></span>
      <button data-ctl="min" style="${btnCss};background:#9ab;padding:0 8px" title="Thu gọn / mở rộng">–</button></div>
    <style>[data-psbot-ctl][data-min] > :not(:first-child) { display: none !important }
      @media (pointer: coarse) { [data-psbot-ui] button, [data-psbot-ui] select, [data-psbot-ui] input { min-height: 34px; font-size: 14px !important } }</style>
    <label style="display:flex;align-items:center;gap:6px">Số ván
      <input data-ctl="runs" type="number" min="0" step="1" style="width:60px;font:12px monospace;background:#223;color:#fff;border:1px solid #456;border-radius:3px;padding:2px 4px">
      <span style="color:#9ab">0 = vô hạn</span></label>
    <div style="display:flex;gap:4px">
      <button data-ctl="play" style="${btnCss};background:#4c4">▶ Chạy</button>
      <button data-ctl="pause" style="${btnCss};background:#fc3">⏸ Tạm dừng</button>
      <button data-ctl="stop" style="${btnCss};background:#f66">■ Dừng</button>
    </div>
    <div style="display:flex;gap:4px">
      <button data-ctl="moveset" style="${btnCss};background:#7cf;flex:1">⚔ Moveset</button>
      <button data-ctl="overlay" style="${btnCss};background:#9ab" title="Lớp vẽ debug (F9)">Overlay</button>
      <button data-ctl="catalog" style="${btnCss};background:#9ab" title="Danh mục sprite (F6)">Danh mục</button>
    </div>
    <div data-ctl="status" style="color:#9ab"></div>
    <a href="${REPO}" target="_blank" rel="noopener" title="Repo gốc — bấm để mở GitHub" style="order:1;border-top:1px solid #345;padding-top:4px;color:#9ab;text-decoration:none">⭐ <b style="color:#7cf">Duongnguyen0808</b> · github.com/Duongnguyen0808/poke</a>
    <a data-ctl="update" href="${REPO}" target="_blank" rel="noopener" style="display:none;color:#000;background:#fc3;border-radius:4px;padding:3px 6px;text-decoration:none;font-weight:bold"></a>`;
  dock.append(ctl);
  const $ = k => ctl.querySelector(`[data-ctl="${k}"]`);
  try { $('runs').value = localStorage.getItem(RUNS_KEY) || '5'; } catch { $('runs').value = '5'; }
  // Collapse to the title row (small screens); the <style> above hides every other row, the farm line included
  const MIN_KEY = 'psbot.min';
  const setMin = min => {
    if (min) ctl.dataset.min = ''; else delete ctl.dataset.min;
    $('min').textContent = min ? '+' : '–';
    try { localStorage.setItem(MIN_KEY, min ? '1' : ''); } catch {}
  };
  try { setMin(!!localStorage.getItem(MIN_KEY)); } catch {}
  $('min').onclick = () => setMin(!('min' in ctl.dataset));
  // Buttons for the F-key toggles (no function keys on phones)
  $('overlay').onclick = () => { state.debug = !state.debug; };
  $('catalog').onclick = () => toggleCatalog();
  // Keep typing / clicks in the panel away from the game's keyboard and pointer handlers
  UI_EVENTS.forEach(t => ctl.addEventListener(t, e => e.stopPropagation()));

  const control = {
    play() {
      const n = Math.max(0, Math.floor(+$('runs').value || 0));
      try { localStorage.setItem(RUNS_KEY, String(n)); } catch {}
      Object.assign(state, { target: n, done: 0, runEnded: false, on: true, started: true, restartAt: 0 });
      log(`chạy ${n ? `${n} ván` : 'vô hạn'}`);
    },
    pause() { state.on = false; state.unstuckMode = false; state.unstuckDir = null; applyDir(null); log('tạm dừng — bạn có thể tự điều khiển'); },
    resume() { state.on = true; state.immobileSince = performance.now(); log('tiếp tục'); },
    stop() { Object.assign(state, { on: false, target: 0, done: 0, started: false, unstuckMode: false, unstuckDir: null }); applyDir(null); log('dừng'); },
  };
  // Update check: compare with the manifest on the original repo (copies of the tool point here too)
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  async function checkUpdate() {
    try {
      const r = await fetch('https://raw.githubusercontent.com/Duongnguyen0808/poke/main/manifest.json', { cache: 'no-store' });
      const latest = (await r.json()).version;
      if (!latest || !newer(latest, VERSION)) return;
      $('update').style.display = 'block';
      $('update').textContent = `⬆ Có bản mới v${latest} (đang dùng v${VERSION}) → github.com/Duongnguyen0808/poke`;
      log(`có bản mới v${latest} — tải tại ${REPO}`);
    } catch {}
  }
  checkUpdate();
  const updateTimer = setInterval(checkUpdate, 6 * 3600000);

  $('play').onclick = () => control.play();
  $('pause').onclick = () => (state.on ? control.pause() : control.resume());
  $('stop').onclick = () => control.stop();

  function renderCtl() {
    const finished = state.target && state.done >= state.target;
    $('pause').textContent = state.on ? '⏸ Tạm dừng' : '▶ Tiếp tục';
    $('pause').disabled = !state.on && (!state.started || finished);      // nothing to resume
    $('status').textContent = finished ? `Đã xong ${state.done}/${state.target} ván`
      : !state.started && !state.on ? 'Chưa chạy — nhập số ván rồi bấm ▶'
      : `${state.on ? 'Đang chạy' : 'Tạm dừng'} · ván ${state.done + 1}${state.target ? `/${state.target}` : ' (vô hạn)'}`;
  }

  // ---------- moveset popup: pick up to 4 priority moves per pokémon from its learnable list (moves.js) ----------
  const MOVES = window.PSBotMoves || { moves: [], mons: {} };
  const learnable = name => (MOVES.mons[name.toLowerCase()] || []).map(i => MOVES.moves[i]);
  const currentMon = () => [...state.hudTexts].map(t => t.toLowerCase()).find(t => MOVES.mons[t]) || '';
  const ms = document.createElement('div');
  ms.dataset.psbotUi = '';
  ms.style.cssText = 'order:1;pointer-events:auto;width:300px;max-width:calc(100vw - 8px);font:12px monospace;background:#101418ee;color:#ddd;border:1px solid #345;border-radius:6px;padding:6px 8px;display:none;flex-direction:column;gap:5px';
  const inCss = 'font:12px monospace;background:#223;color:#fff;border:1px solid #456;border-radius:3px;padding:2px 4px';
  ms.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-weight:bold;color:#7cf">Moveset (4 move ưu tiên)<span data-ms="close" style="cursor:pointer;color:#9ab">✕</span></div>
    <div style="display:flex;gap:4px"><input data-ms="mon" list="psbot-mons" placeholder="Tên pokémon" style="${inCss};flex:1;min-width:0">
      <button data-ms="cur" style="${btnCss};background:#9ab" title="Pokémon đang chơi">Hiện tại</button></div>
    <datalist id="psbot-mons">${Object.keys(MOVES.mons).map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('')}</datalist>
    <div data-ms="slots" style="display:flex;flex-direction:column;gap:3px"></div>
    <div style="display:flex;gap:4px">
      <button data-ms="save" style="${btnCss};background:#4c4">Lưu</button>
      <button data-ms="del" style="${btnCss};background:#f66">Xoá build</button></div>
    <div data-ms="msg" style="color:#9ab"></div>
    <div data-ms="list" style="color:#9ab;max-height:120px;overflow:auto"></div>`;
  dock.append(ms);
  UI_EVENTS.forEach(t => ms.addEventListener(t, e => e.stopPropagation()));
  const $m = k => ms.querySelector(`[data-ms="${k}"]`);
  const moveLabel = m => `${m.name} · ${m.cat === 'status' ? 'buff' : `${m.kind} ${m.dmg ?? '?'}dmg/${m.cd ?? '?'}s`}`;
  function renderMoveset() {
    const name = $m('mon').value.trim().toLowerCase(), list = learnable(name), build = CFG.builds[name] || [];
    $m('slots').innerHTML = list.length ? [0, 1, 2, 3].map(i => `<label style="display:flex;gap:6px;align-items:center">#${i + 1}
      <select data-slot style="${inCss};flex:1;min-width:0"><option value="">(trống)</option>${list.map((m, j) =>
        `<option value="${m.name}" ${build[i] === m.name ? 'selected' : ''}>${j ? '' : '★ '}${moveLabel(m)}</option>`).join('')}</select></label>`).join('')
      : `<div style="color:#f96">${name ? 'Không có trong pokedex' : 'Chọn pokémon'}</div>`;
    const saved = Object.entries(CFG.builds);
    $m('list').innerHTML = saved.length ? 'Đã lưu: ' + saved.map(([n, b]) => `<a data-load="${n}" style="color:#7cf;cursor:pointer;text-decoration:underline" title="${b.join(', ')}">${n}</a>`).join(', ') : 'Chưa có build nào';
  }
  function openMoveset() {
    const show = ms.style.display === 'none';
    ms.style.display = show ? 'flex' : 'none';
    if (show) { if (!$m('mon').value) $m('mon').value = currentMon(); $m('msg').textContent = ''; renderMoveset(); }
  }
  $('moveset').onclick = openMoveset;
  $m('close').onclick = openMoveset;
  $m('mon').oninput = renderMoveset;
  $m('cur').onclick = () => { $m('mon').value = currentMon(); $m('msg').textContent = currentMon() ? '' : 'Chưa thấy tên pokémon trên màn (vào trận trước)'; renderMoveset(); };
  $m('save').onclick = () => {
    const name = $m('mon').value.trim();
    const moves = [...new Set([...ms.querySelectorAll('select[data-slot]')].map(s => s.value).filter(Boolean))];
    if (!learnable(name).length || !moves.length) return void ($m('msg').textContent = 'Chọn pokémon và ít nhất 1 move');
    window.PSBot.setBuild(name, moves);
    $m('msg').textContent = `Đã lưu ${name}: ${moves.join(' > ')}`; renderMoveset();
  };
  $m('del').onclick = () => {
    const name = $m('mon').value.trim();
    if (!CFG.builds[name.toLowerCase()]) return;
    window.PSBot.setBuild(name, []);
    $m('msg').textContent = `Đã xoá build ${name}`; renderMoveset();
  };
  $m('list').onclick = e => { const a = e.target.closest('[data-load]'); if (a) { $m('mon').value = a.dataset.load; renderMoveset(); } };

  // ---------- catalog (F6): every world sprite type seen, with thumbnail + stats ----------
  function toggleCatalog() { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; renderPanel(); }
  const catalog = new Map();   // src -> { src, img, rect, w, h, max, frames, lastSeen, speed, prev }
  function collect(frame) {
    const now = performance.now();
    const groups = new Map();
    for (const d of frame) {
      if (d.s === 1) continue;
      let g = groups.get(d.src);
      if (!g) groups.set(d.src, g = []);
      g.push({ x: (d.x - d.e) / d.s, y: (d.y - d.f) / d.s, d });
    }
    for (const [src, list] of groups) {
      let c = catalog.get(src);
      if (!c) {
        const d = list[0].d;
        catalog.set(src, c = { src, img: d.img, rect: d.rect, w: Math.round(Math.abs(d.w / d.s)), h: Math.round(Math.abs(d.h / d.s)), max: 0, frames: 0, speed: 0, prev: null });
      }
      c.max = Math.max(c.max, list.length); c.frames++; c.lastSeen = now;
      // Average per-frame displacement, matching each sprite to its nearest one in the previous frame
      if (c.prev && list.length <= 40) {
        let sum = 0, n = 0;
        for (const p of list) {
          let best = Infinity;
          for (const q of c.prev) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
          if (best < 60) { sum += best; n++; }
        }
        if (n) c.speed = c.speed * 0.9 + (sum / n) * 0.1;
      }
      c.prev = list.length <= 40 ? list : null;
    }
  }
  // Enemies last (already handled, no tagging needed), then on-screen sprites first, then by how rare they are per frame
  const catalogRows = () => {
    const now = performance.now(), live = c => now - c.lastSeen < 1500, enemy = c => CFG.enemyRe.test(c.src);
    return [...catalog.values()].sort((a, b) => enemy(a) - enemy(b) || live(b) - live(a) || a.max - b.max);
  };
  const thumbs = new Map();
  function thumb(c) {
    if (thumbs.has(c.src)) return thumbs.get(c.src);
    let url = '';
    const color = c.src.match(/^(?:fill|stroke):(.+)$/);
    if (color) {                                                      // path shapes: show their colour as a swatch
      const t = document.createElement('canvas'); t.width = t.height = 24;
      const tc = t.getContext('2d'); tc.fillStyle = color[1] === 'gradient' ? '#888' : color[1];
      pathOrig.fillRect.call(tc, 0, 0, 24, 24); url = t.toDataURL();
    } else if (c.img) {
      try {
        const t = document.createElement('canvas');
        const [sx, sy, sw, sh] = c.rect || [0, 0, c.img.width, c.img.height];
        const k = Math.min(40 / sw, 40 / sh, 4);
        t.width = Math.max(1, sw * k); t.height = Math.max(1, sh * k);
        const tc = t.getContext('2d'); tc.imageSmoothingEnabled = false;
        origDraw.call(tc, c.img, sx, sy, sw, sh, 0, 0, t.width, t.height);
        url = t.toDataURL();
      } catch {}
    }
    thumbs.set(c.src, url);
    return url;
  }

  const panel = document.createElement('div');
  panel.dataset.psbotUi = '';
  panel.style.cssText = 'order:3;pointer-events:auto;width:380px;max-width:calc(100vw - 8px);min-height:0;flex:0 1 auto;overflow:auto;font:11px monospace;background:#101418ee;color:#ddd;border:1px solid #345;border-radius:6px;display:none';
  dock.append(panel);
  const TAG_LABEL = { good: ['Tốt', '#4f4'], hazard: ['Nguy hiểm', '#f90'], rift: ['Rift', '#f4f'], wall: ['Vật cản', '#88f'], buff: ['Buff', '#ff0'], xp: ['Kinh nghiệm', '#0fc'], case: ['Vali (đứng 5s)', '#fa0'], cage: ['Lồng (đứng mở)', '#f80'], safe: ['An toàn', '#9cf'] };
  function renderPanel() {
    if (panel.style.display === 'none') return;
    const now = performance.now();
    const esc = s => s.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);
    panel.innerHTML = `<div style="padding:6px;border-bottom:1px solid #345">Danh mục sprite (F6 đóng) · rê chuột = khoanh trên màn hình · <b>đậm</b> = đang có trên màn
      <button data-export style="font:10px monospace;padding:1px 6px;margin-left:4px;background:#2a5;color:#000;border:1px solid #456;border-radius:3px;cursor:pointer" title="Tải data.js (nhãn + build) — chép đè vào thư mục extension">Xuất data.js</button></div>` +
      catalogRows().map(c => {
        const t = tagOf(c.src) || (/^(fill|stroke):/.test(c.src) && CFG.autoTelegraph && isTelegraph(c) ? 'hazard' : undefined);
        const live = now - c.lastSeen < 1500, enemy = CFG.enemyRe.test(c.src);
        const btn = (v, label, color) => `<button data-src="${esc(c.src)}" data-tag="${v}" style="font:10px monospace;padding:1px 4px;margin-right:2px;background:${t === v ? color : '#223'};color:${t === v ? '#000' : '#ccc'};border:1px solid #456;border-radius:3px;cursor:pointer">${label}</button>`;
        return `<div data-row="${esc(c.src)}" style="display:flex;gap:6px;align-items:center;padding:4px 6px;border-bottom:1px solid #223;${live ? 'font-weight:bold' : 'opacity:.55'}">
          <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#000">${thumb(c) ? `<img src="${thumb(c)}" style="image-rendering:pixelated;max-width:40px;max-height:40px">` : '?'}</div>
          <div style="flex:1;min-width:0">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.src)}">${esc(c.src)}</div>
            <div style="color:#9ab">${c.w}×${c.h} · tối đa ${c.max}/frame · ${c.speed > 1 ? `di chuyển ${c.speed.toFixed(1)}` : 'đứng yên'}${enemy ? ' · <span style="color:#f66">quái</span>' : ''}</div>
            <div style="margin-top:2px">${Object.entries(TAG_LABEL).map(([v, [l, col]]) => btn(v, l, col)).join('')}${btn('', 'Bỏ', '#888')}</div>
          </div></div>`;
      }).join('');
  }
  UI_EVENTS.forEach(t => panel.addEventListener(t, e => e.stopPropagation()));
  panel.addEventListener('click', e => {
    if (e.target.closest('button[data-export]')) return void window.PSBot.exportConfig();
    const b = e.target.closest('button[data-src]');
    if (!b) return;
    if (b.dataset.tag) CFG.tags[b.dataset.src] = b.dataset.tag; else if (b.dataset.src) { delete CFG.tags[b.dataset.src]; delete CFG.tags[b.dataset.src.split('#')[0]]; }
    saveTags(); renderPanel();
  });
  panel.addEventListener('mouseover', e => { const r = e.target.closest('[data-row]'); state.highlight = r ? r.dataset.row : null; });
  panel.addEventListener('mouseleave', () => { state.highlight = null; });

  // ---------- keep running in a background tab / covered window ----------
  // 1) The game pauses on visibilitychange / blur: swallow those and report the page as visible.
  // 2) Chrome stops requestAnimationFrame when the tab is hidden or the window fully covered:
  //    every rAF request is also queued, and a Web Worker tick (~60 Hz, not throttled like page
  //    timers) runs any callback the browser hasn't run within 40 ms.
  const nativeRAF = window.requestAnimationFrame, nativeCAF = window.cancelAnimationFrame;
  const visDesc = { hidden: Object.getOwnPropertyDescriptor(document, 'hidden'), visibilityState: Object.getOwnPropertyDescriptor(document, 'visibilityState') };
  const origHasFocus = document.hasFocus;
  const swallow = e => { if (CFG.background) e.stopImmediatePropagation(); };
  let bgWorker = null;
  if (CFG.background) {
    ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze'].forEach(t => window.addEventListener(t, swallow, true));
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;

    const pending = new Map();                                       // id -> { cb, at, native }
    let seq = 0;
    const run = id => { const p = pending.get(id); if (!p) return; pending.delete(id); nativeCAF.call(window, p.native); p.cb(performance.now()); };
    window.requestAnimationFrame = cb => {
      const id = ++seq;
      pending.set(id, { cb, at: performance.now(), native: nativeRAF.call(window, () => run(id)) });
      return id;
    };
    window.cancelAnimationFrame = id => { const p = pending.get(id); if (p) { nativeCAF.call(window, p.native); pending.delete(id); } };
    const fallback = () => { const now = performance.now(); for (const [id, p] of [...pending]) if (now - p.at > 40) run(id); };
    try {
      bgWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
      bgWorker.onmessage = fallback;
    } catch (err) {
      log('không tạo được Worker (CSP?) — chạy nền sẽ bị Chrome giới hạn ~1 khung hình/giây', err);
      bgWorker = { terminate: clearInterval.bind(null, setInterval(fallback, 16)) };
    }
  }

  // ---------- main loop ----------
  const origRAF = window.requestAnimationFrame.bind(window);
  let running = true, lastResend = 0, lastPanel = 0;
  function loop(t) {
    if (!running) return;
    const frame = state.frame; state.frame = [];
    if (state.texts.length) {
      state.hudTexts = new Set(state.texts); state.texts = [];
      const timer = [...state.hudTexts].find(x => /^\d+:\d\d$/.test(x));
      if (timer) state.lastTimer = t;                                                            // run timer on screen = in a run
      if (timer !== state.timerText) { state.timerText = timer; state.timerChangedAt = t; }      // frozen timer = game paused (menus)
      if ([...state.hudTexts].some(t => /^0:0[0-2]$/.test(t))) {
        state.picks = {};
        state.newSkills = 0;
        state.hasBonded = false;
        state.bondedSlot = 0;
        state.slotX = {};
        state.slotMoves = {};
        state.playerMoves = [];
        state.insideRift = false;
        state.insideRiftAt = 0;
        state.riftIndicator = null;
        state.runCounted = false;
      }   // new run
    }
    if (frame.length) { state.lastFrame = frame; collect(frame); tick(frame); }
    if (t - lastPanel > 1000 && !panel.matches(':hover')) { lastPanel = t; renderPanel(); }
    renderCtl();
    levelUp();
    dialogPick();
    useItems(t);
    swapSkills(t);
    autoRestart(t);
    if (state.on && t - lastResend > 400) {                    // re-assert held keys (game clears them on blur)
      lastResend = t;
      Object.keys(KEYS).forEach(k => state.keys[k] && sendKey('keydown', ...KEYS[k]));
    }
    draw();
    origRAF(loop);
  }
  origRAF(loop);

  // ---------- tag mode (F7): click an object, then press 1/2/3/0 ----------
  const tag = { on: false, pending: null, box: null };
  const TAGS = { Digit1: 'good', Digit2: 'hazard', Digit3: 'rift', Digit4: 'wall', Digit5: 'buff', Digit6: 'xp', Digit7: 'case', Digit8: 'cage' };
  const onClick = e => {
    if (!tag.on || !e.isTrusted) return;
    const cv = getCanvas();
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * cv.width / r.width, y = (e.clientY - r.top) * cv.height / r.height;
    const hit = state.lastFrame
      .filter(d => d.s !== 1 && Math.abs(d.x - x) <= Math.abs(d.w) / 2 + 4 && Math.abs(d.y - y) <= Math.abs(d.h) / 2 + 4)
      .sort((a, b) => Math.abs(a.w * a.h) - Math.abs(b.w * b.h))[0];
    e.preventDefault(); e.stopImmediatePropagation();
    tag.pending = hit ? hit.src : null; tag.box = hit || null;
    log(hit ? `chọn ${hit.src} (nhãn hiện tại: ${tagOf(hit.src) || 'không'})` : 'không có gì ở đó');
  };
  window.addEventListener('pointerdown', onClick, true);

  const onKey = e => {
    if (!e.isTrusted) return;
    if (e.code === 'F7') {
      tag.on = !tag.on; tag.pending = tag.box = null;
      if (tag.on) { state.on = false; applyDir(null); }
      e.preventDefault();
    }
    if (tag.on && tag.pending && (TAGS[e.code] || e.code === 'Digit0' || e.code === 'Escape')) {
      if (TAGS[e.code]) CFG.tags[tag.pending] = TAGS[e.code];
      else if (e.code === 'Digit0') delete CFG.tags[tag.pending];
      if (e.code !== 'Escape') { saveTags(); log(`${tag.pending} → ${CFG.tags[tag.pending] || 'không nhãn'}`); }
      tag.pending = tag.box = null;
      e.preventDefault(); e.stopImmediatePropagation();
    }
    if (e.code === 'F8') { state.on = !state.on; if (!state.on) { state.unstuckMode = false; state.unstuckDir = null; applyDir(null); } else state.immobileSince = performance.now(); log('bot', state.on ? 'ON' : 'OFF'); e.preventDefault(); }
    if (e.code === 'Escape') {
      // Khi người chơi bấm Escape: Tạm hoãn autoRestart 15s và tạm dừng bot nếu đang bật
      state.restartAt = performance.now() + 15000;
      if (state.on) {
        state.on = false;
        state.unstuckMode = false;
        state.unstuckDir = null;
        applyDir(null);
        renderCtl();
        log('[ESC] Bạn vừa bấm ESC: Đã tạm dừng bot và ngừng tự động vào trận. Bấm F8 hoặc ▶ Chạy để tiếp tục.');
      }
    }
    if (e.code === 'F9') { state.debug = !state.debug; e.preventDefault(); }
    if (e.code === 'F6') { toggleCatalog(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey, true);

  window.PSBot = {
    CFG, state, ctl,       // ctl = control panel (top-left); presets append their own lines to it
    // PSBot.play(5) = chơi 5 ván (0 = vô hạn) · PSBot.pause() / resume() / stop()
    play(n) { if (n !== undefined) $('runs').value = n; control.play(); },
    pause: () => control.pause(), resume: () => control.resume(), stop: () => control.stop(),
    sources() {
      const by = {};
      state.lastFrame.forEach(d => { (by[d.src] ||= []).push([Math.round(d.x), Math.round(d.y)]); });
      console.table(Object.entries(by).map(([src, pts]) => ({ src, tag: tagOf(src) || '', n: pts.length, sample: JSON.stringify(pts.slice(0, 3)) })));
    },
    catalog() {
      const rows = catalogRows().map(c => ({ src: c.src, tag: tagOf(c.src) || '', max: c.max, size: `${c.w}x${c.h}`, moving: c.speed.toFixed(1), seenSec: Math.round(c.frames / 60) }));
      console.table(rows);
      try { copy(JSON.stringify(rows)); log('đã copy danh mục vào clipboard'); } catch {}
    },
    tags() { console.table(CFG.tags); },
    // PSBot.setBuild('Kartana', ['Meteor Mash', 'Seed Bomb', 'Harden', 'Swords Dance']) · [] = delete
    setBuild(name, moves) {
      userBuilds[name.toLowerCase()] = moves;
      if (moves.length) CFG.builds[name.toLowerCase()] = moves; else delete CFG.builds[name.toLowerCase()];
      try {
        const saved = JSON.parse(localStorage.getItem(BUILD_KEY) || '{}');
        saved[name.toLowerCase()] = moves;
        localStorage.setItem(BUILD_KEY, JSON.stringify(saved));
      } catch {}
      log('build', name, moves);
    },
    resetTags() { CFG.tags = {}; saveTags(); },
    // Downloads data.js (tags + builds set with setBuild) to drop into the extension folder, so every machine gets them
    exportConfig() {
      const json = JSON.stringify({ tags: CFG.tags, builds: CFG.builds }, null, 2);
      const src = '// Nhãn sprite + build đã đánh dấu, đi kèm extension để máy nào cài cũng có sẵn.\n' +
        '// Tạo lại file này bằng nút "Xuất data.js" trong bảng F6 (hoặc PSBot.exportConfig()), rồi chép đè vào thư mục extension.\n' +
        `window.PSBotData = ${json};\n`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      a.download = 'data.js';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      log(`đã xuất data.js: ${Object.keys(CFG.tags).length} nhãn, ${Object.keys(CFG.builds).length} build — chép đè vào thư mục extension`);
    },
    unload() {
      running = false; applyDir(null); clearInterval(updateTimer);
      P.drawImage = origDraw; P.arc = origArc; P.fillText = origText;
      Object.assign(P, pathOrig);
      if (bgWorker) {
        bgWorker.terminate();
        window.requestAnimationFrame = nativeRAF; window.cancelAnimationFrame = nativeCAF;
        ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze'].forEach(t => window.removeEventListener(t, swallow, true));
        for (const k of ['hidden', 'visibilityState']) { if (visDesc[k]) Object.defineProperty(document, k, visDesc[k]); else delete document[k]; }
        document.hasFocus = origHasFocus;
      }
      XMLHttpRequest.prototype.open = XO; XMLHttpRequest.prototype.send = XS; WebSocket.prototype.send = WS;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onClick, true);
      ov.remove(); dock.remove();
      delete window.PSBot;
      log('unloaded');
    },
  };
  log(`loaded — F8 bật/tắt, F9 overlay, PSBot.sources() để xem sprite · v${VERSION} · ${REPO}`);
})();

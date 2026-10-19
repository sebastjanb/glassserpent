'use strict';

/* Glass Serpent — arena serpents for Meta Ray-Ban Display glasses.
   Steer a glowing serpent round a circular arena, eat crystals to grow and
   boost across a rival's path so it runs into you and bursts into food.
   Running your head into any other serpent, or the rim, ends the round.
     Left / Right   turn 45°  (head steering: turn your head)
     Up             boost for a moment (burns a little length)
     Down           brake turn: a tight 135° turn toward the side you last turned
     Pinch          pause
   After a takedown the last three seconds play back, so you see what happened. */

const VERSION = '1.0.0';
const { g, label, plate, banner, clamp, lerp, rand, beep, noise, head, store } = GK;
const TAU = Math.PI * 2;
const ARENA = 1500;
const SPEED = 125, BOOST = 230, TURN = 3.4;       // units/s, units/s, rad/s
const GAP = 7;                                      // spacing of body points
const RIVALS = 9, FOOD = 800;

let state = 'menu';    // menu | play | pause | replay | over
let me, snakes, food, time, best, kills, replay, replayI, killer, lastTurn = 1;
let steerHead = store.get('serpent.head', false);
best = store.get('serpent.best', 0);

const COLOURS = ['#5dffb4', '#ff6b6b', '#ffd34d', '#7fd8ff', '#ff9be0', '#b7a3ff', '#ffb35c', '#9be15d', '#ff5cc8', '#4fe3ff'];
const NAMES = ['Ember', 'Moss', 'Quill', 'Rune', 'Sable', 'Tansy', 'Vex', 'Wren', 'Zinc'];

function makeSnake(x, y, len, colour, ai, name) {
  const a = rand(0, TAU);
  const s = { x, y, a, want: a, len, colour, ai, name, pts: [], boost: 0, dead: false, think: 0, target: null, aggro: 0 };
  for (let i = 0; i < len / GAP; i++) s.pts.push({ x: x - Math.cos(a) * i * GAP, y: y - Math.sin(a) * i * GAP });
  return s;
}
const radius = (s) => 7 + Math.min(14, s.len / 110);

function spawnFood(x, y, value, colour) {
  food.push({ x: x !== undefined ? x : 0, y: y !== undefined ? y : 0, v: value || 1, c: colour || COLOURS[Math.floor(rand(0, COLOURS.length))], t: rand(0, 6) });
}
function randomFood() {
  const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (ARENA - 40);
  spawnFood(Math.cos(a) * d, Math.sin(a) * d, 1);
}
function randomSpot() {
  for (let k = 0; k < 40; k++) {
    const a = rand(0, TAU), d = rand(200, ARENA - 250);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    if (!snakes.some((s) => !s.dead && Math.hypot(s.x - x, s.y - y) < 300)) return { x, y };
  }
  return { x: 0, y: 0 };
}

function start() {
  snakes = []; food = [];
  me = makeSnake(0, 0, 70, COLOURS[0], false, 'You');
  snakes.push(me);
  for (let i = 0; i < RIVALS; i++) { const p = randomSpot(); snakes.push(makeSnake(p.x, p.y, rand(60, 260), COLOURS[i + 1], true, NAMES[i])); }
  for (let i = 0; i < FOOD; i++) randomFood();
  time = 0; kills = 0; replay = []; killer = null;
  state = 'play';
  if (steerHead) GK.recentre();
}

/* -------------------------------------------------------------- the AI */

function rayHit(s, ang, dist) {
  // Distance to the nearest thing that would kill s along a ray, or Infinity.
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let bestD = Infinity;
  for (let d = 20; d <= dist; d += 20) {
    const x = s.x + dx * d, y = s.y + dy * d;
    if (x * x + y * y > (ARENA - 30) * (ARENA - 30)) return d;
    for (const o of snakes) {
      if (o === s || o.dead) continue;
      if (Math.abs(o.x - x) > o.len + 60 || Math.abs(o.y - y) > o.len + 60) continue;
      const r = radius(o) + radius(s) + 6;
      for (let i = 0; i < o.pts.length; i += 2) {
        const p = o.pts[i];
        if (Math.abs(p.x - x) < r && Math.abs(p.y - y) < r) { bestD = Math.min(bestD, d); break; }
      }
      if (bestD <= d) return bestD;
    }
  }
  return bestD;
}

function think(s, dt) {
  s.think -= dt;
  if (s.think > 0) return;
  s.think = rand(0.12, 0.22);
  // 1. Danger ahead: pick the clearest of seven directions.
  const ahead = rayHit(s, s.a, 160);
  if (ahead < 160) {
    let bestA = s.a, bestD = -1;
    for (const off of [-1.6, -1, -0.5, 0.5, 1, 1.6, 2.6]) {
      const d = rayHit(s, s.a + off, 180);
      const score = Math.min(d, 400) - Math.abs(off) * 8;
      if (score > bestD) { bestD = score; bestA = s.a + off; }
    }
    s.want = bestA;
    s.boost = 0;
    return;
  }
  // 2. Cut off the player: get ahead of their head when we are long enough.
  const dp = Math.hypot(me.x - s.x, me.y - s.y);
  if (!me.dead && s.aggro > 0 && dp < 420 && s.len > me.len * 0.7) {
    const lead = 140;
    const tx = me.x + Math.cos(me.a) * lead, ty = me.y + Math.sin(me.a) * lead;
    s.want = Math.atan2(ty - s.y, tx - s.x);
    s.boost = dp < 260 && s.len > 120 ? 0.3 : 0;
    return;
  }
  // 3. Food: the richest crystal nearby, weighed by distance.
  let bestF = null, bv = -Infinity;
  for (const f of food) {
    const d = Math.hypot(f.x - s.x, f.y - s.y);
    if (d > 420) continue;
    const v = f.v * 60 - d - Math.abs(GK.angDiff(s.a, Math.atan2(f.y - s.y, f.x - s.x))) * 60;
    if (v > bv) { bv = v; bestF = f; }
  }
  if (bestF) s.want = Math.atan2(bestF.y - s.y, bestF.x - s.x);
  else if (Math.hypot(s.x, s.y) > ARENA * 0.6) s.want = Math.atan2(-s.y, -s.x) + rand(-0.6, 0.6);
  else if (Math.random() < 0.1) s.want = s.a + rand(-1, 1);
}

/* ---------------------------------------------------------------- update */

function moveSnake(s, dt) {
  const d = GK.angDiff(s.a, s.want);
  s.a += clamp(d, -TURN * dt, TURN * dt);
  let v = SPEED;
  if (s.boost > 0) {
    s.boost -= dt;
    if (s.len > 50) {
      v = BOOST;
      // Boosting sheds length as a trail of small crystals.
      s.len -= 22 * dt;
      if (Math.random() < 0.25) { const t = s.pts[s.pts.length - 1]; spawnFood(t.x, t.y, 0.5, s.colour); }
    }
  }
  s.x += Math.cos(s.a) * v * dt;
  s.y += Math.sin(s.a) * v * dt;
  // Body: a chain of points GAP apart, the first following the head.
  const h = s.pts[0];
  const dd = Math.hypot(s.x - h.x, s.y - h.y);
  if (dd >= GAP) s.pts.unshift({ x: s.x, y: s.y });
  const want = Math.max(4, Math.round(s.len / GAP));
  while (s.pts.length > want) s.pts.pop();
}

function burst(s, by) {
  s.dead = true;
  for (let i = 0; i < s.pts.length; i += 2) {
    const p = s.pts[i];
    spawnFood(p.x + rand(-6, 6), p.y + rand(-6, 6), 2, s.colour);
  }
  if (s === me) {
    killer = by;
    noise(0.6, 0.6, 400);
  } else {
    if (by === me) { kills++; beep(880, 0.15, 'triangle', 0.4); beep(1320, 0.2, 'triangle', 0.3); }
    noise(0.25, 0.3, 900);
  }
}

function collide(s) {
  if (s.x * s.x + s.y * s.y > ARENA * ARENA) return burst(s, 'rim');
  const r = radius(s);
  for (const o of snakes) {
    if (o === s || o.dead) continue;
    const ro = radius(o) + r * 0.6;
    if (Math.abs(o.x - s.x) > o.len + 50 || Math.abs(o.y - s.y) > o.len + 50) continue;
    for (let i = 0; i < o.pts.length; i++) {
      const p = o.pts[i];
      const dx = p.x - s.x, dy = p.y - s.y;
      if (dx * dx + dy * dy < ro * ro) {
        // Two heads meeting: the shorter serpent bursts.
        if (i < 2 && o.len <= s.len) return burst(o, s);
        return burst(s, o);
      }
    }
  }
}

function tick(dt) {
  if (state === 'replay') {
    replayI += dt * 20 * 0.5;    // half speed
    if (replayI >= replay.length - 1) state = 'over';
    return;
  }
  if (state !== 'play') return;
  time += dt;

  if (steerHead && GK.headLive()) me.want = me.a + clamp(head.yaw / 25, -1, 1) * 0.8;
  for (const s of snakes) {
    if (s.dead) continue;
    if (s.ai) { s.aggro -= dt; if (s.aggro < -6 && Math.random() < 0.01) s.aggro = rand(3, 7); think(s, dt); }
    moveSnake(s, dt);
  }
  for (const s of snakes) if (!s.dead) collide(s);

  // Eating.
  for (const s of snakes) {
    if (s.dead) continue;
    const r = radius(s) + 10;
    for (const f of food) {
      if (f.eaten) continue;
      const dx = f.x - s.x, dy = f.y - s.y;
      if (dx * dx + dy * dy < r * r) {
        f.eaten = true; s.len += 4 * f.v;
        if (s === me) beep(1200 + Math.random() * 400, 0.03, 'sine', 0.15);
      } else if (dx * dx + dy * dy < (r + 40) * (r + 40)) { f.x -= dx * 0.08; f.y -= dy * 0.08; }   // crystals drift into the mouth
    }
  }
  food = food.filter((f) => !f.eaten);
  while (food.length < FOOD) randomFood();

  // Fallen rivals come back after a while, somewhere quiet.
  snakes = snakes.filter((s) => !s.dead || s === me);
  while (snakes.length < RIVALS + 1) {
    const p = randomSpot();
    const i = Math.floor(rand(0, NAMES.length));
    snakes.push(makeSnake(p.x, p.y, rand(60, 200), COLOURS[1 + (i % 9)], true, NAMES[i]));
  }

  // Replay buffer: the last three seconds around the player, 20 frames a second.
  recordT = (recordT || 0) + dt;
  if (recordT >= 0.05) {
    recordT = 0;
    replay.push(snakes.filter((s) => !s.dead && Math.hypot(s.x - me.x, s.y - me.y) < 700)
      .map((s) => ({ c: s.colour, me: s === me, r: radius(s), p: s.pts.filter((_, i) => i % 2 === 0).map((q) => [q.x, q.y]) })));
    if (replay.length > 60) replay.shift();
  }

  if (me.dead) {
    const score = Math.round(me.len);
    if (score > best) { best = score; store.set('serpent.best', best); }
    // Keep the final frame with the player still drawn at the moment of impact.
    replayI = 0;
    state = replay.length > 5 ? 'replay' : 'over';
  }
}
let recordT = 0;

/* --------------------------------------------------------------- drawing */

let camX = 0, camY = 0, zoom = 1;
const sx = (x) => 300 + (x - camX) * zoom;
const sy = (y) => 300 + (y - camY) * zoom;

function drawArena() {
  // Faint hex dots for motion, then the rim.
  g.fillStyle = '#1b2a33';
  const step = 60;
  const x0 = Math.floor((camX - 300 / zoom) / step) * step, y0 = Math.floor((camY - 300 / zoom) / step) * step;
  for (let x = x0; x < camX + 300 / zoom + step; x += step) {
    for (let y = y0; y < camY + 300 / zoom + step; y += step) {
      if (x * x + y * y > ARENA * ARENA) continue;
      const off = (Math.round(y / step) % 2) * step / 2;
      g.fillRect(sx(x + off) - 1.5, sy(y) - 1.5, 3, 3);
    }
  }
  g.strokeStyle = '#ff5c5c'; g.lineWidth = 6;
  g.beginPath(); g.arc(sx(0), sy(0), ARENA * zoom, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(255,92,92,.25)'; g.lineWidth = 20;
  g.beginPath(); g.arc(sx(0), sy(0), ARENA * zoom + 12, 0, TAU); g.stroke();
}

function drawFood(now) {
  for (const f of food) {
    const x = sx(f.x), y = sy(f.y);
    if (x < -10 || x > 610 || y < -10 || y > 610) continue;
    const r = (f.v >= 2 ? 7 : f.v >= 1 ? 5 : 3.5) * Math.max(0.7, zoom) * (1 + Math.sin(now / 300 + f.t) * 0.15);
    g.fillStyle = f.c;
    g.beginPath(); g.moveTo(x, y - r * 1.3); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.3); g.lineTo(x - r, y); g.closePath(); g.fill();
  }
}

function drawBody(pts, colour, r, isMe, a, boosting) {
  const R = r * zoom;
  // Tail to head so the head sits on top. Alternate shading gives the coil its bands.
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    const x = sx(p.x !== undefined ? p.x : p[0]), y = sy(p.y !== undefined ? p.y : p[1]);
    if (x < -40 || x > 640 || y < -40 || y > 640) continue;
    const taper = i > pts.length - 6 ? 0.6 + 0.08 * (pts.length - i) : 1;
    g.fillStyle = Math.floor(i / 3) % 2 ? colour : shade(colour);
    g.beginPath(); g.arc(x, y, R * taper, 0, TAU); g.fill();
  }
  if (boosting) {
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2;
    const p = pts[0]; const x = sx(p.x !== undefined ? p.x : p[0]), y = sy(p.y !== undefined ? p.y : p[1]);
    g.beginPath(); g.arc(x, y, R + 4, 0, TAU); g.stroke();
  }
  if (a !== undefined) {
    const p = pts[0]; const x = sx(p.x), y = sy(p.y);
    for (const side of [-1, 1]) {
      const ex = x + Math.cos(a + side * 0.6) * R * 0.55, ey = y + Math.sin(a + side * 0.6) * R * 0.55;
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ex, ey, R * 0.32, 0, TAU); g.fill();
      g.fillStyle = '#000'; g.beginPath(); g.arc(ex + Math.cos(a) * R * 0.12, ey + Math.sin(a) * R * 0.12, R * 0.16, 0, TAU); g.fill();
    }
  }
}
const shadeCache = {};
function shade(c) {
  if (shadeCache[c]) return shadeCache[c];
  const n = parseInt(c.slice(1), 16);
  const r = (n >> 16) * 0.6, gg = ((n >> 8) & 255) * 0.6, b = (n & 255) * 0.6;
  return (shadeCache[c] = `rgb(${r | 0},${gg | 0},${b | 0})`);
}

let lastNow = 0;
function render(now) {
  const prevNow = lastNow || now; lastNow = now;
  g.fillStyle = '#000'; g.fillRect(0, 0, 600, 600);
  if (!snakes) { snakes = []; food = []; for (let i = 0; i < 200; i++) randomFood(); }

  if (state === 'replay' || state === 'over') {
    const f = replay[Math.min(replay.length - 1, Math.floor(replayI || 0))] || [];
    const mine = f.find((s) => s.me);
    if (mine && mine.p.length) { camX = mine.p[0][0]; camY = mine.p[0][1]; }
    drawArena(); drawFood(now);
    for (const s of f) drawBody(s.p, s.c, s.r, s.me);
    if (state === 'replay') {
      plate(170, 12, 260, 40);
      label('REPLAY  ·  half speed', 300, 39, 18, '#ffd34d', 'center');
      return;
    }
    const by = killer === 'rim' ? 'You hit the rim' : killer ? 'You ran into ' + killer.name : '';
    return banner(now, 'BURST', '#ff6b6b', 'Pinch to play again', [by, 'Length ' + Math.round(me.len) + '  ·  takedowns ' + kills + '  ·  best ' + best]);
  }

  if (me && !me.dead) {
    // Follow by elapsed time, not by frame count, so slow frames do not leave the camera behind.
    const k = Math.min(1, (now - prevNow) / 60);
    camX = lerp(camX, me.x, k); camY = lerp(camY, me.y, k);
    zoom = lerp(zoom, clamp(1.1 - me.len / 2500, 0.55, 1.05), k * 0.2);
  } else { camX = Math.sin(now / 5000) * 300; camY = Math.cos(now / 5000) * 300; zoom = 0.8; }
  drawArena();
  drawFood(now);
  for (const s of snakes) if (!s.dead && s !== me) drawBody(s.pts, s.colour, radius(s), false, s.a, s.boost > 0);
  if (me && !me.dead) drawBody(me.pts, me.colour, radius(me), true, me.a, me.boost > 0);

  if (state === 'menu') return GK.drawMenu(menu, now, 170);
  hud(now);
  if (state === 'pause') banner(now, 'PAUSED', '#fff', 'Pinch to continue', ['Down: back to the menu']);
}

function hud(now) {
  plate(12, 8, 150, 62); plate(438, 8, 150, 62);
  label('LENGTH', 24, 28, 13, '#a9adb3'); label(String(Math.round(me.len)), 24, 58, 24, '#5dffb4');
  label('BEST', 576, 28, 13, '#a9adb3', 'right'); label(String(Math.max(best, Math.round(me.len))), 576, 58, 24, '#fff', 'right');
  if (kills) { plate(240, 8, 120, 40); label('✕ ' + kills, 300, 36, 18, '#ffd34d', 'center'); }
  // Leaderboard of the three longest.
  const top = snakes.filter((s) => !s.dead).sort((a, b) => b.len - a.len).slice(0, 3);
  plate(438, 76, 150, 74);
  top.forEach((s, i) => label((i + 1) + ' ' + s.name + '  ' + Math.round(s.len), 450, 96 + i * 21, 14, s === me ? '#5dffb4' : '#c3c7cd', 'left', 600));
  // Mini-map.
  const cx = 540, cy = 540, R = 46;
  g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(cx, cy, R + 3, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,92,92,.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
  for (const s of snakes) {
    if (s.dead) continue;
    g.fillStyle = s === me ? '#fff' : s.colour;
    const r = s === me ? 3.5 : 2;
    g.fillRect(cx + s.x / ARENA * R - r / 2, cy + s.y / ARENA * R - r / 2, r, r);
  }
  if (steerHead && !GK.headLive() && GK.blink(now, 800)) label('Head steering waiting — swipes work', 300, 590, 14, '#ffb35c', 'center');
}

/* ------------------------------------------------------------------ menu */

const menu = GK.menu('GLASS SERPENT', '#5dffb4', [
  { text: 'Play', hint: () => 'Best length ' + best, act: start },
  { text: () => 'Steering · ' + (steerHead ? 'Head' : 'Swipe'), hint: 'Head steering asks for motion access once',
    act: () => { steerHead = !steerHead; store.set('serpent.head', steerHead); if (steerHead) GK.askHead(); } },
  { text: () => 'Invert head · ' + (head.invert ? 'on' : 'off'), act: () => GK.setInvert(!head.invert) },
  { text: () => 'Sound · ' + (GK.sound.on ? 'on' : 'off'), act: () => GK.setSound(!GK.sound.on) },
]);

/* ----------------------------------------------------------------- input */

GK.input.onKey = (k) => {
  if (state === 'menu') { if (steerHead && head.state === 'off') GK.askHead(); return GK.menuKey(menu, k); }
  if (state === 'replay') { if (k === 'Enter') state = 'over'; return; }
  if (state === 'over') { if (k === 'Enter') start(); else if (k === 'ArrowDown') state = 'menu'; return; }
  if (state === 'pause') { if (k === 'Enter') state = 'play'; else if (k === 'ArrowDown') state = 'menu'; return; }
  if (k === 'Enter') { state = 'pause'; return; }
  if (k === 'ArrowLeft') { me.want = me.a - Math.PI / 4; lastTurn = -1; }
  else if (k === 'ArrowRight') { me.want = me.a + Math.PI / 4; lastTurn = 1; }
  else if (k === 'ArrowDown') me.want = me.a + lastTurn * Math.PI * 0.75;
  else if (k === 'ArrowUp') { if (me.len > 50) { me.boost = 1.2; beep(300, 0.3, 'sawtooth', 0.2, 300); } else beep(150, 0.1); }
};

GK.loop.onHidden = () => { if (state === 'play') state = 'pause'; };
GK.run(tick, render);

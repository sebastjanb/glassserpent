/* Glass Serpent — arena serpents for Meta Ray-Ban Display glasses.
   WebGL arena: dark panelled floor, a red-lit rim, glowing crystals, and
   scaled serpents seen from just behind your own head. Eat crystals to grow;
   boost across a rival's path so it runs into you and bursts into food.
   Running your head into any other serpent, or the rim, ends the round, and
   the last three seconds play back so you see what happened.
     Left / Right   turn 45°  (head steering: turn your head)
     Up             boost; swipe again while boosting for longer (burns length)
     Down           tight 135° turn toward the side you last turned
     Pinch          pause */

import { THREE, makeRenderer, canvasTexture, glowSprite, starfield, chaseCamera, frameClock } from './kit3d.js';

const VERSION = '2.0.0';
const { g, label, clamp, lerp, rand, beep, noise, head, store } = GK;
const TAU = Math.PI * 2;
const ARENA = 1500;
const SPEED = 125, BOOST = 230, TURN = 3.4;       // units/s, units/s, rad/s
const GAP = 7;                                      // spacing of body points
const RIVALS = 5, FOOD = 700;

let state = 'title';   // title | menu | play | pause | replay | over
let me, snakes, food, time, best, kills, replay, replayI, killer, lastTurn = 1;
let steerHead = store.get('serpent.head', false);
best = store.get('serpent.best', 0);

const COLOURS = ['#5dffb4', '#ff6b6b', '#ffd34d', '#7fd8ff', '#ff9be0', '#b7a3ff', '#ffb35c', '#9be15d', '#ff5cc8', '#4fe3ff'];
const NAMES = ['Wicket', 'Ember', 'Moss', 'Quill', 'Rune', 'Sable', 'Tansy', 'Vex', 'Zinc'];

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

/* ------------------------------------------------------------------ scene */

// The logic works on a flat (x, y) arena; the scene puts that on the floor as (x, 0, y).
const renderer = makeRenderer();
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000000, 500, 1300);
const camera = new THREE.PerspectiveCamera(60, 1, 1, 6000);
const chase = chaseCamera(camera);
const clock = frameClock();
scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x101018, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.3);
key.position.set(200, 600, 300);
scene.add(key);
const stars = starfield(1200, 3000, 0xb8d0ff, 1.5);
scene.add(stars);

// Floor: dark panels with fine seams and the odd lit stud.
const floorTex = canvasTexture(256, 256, (c, w, h) => {
  c.fillStyle = '#121418'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#16191e'; c.fillRect(3, 3, w / 2 - 6, h / 2 - 6); c.fillRect(w / 2 + 3, h / 2 + 3, w / 2 - 6, h / 2 - 6);
  c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 2; c.strokeRect(1, 1, w - 2, h - 2);
  c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
  for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) { c.fillStyle = '#5a6270'; c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill(); }
}, true);
floorTex.repeat.set(ARENA / 60, ARENA / 60);
const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA + 40, 96), new THREE.MeshStandardMaterial({ map: floorTex, metalness: 0.3, roughness: 0.6 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// Rim: a red-lit wall with a dashed light strip and posts.
const rim = new THREE.Group();
rim.add(new THREE.Mesh(new THREE.CylinderGeometry(ARENA + 4, ARENA + 4, 26, 128, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a0a14, emissive: 0xff2a4a, emissiveIntensity: 0.35, side: THREE.DoubleSide })));
rim.children[0].position.y = 13;
const dashTex = canvasTexture(256, 8, (c, w, h) => { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); c.fillStyle = '#ff5a7a'; for (let x = 0; x < w; x += 32) c.fillRect(x, 0, 18, h); }, true);
dashTex.repeat.set(160, 1);
const strip = new THREE.Mesh(new THREE.CylinderGeometry(ARENA - 6, ARENA - 6, 4, 128, 1, true), new THREE.MeshBasicMaterial({ map: dashTex, side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending }));
strip.position.y = 2; rim.add(strip);
const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 34, 6), new THREE.MeshStandardMaterial({ color: 0x20242c }), 96);
for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2; posts.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * (ARENA + 8), 17, Math.sin(a) * (ARENA + 8))); }
rim.add(posts);
const caps = new THREE.InstancedMesh(new THREE.SphereGeometry(4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd0e0 }), 96);
for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2; caps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * (ARENA + 8), 36, Math.sin(a) * (ARENA + 8))); }
rim.add(caps);
scene.add(rim);

// Scales: diamond pattern, tinted per serpent and per band through instance colours.
const scaleTex = canvasTexture(128, 128, (c, w, h) => {
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
  for (let y = -16; y < h + 16; y += 16) for (let x = -16; x < w + 16; x += 16) {
    const ox = (y / 16) % 2 ? 8 : 0;
    c.fillStyle = 'rgba(0,0,0,.28)'; c.beginPath(); c.moveTo(x + ox, y - 8); c.lineTo(x + ox + 8, y); c.lineTo(x + ox, y + 8); c.lineTo(x + ox - 8, y); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(x + ox - 1, y - 5, 2, 3);
  }
});
const bodyGeo = new THREE.SphereGeometry(1, 16, 12);
const bodyMat = new THREE.MeshStandardMaterial({ map: scaleTex, metalness: 0.25, roughness: 0.45 });
const MAXSEG = 700;
const pools = new Map();     // snake -> { body: InstancedMesh, head: Group }

function patternFor(colour) {
  const base = new THREE.Color(colour);
  const dark = base.clone().multiplyScalar(0.35);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.45);
  return [base, dark, light];
}

function poolFor(s) {
  let p = pools.get(s);
  if (p) return p;
  const body = new THREE.InstancedMesh(bodyGeo, bodyMat, MAXSEG);
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.frustumCulled = false;
  const pat = patternFor(s.colour);
  for (let i = 0; i < MAXSEG; i++) {
    // Bands: mostly base colour, a dark saddle every few segments, pale belly glints.
    const k = i % 9;
    body.setColorAt(i, k === 0 || k === 1 ? pat[1] : k === 5 ? pat[2] : pat[0]);
  }
  const headG = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), new THREE.MeshStandardMaterial({ map: scaleTex, color: pat[0], metalness: 0.25, roughness: 0.4 }));
  skull.scale.set(1.25, 0.8, 1.05); headG.add(skull);
  for (const z of [-0.55, 0.55]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe66a })); eye.position.set(0.55, 0.42, z); headG.add(eye);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.36, 0.1), new THREE.MeshBasicMaterial({ color: 0x000000 })); pupil.position.set(0.8, 0.42, z); headG.add(pupil);
  }
  const glow = glowSprite(s.colour, 3.2); glow.position.y = -0.5; glow.material.opacity = 0.5; headG.add(glow);
  scene.add(body, headG);
  p = { body, head: headG };
  pools.set(s, p);
  return p;
}
function dropPools(live) {
  for (const [s, p] of pools) if (!live.has(s)) { scene.remove(p.body, p.head); p.body.dispose(); pools.delete(s); }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
function drawSerpent(s, pts, r, ang, now) {
  const p = poolFor(s);
  const n = Math.min(MAXSEG, pts.length);
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const x = q.x !== undefined ? q.x : q[0], y = q.y !== undefined ? q.y : q[1];
    const taper = i > n - 8 ? 0.45 + 0.07 * (n - i) : 1;
    const rr = r * taper;
    _m.compose(_p.set(x, rr * 0.85, y), _q.identity(), _s.set(rr, rr * 0.85, rr));
    p.body.setMatrixAt(i, _m);
  }
  p.body.count = n;
  p.body.instanceMatrix.needsUpdate = true;
  if (p.body.instanceColor) p.body.instanceColor.needsUpdate = true;
  const h = pts[0];
  const hx = h.x !== undefined ? h.x : h[0], hy = h.y !== undefined ? h.y : h[1];
  p.head.position.set(hx, r * 1.0, hy);
  p.head.rotation.set(0, -(ang || 0), 0);
  p.head.scale.setScalar(r * 1.15);
}

// Food: one instanced crystal set, each tinted.
const foodMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), 1400);
foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
foodMesh.frustumCulled = false;
scene.add(foodMesh);
const _c = new THREE.Color();
function drawFood(now) {
  let n = 0;
  for (const f of food) {
    if (n >= 1400) break;
    const r = f.v >= 2 ? 6 : f.v >= 1 ? 4.5 : 3;
    _e.set(0, now / 600 + f.t, 0); _q.setFromEuler(_e);
    _m.compose(_p.set(f.x, r + 2 + Math.sin(now / 300 + f.t) * 1.2, f.y), _q, _s.set(r, r * 1.5, r));
    foodMesh.setMatrixAt(n, _m);
    foodMesh.setColorAt(n, _c.set(f.c));
    n++;
  }
  foodMesh.count = n;
  foodMesh.instanceMatrix.needsUpdate = true;
  if (foodMesh.instanceColor) foodMesh.instanceColor.needsUpdate = true;
}

/* ----------------------------------------------------------------- render */

const want = new THREE.Vector3(), at = new THREE.Vector3();
let menuA = 0;

function render3d(now) {
  const dt = clock(now);
  if (!snakes) { snakes = []; food = []; for (let i = 0; i < 300; i++) randomFood(); }
  const live = new Set();
  let camHead = null, camAng = 0;
  if ((state === 'replay' || state === 'over') && replay.length) {
    const f = replay[Math.min(replay.length - 1, Math.floor(replayI || 0))];
    f.forEach((rs, i) => { const key = replayKeys[i] || (replayKeys[i] = { colour: rs.c }); key.colour = rs.c; live.add(key); drawSerpent(key, rs.p, rs.r, 0, now); if (rs.me) camHead = { x: rs.p[0][0], y: rs.p[0][1] }; });
    // Replay: look down from above and behind so the whole crash is in view.
    if (camHead) { want.set(camHead.x - 160, 260, camHead.y + 160); at.set(camHead.x, 0, camHead.y); chase.update(want, at, dt, 4); }
  } else {
    for (const s of snakes) if (!s.dead) { live.add(s); drawSerpent(s, s.pts, radius(s), s.a, now); }
    if (me && !me.dead && (state === 'play' || state === 'pause')) { camHead = me; camAng = me.a; }
    else { menuA += dt * 0.15; camHead = { x: Math.cos(menuA) * 500, y: Math.sin(menuA) * 500 }; camAng = menuA + Math.PI / 2; }
    const back = 150 + (me ? Math.min(120, me.len / 6) : 0);
    want.set(camHead.x - Math.cos(camAng) * back, 95 + back * 0.25, camHead.y - Math.sin(camAng) * back);
    at.set(camHead.x + Math.cos(camAng) * 140, 0, camHead.y + Math.sin(camAng) * 140);
    chase.update(want, at, dt, 5);
  }
  dropPools(live);
  drawFood(now);
  stars.position.copy(camera.position);
  renderer.render(scene, camera);
}
const replayKeys = [];

/* -------------------------------------------------------------------- HUD */

const FONT2 = (size, w = 800) => `${w} ${size}px "Avenir Next Rounded", "Nunito", "Arial Rounded MT Bold", ${GK.FONT}`;
function rt(t, x, y, size, colour = '#fff', align = 'left', w = 800) { g.font = FONT2(size, w); g.textAlign = align; g.fillStyle = colour; g.fillText(t, x, y); }
function pill(x, y, w, h, stroke = 'rgba(127,216,255,.85)') { g.fillStyle = 'rgba(10,14,20,.6)'; g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill(); g.strokeStyle = stroke; g.lineWidth = 2.5; g.stroke(); }

function hud(now) {
  const ranked = snakes.filter((s) => !s.dead).sort((a, b) => b.len - a.len);
  const rank = ranked.indexOf(me) + 1;
  const score = Math.round(me.len * 10);
  // Score pill with rank, and the goal under it.
  pill(16, 14, 210, 50);
  g.fillStyle = '#7fd8ff'; g.beginPath(); g.arc(40, 39, 6, 0, Math.PI * 2); g.fill();
  rt(score.toLocaleString(), 54, 50, 30);
  pill(160, 22, 56, 34); rt('#' + rank, 188, 46, 18, '#7fd8ff', 'center');
  const goal = Math.round(Math.max(best * 10, 2000) / 100) * 100;
  rt('Goal ' + score.toLocaleString() + ' / ' + goal.toLocaleString(), 26, 88, 15, '#e8eef6', 'left', 700);
  // Leader board line on the right.
  const lead = ranked[0];
  rt('#' + rank + ' of ' + ranked.length, 352, 46, 16, '#7fd8ff', 'right');
  g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(360, 30, 2, 20);
  if (lead) {
    rt(lead === me ? 'You lead' : 'Leader', 372, 46, 16, '#e8eef6', 'left', 700);
    g.fillStyle = lead.colour; g.beginPath(); g.arc(452, 40, 6, 0, Math.PI * 2); g.fill();
    rt((lead === me ? '' : lead.name + ' ') + Math.round(lead.len * 10).toLocaleString(), 576, 46, 16, '#fff', 'right');
  }
  // Radar ring: an arc toward each rival, coloured by them; nearer is thicker.
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(300, 330, 250, 0, Math.PI * 2); g.stroke();
  for (const s of snakes) {
    if (s === me || s.dead) continue;
    const d = Math.hypot(s.x - me.x, s.y - me.y);
    if (d > 1400) continue;
    // Angle relative to where we are heading, drawn so ahead is up.
    const rel = Math.atan2(s.y - me.y, s.x - me.x) - me.a - Math.PI / 2;
    g.strokeStyle = s.colour; g.lineWidth = d < 400 ? 8 : 4;
    g.beginPath(); g.arc(300, 330, 250, rel - 0.12, rel + 0.12); g.stroke();
  }
  // Rim warning: an arc in red toward the wall when it is near.
  const toRim = ARENA - Math.hypot(me.x, me.y);
  if (toRim < 350) {
    const rel = Math.atan2(me.y, me.x) - me.a - Math.PI / 2;
    g.strokeStyle = `rgba(255,70,90,${clamp(1 - toRim / 350, 0.2, 0.9)})`; g.lineWidth = 6;
    g.beginPath(); g.arc(300, 330, 250, rel - 0.5, rel + 0.5); g.stroke();
  }
  // Boost pills.
  pill(190, 548, 220, 36, 'rgba(255,255,255,.7)');
  rt('Boost', 180, 572, 16, '#fff', 'right');
  const bars = clamp(Math.floor((me.len - 50) / 25), 0, 8);
  for (let i = 0; i < 8; i++) { g.fillStyle = i < bars ? (me.boost > 0 ? '#ffffff' : '#7fd8ff') : 'rgba(255,255,255,.15)'; g.beginPath(); g.roundRect(204 + i * 25, 558, 20, 16, 8); g.fill(); }
  if (kills) rt('✕ ' + kills, 576, 88, 16, '#ffd34d', 'right');
  if (state === 'play' && time < 10) {
    pill(110, 470, 380, 44, 'rgba(255,255,255,.5)');
    rt(time < 5 ? '←  → Swipe to turn' : '↑ Swipe up to boost', 300, 499, 17, '#fff', 'center', 700);
  }
  if (steerHead && !GK.headLive() && GK.blink(now, 800)) rt('Head steering waiting — swipes work', 300, 450, 15, '#ffb35c', 'center', 700);
}

function card(x, y, w, h, on, icon, title, sub) {
  g.fillStyle = 'rgba(22,26,32,.92)'; g.beginPath(); g.roundRect(x, y, w, h, 22); g.fill();
  g.strokeStyle = on ? '#4fd8ff' : 'rgba(255,255,255,.18)'; g.lineWidth = on ? 4 : 2; g.stroke();
  rt(icon, x + w / 2, y + 74, 44, on ? '#4fd8ff' : '#7a8696', 'center');
  rt(title, x + w / 2, y + 124, 22, on ? '#fff' : '#a9adb3', 'center');
  rt(sub, x + w / 2, y + 152, 14, '#c3c7cd', 'center', 700);
}

let menuI = 0;
const CARDS = () => [
  { icon: '∞', title: 'Arena', sub: best ? 'Best ' + (best * 10).toLocaleString() : 'No run yet', act: start },
  { icon: '◎', title: 'Steering', sub: steerHead ? 'Head' : 'Swipes', act: () => { steerHead = !steerHead; store.set('serpent.head', steerHead); if (steerHead) GK.askHead(); } },
  { icon: '♪', title: 'Sound', sub: GK.sound.on ? 'On' : 'Off', act: () => GK.setSound(!GK.sound.on) },
];

function menuScreen() {
  rt('Serpent', 300, 60, 26, '#fff', 'center');
  CARDS().forEach((c, i) => card(300 - 85 + (i - menuI) * 200, 190, 170, 200, i === menuI, c.icon, c.title, c.sub));
  rt('Swipe to choose · Pinch to select · Back to return', 300, 560, 15, '#e8eef6', 'center', 700);
}

function titleScreen(now) {
  rt('SERPENT', 300, 220, 64, '#fff', 'center', 900);
  rt('Grow. Cut them off. Burst them.', 300, 262, 17, '#7fd8ff', 'center', 700);
  pill(190, 430, 220, 56, 'rgba(79,216,255,.9)');
  rt('Pinch to play', 300, 466, 20, '#fff', 'center');
}

function panel(now, title, lines, prompt) {
  g.fillStyle = 'rgba(14,18,24,.9)'; g.beginPath(); g.roundRect(70, 180, 460, 120 + lines.length * 28, 22); g.fill();
  g.strokeStyle = '#4fd8ff'; g.lineWidth = 3; g.stroke();
  rt(title, 300, 230, 34, '#fff', 'center');
  lines.forEach((t, i) => rt(t, 300, 266 + i * 28, 16, '#e8eef6', 'center', 700));
  if (GK.blink(now)) rt(prompt, 300, 266 + lines.length * 28 + 20, 17, '#4fd8ff', 'center');
}

function render(now) {
  render3d(now);
  g.clearRect(0, 0, 600, 600);
  if (state === 'title') return titleScreen(now);
  if (state === 'menu') return menuScreen();
  if (state === 'replay') { pill(170, 14, 260, 44, '#ffd34d'); rt('Replay · half speed', 300, 43, 17, '#ffd34d', 'center'); return; }
  if (state === 'over') {
    const by = killer === 'rim' ? 'You hit the rim' : killer ? 'You ran into ' + killer.name : '';
    return panel(now, 'Burst', [by, 'Score ' + Math.round(me.len * 10).toLocaleString() + '  ·  takedowns ' + kills + '  ·  best ' + (best * 10).toLocaleString()], 'Pinch to play again');
  }
  hud(now);
  if (state === 'pause') panel(now, 'Paused', ['Down: back to the menu'], 'Pinch to continue');
}

/* ------------------------------------------------------------------ input */

GK.input.onKey = (k) => {
  if (state === 'title') { if (k === 'Enter') { state = 'menu'; if (steerHead) GK.askHead(); } return; }
  if (state === 'menu') {
    const cards = CARDS();
    if (k === 'ArrowLeft') menuI = (menuI + cards.length - 1) % cards.length;
    else if (k === 'ArrowRight') menuI = (menuI + 1) % cards.length;
    else if (k === 'Enter') cards[menuI].act();
    else if (k === 'ArrowDown') state = 'title';
    beep(560, 0.03);
    return;
  }
  if (state === 'replay') { if (k === 'Enter') state = 'over'; return; }
  if (state === 'over') { if (k === 'Enter') start(); else if (k === 'ArrowDown') state = 'menu'; return; }
  if (state === 'pause') { if (k === 'Enter') state = 'play'; else if (k === 'ArrowDown') state = 'menu'; return; }
  if (k === 'Enter') { state = 'pause'; return; }
  if (k === 'ArrowLeft') { me.want = me.a - Math.PI / 4; lastTurn = -1; }
  else if (k === 'ArrowRight') { me.want = me.a + Math.PI / 4; lastTurn = 1; }
  else if (k === 'ArrowDown') me.want = me.a + lastTurn * Math.PI * 0.75;
  else if (k === 'ArrowUp') {
    // A second swipe while boosting makes it last longer.
    if (me.len > 50) { me.boost = me.boost > 0 ? Math.min(2.6, me.boost + 1.2) : 1.2; beep(300, 0.3, 'sawtooth', 0.2, 300); } else beep(150, 0.1);
  }
};

GK.loop.onHidden = () => { if (state === 'play') state = 'pause'; };
GK.run(tick, render);

window.serpent = { get state() { return state; }, set state(x) { state = x; }, start, tick, think, get me() { return me; }, get snakes() { return snakes; }, get kills() { return kills; }, get time() { return time; } };

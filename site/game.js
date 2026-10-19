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

const VERSION = '3.0.0';
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
const key = new THREE.DirectionalLight(0xfff4e8, 1.8);
key.position.set(200, 600, 300);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = key.shadow.camera.bottom = -320;
key.shadow.camera.right = key.shadow.camera.top = 320;
key.shadow.camera.near = 10; key.shadow.camera.far = 1500;
key.shadow.bias = -0.0005;
scene.add(key, key.target);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// Coloured rim lights round the arena.
for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const pl = new THREE.PointLight([0xff3a6a, 0x3a8aff, 0xa04aff][i % 3], 60000, 900, 2); pl.position.set(Math.cos(a) * (ARENA - 80), 120, Math.sin(a) * (ARENA - 80)); scene.add(pl); }
const stars = starfield(1200, 3000, 0xb8d0ff, 1.5);
scene.add(stars);

// Floor: dark panels with fine seams and the odd lit stud.
// Floor: hexagonal panels with glowing seams; one tile is 3R × √3R so the pattern repeats.
const HEXR = 64, HW2 = HEXR * 3, HH2 = Math.round(HEXR * Math.sqrt(3));
function hexPath(c, cx, cy) { c.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; c.lineTo(cx + Math.cos(a) * (HEXR - 3), cy + Math.sin(a) * (HEXR - 3)); } c.closePath(); }
const hexCentres = [];
for (const [ox, oy] of [[0, 0], [HW2, 0], [0, HH2], [HW2, HH2], [HEXR * 1.5, HH2 / 2], [HEXR * 1.5, -HH2 / 2], [HEXR * 1.5, HH2 * 1.5], [-HEXR * 1.5, HH2 / 2], [HW2 + HEXR * 1.5, HH2 / 2]]) hexCentres.push([ox, oy]);
const floorTex = canvasTexture(HW2, HH2, (c, w, h) => {
  c.fillStyle = '#06080c'; c.fillRect(0, 0, w, h);
  hexCentres.forEach(([x, y], i) => {
    const grd = c.createLinearGradient(x - HEXR, y - HEXR, x + HEXR, y + HEXR);
    grd.addColorStop(0, i % 3 ? '#161a22' : '#1a1f28'); grd.addColorStop(1, '#0e1016');
    hexPath(c, x, y); c.fillStyle = grd; c.fill();
    c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = 2; c.stroke();
  });
  for (let i = 0; i < 1500; i++) { c.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; c.fillRect(Math.random() * w, Math.random() * h, 1, 1); }
}, true);
const seamTex = canvasTexture(HW2, HH2, (c, w, h) => {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#3ad8ff'; c.lineWidth = 3;
  hexCentres.forEach(([x, y]) => { c.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; c.lineTo(x + Math.cos(a) * HEXR, y + Math.sin(a) * HEXR); } c.closePath(); c.stroke(); });
}, true);
floorTex.repeat.set(ARENA / 40, ARENA / 23); seamTex.repeat.copy(floorTex.repeat);
const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA + 40, 96), new THREE.MeshStandardMaterial({ map: floorTex, emissive: 0xffffff, emissiveMap: seamTex, emissiveIntensity: 0.35, metalness: 0.5, roughness: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
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

// Serpents are continuous tubes rebuilt from their path every frame, wrapped in a
// species pattern with scales, a shaped head with eyes and a flicking tongue.
const SPECIES = [
  { base: '#3ad89a', band: '#0e5a3a', belly: '#c8ffd8', kind: 'diamond' },   // the player's emerald
  { base: '#c8402a', band: '#f2d040', belly: '#1a1a1a', kind: 'coral' },
  { base: '#6a8ad8', band: '#e8eef8', belly: '#2a3a6a', kind: 'bands' },
  { base: '#b8a060', band: '#4a3820', belly: '#e8d8a8', kind: 'diamond' },
  { base: '#8a4ad8', band: '#2a0e4a', belly: '#d8c0ff', kind: 'spots' },
  { base: '#e8a030', band: '#3a2008', belly: '#fff0c0', kind: 'bands' },
  { base: '#2a8ac8', band: '#0a2a4a', belly: '#c0e8ff', kind: 'spots' },
  { base: '#d84a8a', band: '#4a0a2a', belly: '#ffd0e8', kind: 'diamond' },
  { base: '#5ab83a', band: '#1a3a0e', belly: '#e0ffb8', kind: 'bands' },
  { base: '#d8d8e0', band: '#2a2a32', belly: '#f8f8ff', kind: 'coral' },
];
const skinCache = new Map();
function skinFor(colour) {
  if (skinCache.has(colour)) return skinCache.get(colour);
  const sp = SPECIES[Math.max(0, COLOURS.indexOf(colour)) % SPECIES.length];
  const tex = canvasTexture(128, 256, (c, w, h) => {
    // u runs round the body (belly at the edges), v along it.
    const grd = c.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, sp.belly); grd.addColorStop(0.22, sp.base); grd.addColorStop(0.78, sp.base); grd.addColorStop(1, sp.belly);
    c.fillStyle = grd; c.fillRect(0, 0, w, h);
    c.fillStyle = sp.band;
    if (sp.kind === 'diamond') for (let y = 0; y < h; y += 64) { c.beginPath(); c.moveTo(w / 2, y); c.lineTo(w * 0.8, y + 32); c.lineTo(w / 2, y + 64); c.lineTo(w * 0.2, y + 32); c.closePath(); c.fill(); c.fillStyle = sp.base; c.beginPath(); c.moveTo(w / 2, y + 14); c.lineTo(w * 0.66, y + 32); c.lineTo(w / 2, y + 50); c.lineTo(w * 0.34, y + 32); c.closePath(); c.fill(); c.fillStyle = sp.band; }
    else if (sp.kind === 'bands') for (let y = 0; y < h; y += 64) c.fillRect(w * 0.12, y, w * 0.76, 18);
    else if (sp.kind === 'coral') for (let y = 0; y < h; y += 64) { c.fillRect(w * 0.1, y, w * 0.8, 16); c.fillStyle = '#111'; c.fillRect(w * 0.1, y + 16, w * 0.8, 10); c.fillRect(w * 0.1, y - 10, w * 0.8, 10); c.fillStyle = sp.band; }
    else for (let i = 0; i < 26; i++) { c.beginPath(); c.ellipse(w * (0.25 + Math.random() * 0.5), Math.random() * h, 6 + Math.random() * 8, 8 + Math.random() * 10, 0, 0, Math.PI * 2); c.fill(); }
    // Scales: overlapping rows of small arcs with a highlight.
    for (let y = 0; y < h + 8; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8) {
      c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, 4.5, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(x - 1, y - 3, 2, 1);
    }
  }, true);
  const bump = canvasTexture(64, 64, (c, w, h) => {
    c.fillStyle = '#808080'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h + 8; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8) { const grd = c.createRadialGradient(x, y - 1, 0, x, y, 4.5); grd.addColorStop(0, '#d0d0d0'); grd.addColorStop(1, '#505050'); c.fillStyle = grd; c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill(); }
  }, true);
  bump.colorSpace = THREE.NoColorSpace; bump.repeat.set(2, 4);
  // A little of the pattern glows on its own, so serpents read against the dark floor.
  const mat = new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 1.2, roughness: 0.38, metalness: 0.1, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 });
  const out = { mat, sp };
  skinCache.set(colour, out);
  return out;
}

const RING = 12, MAXRING = 420;
const pools = new Map();     // serpent -> { body: Mesh with a reusable tube geometry, head: Group }

function tubeGeometry() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAXRING * (RING + 1) * 3), nor = new Float32Array(MAXRING * (RING + 1) * 3), uv = new Float32Array(MAXRING * (RING + 1) * 2);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  const idx = [];
  for (let i = 0; i < MAXRING - 1; i++) for (let k = 0; k < RING; k++) {
    const a = i * (RING + 1) + k, b = a + RING + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  geo.setIndex(idx);
  return geo;
}

function poolFor(s) {
  let p = pools.get(s);
  if (p) return p;
  const skin = skinFor(s.colour);
  const body = new THREE.Mesh(tubeGeometry(), skin.mat);
  body.frustumCulled = false; body.castShadow = true;
  const headG = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skin.mat);
  skull.scale.set(1.5, 0.72, 1.05); skull.position.x = 0.35; skull.castShadow = true; headG.add(skull);
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshStandardMaterial({ color: skin.sp.belly, roughness: 0.5 }));
  jaw.scale.set(1.35, 0.4, 0.9); jaw.position.set(0.35, -0.28, 0); headG.add(jaw);
  for (const z of [-0.5, 0.5]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffd84a, emissive: 0x6a5000, roughness: 0.1 })); eye.position.set(0.85, 0.32, z); headG.add(eye);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.06), new THREE.MeshBasicMaterial({ color: 0x000000 })); pupil.position.set(1.05, 0.32, z * 1.1); headG.add(pupil);
  }
  const tongue = new THREE.Group();
  const tmat = new THREE.MeshBasicMaterial({ color: 0xd8203a });
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.08), tmat); stem.position.x = 0.4; tongue.add(stem);
  for (const z of [-1, 1]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 0.06), tmat); f.position.set(0.95, 0, z * 0.08); f.rotation.y = z * 0.5; tongue.add(f); }
  tongue.position.set(1.7, -0.2, 0); headG.add(tongue); headG.tongue = tongue;
  const glow = glowSprite(s.colour, 3); glow.position.y = -0.6; glow.material.opacity = 0.35; headG.add(glow);
  scene.add(body, headG);
  p = { body, head: headG };
  pools.set(s, p);
  return p;
}
function dropPools(live) {
  for (const [s, p] of pools) if (!live.has(s)) { scene.remove(p.body, p.head); p.body.geometry.dispose(); pools.delete(s); }
}

function drawSerpent(s, pts, r, ang, now) {
  const p = poolFor(s);
  const n = Math.min(MAXRING, pts.length);
  const g2 = p.body.geometry, pos = g2.attributes.position.array, nor = g2.attributes.normal.array, uv = g2.attributes.uv.array;
  const X = (i) => { const q = pts[Math.max(0, Math.min(n - 1, i))]; return q.x !== undefined ? q.x : q[0]; };
  const Y = (i) => { const q = pts[Math.max(0, Math.min(n - 1, i))]; return q.y !== undefined ? q.y : q[1]; };
  let along = 0;
  for (let i = 0; i < n; i++) {
    let tx = X(i - 1) - X(i + 1), ty = Y(i - 1) - Y(i + 1);
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    // Side vector across the body on the floor; up is up.
    const sx = -ty, sy = tx;
    // The body swells behind the head and tapers to a point at the tail.
    const f = i / Math.max(1, n - 1);
    const taper = (i < 3 ? 0.78 + i * 0.07 : 1) * (f > 0.7 ? Math.max(0.12, 1 - (f - 0.7) / 0.3 * 0.88) : 1);
    const rr = r * taper, cx = X(i), cz = Y(i), cy = rr * 0.82;
    if (i) along += Math.hypot(X(i) - X(i - 1), Y(i) - Y(i - 1));
    for (let k = 0; k <= RING; k++) {
      const a = k / RING * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const o = (i * (RING + 1) + k) * 3;
      pos[o] = cx + sx * ca * rr; pos[o + 1] = cy + sa * rr * 0.82; pos[o + 2] = cz + sy * ca * rr;
      nor[o] = sx * ca; nor[o + 1] = sa; nor[o + 2] = sy * ca;
      const u = (i * (RING + 1) + k) * 2;
      // u = 0.5 on the back (a = 90°), the belly at the edges.
      uv[u] = ((k / RING) + 0.25) % 1; uv[u + 1] = along / (r * 6);
    }
  }
  g2.setDrawRange(0, Math.max(0, n - 1) * RING * 6);
  g2.attributes.position.needsUpdate = true; g2.attributes.normal.needsUpdate = true; g2.attributes.uv.needsUpdate = true;
  const hx = X(0), hy = Y(0);
  const a = ang !== undefined && ang !== 0 ? ang : Math.atan2(Y(0) - Y(2), X(0) - X(2));
  p.head.position.set(hx, r * 0.75, hy);
  p.head.rotation.set(0, -a, 0);
  p.head.scale.setScalar(r * 1.05);
  // The tongue flicks out now and then.
  const ph = (now / 1000 + (s.name ? s.name.length : 0)) % 2.2;
  p.head.tongue.visible = ph < 0.35;
  p.head.tongue.scale.x = ph < 0.35 ? 0.6 + Math.sin(ph * 40) * 0.4 : 1;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
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
  key.target.position.copy(at); key.position.copy(at).add(new THREE.Vector3(200, 600, 300));
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

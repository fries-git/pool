// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const server = app.listen(PORT, () => console.log(`HTTP running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* CONFIG */
const TABLE_W = 800, TABLE_H = 400;
const BALL_R = 10;
const POCKET_RADIUS = 28;
const POCKET_NEAR_MARGIN = 8;
const TICK_RATE = 60;            // ticks per second
const BROADCAST_RATE = 20;
const GLOBAL_FRICTION = 0.993;   // per tick multiplicative velocity factor
const LOW_SPEED_FRICTION = 0.88; // extra damping when very slow
const STOP_THRESH = 0.03;
const SLOW_SPEED = 0.25;
const SHOOT_SCALE = 175;
const MAX_PLAYERS = 2;
const ROOM_IDLE_MS = 1000 * 60 * 5;
const POCKET_CAP = 128;
const POCKETS = [
  { x: 0, y: 0 }, { x: TABLE_W / 2, y: 0 }, { x: TABLE_W, y: 0 },
  { x: 0, y: TABLE_H }, { x: TABLE_W / 2, y: TABLE_H }, { x: TABLE_W, y: TABLE_H }
];

const rooms = new Map();

function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function vecLen(vx, vy) { return Math.hypot(vx, vy); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function makeRack() {
  const balls = [];
  const BALL_SP = BALL_R * 2 + 0.5;
  // cue
  balls.push({ id: 'cue', num: 0, x: 130, y: TABLE_H / 2, r: BALL_R, vx: 0, vy: 0, color: '#ffffff', stripe: false });
  const palette = {
    1: '#FFD400',2:'#0047AB',3:'#C41E3A',4:'#6A0DAD',5:'#FF8C00',6:'#006400',7:'#6F1D1B',
    8:'#000000',9:'#FFD400',10:'#0047AB',11:'#C41E3A',12:'#6A0DAD',13:'#FF8C00',14:'#006400',15:'#6F1D1B'
  };
  const apexX = TABLE_W - 160, apexY = TABLE_H/2;
  let n = 1;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      if (n > 15) break;
      const x = apexX + row * BALL_SP;
      const y = apexY + (i - row / 2) * BALL_SP;
      balls.push({ id: `b${n}`, num: n, x, y, r: BALL_R, vx: 0, vy: 0, color: palette[n], stripe: n >= 9 });
      n++;
    }
  }
  return balls;
}

/* Improved collision resolver:
   - always separate overlapping balls (even if relative vel >= 0)
   - handle zero-distance by small jitter
   - apply impulse only if they are moving toward each other
*/
function resolveBallCollision(a, b) {
  let dx = b.x - a.x, dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;

  if (dist === 0) {
    // tiny jitter to avoid NaNs and permanent overlap
    const jitter = 0.001;
    dx = jitter; dy = 0;
    dist = jitter;
  }

  if (dist >= minDist) return;

  // normal
  const nx = dx / dist, ny = dy / dist;

  // positional correction (push them apart)
  const overlap = minDist - dist;
  const correction = (overlap / 2) + 0.001;
  a.x -= nx * correction;
  a.y -= ny * correction;
  b.x += nx * correction;
  b.y += ny * correction;

  // relative velocity along normal
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const rel = rvx * nx + rvy * ny;

  // only apply impulse if they are moving toward each other
  if (rel >= 0) return;

  const e = 0.98; // restitution
  const j = -(1 + e) * rel / 2; // equal mass -> divide by 2
  const ix = j * nx, iy = j * ny;
  a.vx -= ix; a.vy -= iy;
  b.vx += ix; b.vy += iy;
}

function ballShouldPocket(ball) {
  for (const p of POCKETS) {
    const dx = p.x - ball.x, dy = p.y - ball.y;
    const d = Math.hypot(dx, dy);
    if (d <= POCKET_RADIUS) return true;
    if (d <= POCKET_RADIUS + POCKET_NEAR_MARGIN) {
      const proj = (ball.vx * dx + ball.vy * dy);
      if (proj > 0.4 * vecLen(ball.vx, ball.vy) * d / (POCKET_RADIUS + 1)) return true;
    }
  }
  return false;
}

function createRoom(hostName) {
  const code = randCode(4);
  const room = {
    code,
    hostId: null,
    hostName,
    players: [],
    turnIndex: 0,
    assigned: null,
    state: { balls: makeRack(), pocketed: [] },
    ballInHand: false,
    lastShooterId: null,
    lastEvent: null,
    lastBroadcast: 0,
    lastActive: Date.now(),
    // shot lifecycle helpers
    shotInProgress: false,
    pocketCountAtShot: 0
  };
  rooms.set(code, room);
  return room;
}

function makeStatePayload(room) {
  return {
    t: 'state',
    state: {
      balls: room.state.balls.map(b => ({
        id: b.id,
        num: b.num,
        x: b.x, y: b.y, r: b.r,
        vx: b.vx, vy: b.vy,
        color: b.color,
        stripe: !!b.stripe,
        // new rendering hints for clients (optional)
        pattern: b.stripe ? 'stripe' : 'solid',
        stripeColor: '#ffffff',
        stripeWidth: Math.round(b.r * 1.2),
        stripeAngle: 0 // clients can randomize or animate this
      })),
      pocketed: room.state.pocketed.slice(-POCKET_CAP),
      players: room.players.map(p => ({ id: p.id, name: p.name, group: room.assigned ? room.assigned[p.id] : null })),
      turn: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
      ballInHand: !!room.ballInHand,
      lastEvent: room.lastEvent
    }
  };
}

function sendToRoom(room, obj) {
  const payload = JSON.stringify(Object.assign({ serverTime: Date.now() }, obj));
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(payload); });
}

/* GLOBAL PHYSICS LOOP */
setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    room.lastActive = now;
    const balls = room.state.balls;
    const substeps = 2;

    // compute per-step dt properly; velocities are in px/sec
    const dt = 1 / TICK_RATE;
    const dtSub = dt / substeps;

    for (let s = 0; s < substeps; s++) {
      for (const b of balls) {
        b.x += b.vx * dtSub;
        b.y += b.vy * dtSub;

        // bounds with correction
        if (b.x - b.r < 0) { b.x = b.r; b.vx = -b.vx * 0.98; }
        if (b.x + b.r > TABLE_W) { b.x = TABLE_W - b.r; b.vx = -b.vx * 0.98; }
        if (b.y - b.r < 0) { b.y = b.r; b.vy = -b.vy * 0.98; }
        if (b.y + b.r > TABLE_H) { b.y = TABLE_H - b.r; b.vy = -b.vy * 0.98; }
      }

      // collisions
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) resolveBallCollision(balls[i], balls[j]);
      }
    }

    // apply friction once per tick (not every substep)
    for (const b of balls) {
      b.vx *= GLOBAL_FRICTION;
      b.vy *= GLOBAL_FRICTION;
      const sp = vecLen(b.vx, b.vy);
      if (sp > 0 && sp < SLOW_SPEED) { b.vx *= LOW_SPEED_FRICTION; b.vy *= LOW_SPEED_FRICTION; }
      if (vecLen(b.vx, b.vy) < STOP_THRESH) { b.vx = 0; b.vy = 0; }
    }

    // pocket detection
    const pocketedNow = [];
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (ballShouldPocket(b)) {
        balls.splice(i, 1);
        room.state.pocketed.push(b.num);
        pocketedNow.push(b);
      }
    }
    if (room.state.pocketed.length > POCKET_CAP) room.state.pocketed = room.state.pocketed.slice(-POCKET_CAP);

    // handle pocketed events
    if (pocketedNow.length) {
      const shooter = room.lastShooterId || room.players[(room.turnIndex + room.players.length - 1) % Math.max(1, room.players.length)]?.id;
      const cuePocket = pocketedNow.some(p => p.num === 0);

      // assignment
      for (const pb of pocketedNow) {
        if (pb.num === 0 || pb.num === 8) continue;
        if (!room.assigned && shooter) {
          const solids = pb.num >= 1 && pb.num <= 7;
          room.assigned = {};
          room.players.forEach(pl => { room.assigned[pl.id] = (pl.id === shooter) ? (solids ? 'solids' : 'stripes') : (solids ? 'stripes' : 'solids'); });
          sendToRoom(room, { t: 'assigned', playerId: shooter, group: room.assigned[shooter] });
        }
      }

      // 8-ball checks
      if (pocketedNow.some(p => p.num === 8)) {
        if (!room.assigned) sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooter)?.name || 'Opponent', reason: '8 illegally pocketed' });
        else {
          const shooterGroup = room.assigned[shooter];
          const groupNums = shooterGroup === 'solids' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
          const cleared = groupNums.every(n => room.state.pocketed.includes(n));
          if (cleared && !cuePocket) sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id === shooter)?.name || 'Winner', reason: '8 legally pocketed' });
          else sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooter)?.name || 'Opponent', reason: '8 illegally pocketed' });
        }
      }

      if (cuePocket) { room.ballInHand = true; sendToRoom(room, { t: 'foul', msg: 'cue-pocket', playerId: shooter }); }

      // determine turn (existing rules)
      let madeOwn = false, madeOpp = false;
      if (room.assigned && shooter) {
        const shooterGroup = room.assigned[shooter];
        for (const pb of pocketedNow) {
          if (pb.num <= 0 || pb.num === 8) continue;
          const isSolid = pb.num >= 1 && pb.num <= 7;
          const made = (shooterGroup === 'solids' && isSolid) || (shooterGroup === 'stripes' && !isSolid);
          if (made) madeOwn = true; else madeOpp = true;
        }
      }
      if (!cuePocket) {
        if (!madeOwn || madeOpp) room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      } else room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);

      // shot finished
      room.shotInProgress = false;
      room.pocketCountAtShot = room.state.pocketed.length;
      room.lastShooterId = null;
      room.lastEvent = { pocketed: pocketedNow.map(p => p.num) };
    }

    // shot lifecycle: if shot in progress and balls are now stopped and NO pockets occurred -> pass turn
    const allStopped = room.state.balls.every(b => vecLen(b.vx || 0, b.vy || 0) < STOP_THRESH);
    if (room.shotInProgress && allStopped) {
      const pocketedNowTotal = room.state.pocketed.length - (room.pocketCountAtShot || 0);
      if (pocketedNowTotal === 0) {
        // no pockets were made during shot -> pass turn
        room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      }
      room.shotInProgress = false;
      room.pocketCountAtShot = room.state.pocketed.length;
      room.lastShooterId = null;
    }

    // broadcast throttled
    if (Date.now() - room.lastBroadcast >= 1000 / BROADCAST_RATE) {
      room.lastBroadcast = Date.now();
      sendToRoom(room, makeStatePayload(room));
      room.lastEvent = null;
    }
  });

  // cleanup
  const nowTime = Date.now();
  for (const [code, r] of rooms.entries()) {
    if (r.players.length === 0 && (nowTime - r.lastActive) > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 1000 / TICK_RATE);

/* HTTP rooms list */
app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach(r => list.push({ code: r.code, players: r.players.length, host: r.hostName || null }));
  res.json(list);
});

/* WS handling */
wss.on('connection', ws => {
  ws.id = uuidv4();
  ws.isHost = false;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const t = m.t;

    if (t === 'create') {
      const name = m.name || 'Host';
      const room = createRoom(name);
      room.hostId = ws.id; room.hostName = name;
      ws.isHost = true; ws.room = room.code; ws.name = name;
      room.players.push({ id: ws.id, ws, name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'join') {
      if (ws.isHost) { ws.send(JSON.stringify({ t: 'error', msg: 'hosts-cannot-join-rooms' })); return; }
      const code = (m.code || '').toUpperCase(); const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ t: 'error', msg: 'room-not-found' })); return; }
      if (room.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'error', msg: 'room-full' })); return; }
      ws.room = code; ws.name = m.name || 'Player'; room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'shoot') {
      const room = rooms.get(ws.room); if (!room) { ws.send(JSON.stringify({ t:'shoot_rejected', reason:'not-in-room' })); return; }
      if (room.players[room.turnIndex].id !== ws.id) { ws.send(JSON.stringify({ t:'shoot_rejected', reason:'not-your-turn' })); return; }
      const allStopped = room.state.balls.every(b => vecLen(b.vx || 0, b.vy || 0) < STOP_THRESH);
      if (!allStopped) { ws.send(JSON.stringify({ t:'shoot_rejected', reason:'balls-moving' })); return; }
      if (room.ballInHand) { ws.send(JSON.stringify({ t:'shoot_rejected', reason:'ball-in-hand' })); return; }
      room.lastShooterId = ws.id;
      room.shotInProgress = true;
      room.pocketCountAtShot = room.state.pocketed.length;
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) { ws.send(JSON.stringify({ t:'shoot_rejected', reason:'no-cue' })); return; }
      cue.vx = Math.cos(m.angle) * (m.power || 0) * SHOOT_SCALE;
      cue.vy = Math.sin(m.angle) * (m.power || 0) * SHOOT_SCALE;
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'place_cue') {
      const room = rooms.get(ws.room); if (!room) return;
      if (!room.ballInHand) { ws.send(JSON.stringify({ t:'place_rejected', reason:'not-ball-in-hand' })); return; }
      if (room.players[room.turnIndex].id !== ws.id) { ws.send(JSON.stringify({ t:'place_rejected', reason:'not-your-turn' })); return; }
      let x = clamp(m.x || 150, BALL_R + 5, TABLE_W - BALL_R - 5);
      let y = clamp(m.y || TABLE_H / 2, BALL_R + 5, TABLE_H - BALL_R - 5);
      room.state.balls = room.state.balls.filter(b => b.id !== 'cue');
      room.state.balls.push({ id: 'cue', num: 0, x, y, r: BALL_R, vx: 0, vy: 0, color: '#fff', stripe: false });
      room.ballInHand = false;
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'chat') {
      const room = rooms.get(ws.room); if (!room) return;
      // broadcast clean chat only
      sendToRoom(room, { t: 'chat', from: ws.name || 'Player', msg: m.msg });
      return;
    }

    if (t === 'request_state') {
      const room = rooms.get(ws.room); if (!room) return; sendToRoom(room, makeStatePayload(room)); return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room); if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.id);
    room.lastActive = Date.now();
    if (room.hostId === ws.id) { sendToRoom(room, { t:'error', msg:'host-left', reason:'host-closed-room' }); rooms.delete(room.code); return; }
    if (room.players.length === 0) room.lastActive = Date.now();
    else sendToRoom(room, makeStatePayload(room));
  });
});



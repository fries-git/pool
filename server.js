// server.js — improved physics + memory safety
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const server = app.listen(PORT, () => console.log(`HTTP running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* === CONFIG === */
const TABLE_W = 800;
const TABLE_H = 400;
const BALL_R = 10;
const POCKET_RADIUS = 24;
const TICK_RATE = 60;            // server physics ticks per second
const BROADCAST_RATE = 20;       // state broadcasts per second
const GLOBAL_FRICTION = 0.992;   // general friction factor (near 1 = low friction)
const LOW_SPEED_FRICTION = 0.88; // stronger damping when nearly stopped
const STOP_THRESH = 0.03;        // velocity magnitude below which we snap to zero
const SLOW_SPEED = 0.25;         // "slow" speed threshold to apply low-speed friction
const SHOOT_SCALE = 14;
const MAX_PLAYERS = 2;
const ROOM_IDLE_MS = 1000 * 60 * 5; // delete empty rooms older than 5 minutes
const POCKET_CAP = 64; // safety cap for pocketed array length

const POCKETS = [
  { x: 0, y: 0 }, { x: TABLE_W / 2, y: 0 }, { x: TABLE_W, y: 0 },
  { x: 0, y: TABLE_H }, { x: TABLE_W / 2, y: TABLE_H }, { x: TABLE_W, y: TABLE_H }
];

/* === STATE === */
const rooms = new Map();

/* === HELPERS === */
function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function makeRack() {
  const balls = [];
  const BALL_SP = BALL_R * 2 + 0.5;
  // cue
  balls.push({ id: 'cue', num: 0, x: 130, y: TABLE_H / 2, r: BALL_R, vx: 0, vy: 0, color: '#ffffff', stripe: false });
  const palette = {
    1: '#FFD400', 2: '#0047AB', 3: '#C41E3A', 4: '#6A0DAD', 5: '#FF8C00',
    6: '#006400', 7: '#6F1D1B', 8: '#000000', 9: '#FFD400', 10: '#0047AB',
    11: '#C41E3A', 12: '#6A0DAD', 13: '#FF8C00', 14: '#006400', 15: '#6F1D1B'
  };
  const apexX = TABLE_W - 160;
  const apexY = TABLE_H / 2;
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

function vecLen(vx, vy) { return Math.hypot(vx, vy); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function resolveBallCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (!dist) return;
  const minDist = a.r + b.r;
  if (dist >= minDist) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rel = rvx * nx + rvy * ny;
  if (rel > 0) return; // separating

  const e = 0.98; // restitution slightly less than perfect
  const j = -(1 + e) * rel / 2; // equal mass
  const ix = j * nx;
  const iy = j * ny;

  a.vx -= ix; a.vy -= iy;
  b.vx += ix; b.vy += iy;

  // positional correction (prevent sinking)
  const overlap = minDist - dist;
  const corr = overlap / 2 + 0.01;
  a.x -= nx * corr; a.y -= ny * corr;
  b.x += nx * corr; b.y += ny * corr;
}

function inPocket(ball) {
  for (const p of POCKETS) {
    if (Math.hypot(ball.x - p.x, ball.y - p.y) <= POCKET_RADIUS) return true;
  }
  return false;
}

/* === ROOM LIFECYCLE === */
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
    lastActive: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(code) {
  rooms.delete(code);
}

/* broadcast helper (throttled per room) */
function makeStatePayload(room) {
  return {
    t: 'state',
    state: {
      balls: room.state.balls.map(b => ({ id: b.id, num: b.num, x: b.x, y: b.y, r: b.r, vx: b.vx, vy: b.vy, color: b.color, stripe: b.stripe })),
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
  room.players.forEach(pl => { if (pl.ws && pl.ws.readyState === 1) pl.ws.send(payload); });
}

/* === PHYSICS LOOP (single global ticker) === */
setInterval(() => {
  const now = Date.now();

  rooms.forEach(room => {
    room.lastActive = now;
    const balls = room.state.balls;

    // small substeps for collisions stability
    const substeps = 2;
    for (let s = 0; s < substeps; s++) {
      // integrate velocities (scaled to tick/substep)
      for (const b of balls) {
        // position integration
        b.x += (b.vx) / (TICK_RATE) * (60 / substeps);
        b.y += (b.vy) / (TICK_RATE) * (60 / substeps);

        // apply general friction
        b.vx *= GLOBAL_FRICTION;
        b.vy *= GLOBAL_FRICTION;

        // if slow, apply stronger damping to stop quickly
        const speed = vecLen(b.vx, b.vy);
        if (speed > 0 && speed < SLOW_SPEED) {
          b.vx *= LOW_SPEED_FRICTION;
          b.vy *= LOW_SPEED_FRICTION;
        }

        // snap to zero when below threshold
        if (vecLen(b.vx, b.vy) < STOP_THRESH) { b.vx = 0; b.vy = 0; }

        // walls reflect with slight energy loss
        if (b.x - b.r < 0) { b.x = b.r; b.vx = -b.vx * 0.98; }
        if (b.x + b.r > TABLE_W) { b.x = TABLE_W - b.r; b.vx = -b.vx * 0.98; }
        if (b.y - b.r < 0) { b.y = b.r; b.vy = -b.vy * 0.98; }
        if (b.y + b.r > TABLE_H) { b.y = TABLE_H - b.r; b.vy = -b.vy * 0.98; }
      }

      // collisions O(n^2) but small n
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          resolveBallCollision(balls[i], balls[j]);
        }
      }
    }

    // pocket detection (remove pocketed balls)
    const pocketedNow = [];
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (inPocket(b)) {
        balls.splice(i, 1);
        room.state.pocketed.push(b.num);
        pocketedNow.push(b);
      }
    }
    // keep pocketed list bounded
    if (room.state.pocketed.length > POCKET_CAP) {
      room.state.pocketed = room.state.pocketed.slice(-POCKET_CAP);
    }

    // handle pocketed events minimally (assignment, cue pocket, 8-ball checks)
    if (pocketedNow.length > 0) {
      const shooterId = room.lastShooterId || room.players[(room.turnIndex + room.players.length - 1) % Math.max(1, room.players.length)]?.id;
      let cuePocket = pocketedNow.some(p => p.num === 0);

      // assignment on first object ball made
      for (const pb of pocketedNow) {
        if (pb.num === 0 || pb.num === 8) continue;
        if (!room.assigned && shooterId) {
          const solids = pb.num >= 1 && pb.num <= 7;
          room.assigned = {};
          room.players.forEach(pl => { room.assigned[pl.id] = (pl.id === shooterId) ? (solids ? 'solids' : 'stripes') : (solids ? 'stripes' : 'solids'); });
          sendToRoom(room, { t: 'assigned', playerId: shooterId, group: room.assigned[shooterId] });
        }
      }

      // basic 8-ball checks and fouls (kept minimal)
      if (pocketedNow.some(p => p.num === 8)) {
        if (!room.assigned) {
          sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooterId)?.name || 'Opponent', reason: '8 illegally pocketed' });
        } else {
          const shooterGroup = room.assigned[shooterId];
          const groupNums = shooterGroup === 'solids' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
          const cleared = groupNums.every(n => room.state.pocketed.includes(n));
          if (cleared && !cuePocket) {
            sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id === shooterId)?.name || 'Winner', reason: '8 legally pocketed' });
          } else {
            sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooterId)?.name || 'Opponent', reason: '8 pocketed illegally' });
          }
        }
      }

      // fouls: cue-pocket -> ball-in-hand
      if (cuePocket) {
        room.ballInHand = true;
        sendToRoom(room, { t: 'foul', msg: 'cue-pocket', playerId: shooterId });
      }

      // simple turn logic: shooter keeps turn only if they pocketed their group and didn't scratch; otherwise pass
      let madeOwn = false, madeOpp = false;
      if (room.assigned && shooterId) {
        const shooterGroup = room.assigned[shooterId];
        for (const pb of pocketedNow) {
          if (pb.num <= 0 || pb.num === 8) continue;
          const isSolid = pb.num >=1 && pb.num <=7;
          const made = (shooterGroup === 'solids' && isSolid) || (shooterGroup === 'stripes' && !isSolid);
          if (made) madeOwn = true; else madeOpp = true;
        }
      }
      if (!cuePocket) {
        if (!madeOwn || madeOpp) {
          room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
        }
      } else {
        room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      }

      room.lastShooterId = null;
      room.lastEvent = { pocketed: pocketedNow.map(p => p.num) };
    }

    // throttled broadcast
    if (now - room.lastBroadcast >= 1000 / BROADCAST_RATE) {
      room.lastBroadcast = now;
      sendToRoom(room, makeStatePayload(room));
      room.lastEvent = null;
    }

    // free empty rooms (immediate) and GC idle rooms after ROOM_IDLE_MS
    if (room.players.length === 0 && Date.now() - room.lastActive > 1000) {
      // mark deletion time by setting lastActive in the past; cleanup sweep will remove
    }
  });

  // cleanup sweep for empty rooms older than ROOM_IDLE_MS
  const cleanupNow = Date.now();
  for (const [code, r] of rooms.entries()) {
    if (r.players.length === 0 && (cleanupNow - r.lastActive) > ROOM_IDLE_MS) {
      rooms.delete(code);
    }
  }

}, 1000 / TICK_RATE);

/* === HTTP rooms list for server browser (lightweight) === */
app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach(r => { list.push({ code: r.code, players: r.players.length, host: r.hostName || null }); });
  res.json(list);
});

/* === WEBSOCKET HANDLING === */
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
      room.hostId = ws.id;
      room.hostName = name;
      ws.isHost = true;
      ws.room = room.code;
      ws.name = name;
      room.players.push({ id: ws.id, ws, name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      // immediate one-shot broadcast
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'join') {
      if (ws.isHost) {
        ws.send(JSON.stringify({ t: 'error', msg: 'hosts-cannot-join-rooms' })); return;
      }
      const code = (m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ t: 'error', msg: 'room-not-found' })); return; }
      if (room.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'error', msg: 'room-full' })); return; }
      ws.room = code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'shoot') {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      // ensure balls stopped and not placing cue
      const allStopped = room.state.balls.every(b => vecLen(b.vx || 0, b.vy || 0) < STOP_THRESH);
      if (!allStopped) return;
      if (room.ballInHand) return;
      room.lastShooterId = ws.id;
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) return;
      cue.vx = Math.cos(m.angle) * (m.power || 0) * SHOOT_SCALE;
      cue.vy = Math.sin(m.angle) * (m.power || 0) * SHOOT_SCALE;
      // immediate lightweight broadcast
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'place_cue') {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (!room.ballInHand) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      let x = clamp(m.x || 150, BALL_R + 5, TABLE_W - BALL_R - 5);
      let y = clamp(m.y || TABLE_H / 2, BALL_R + 5, TABLE_H - BALL_R - 5);
      room.state.balls = room.state.balls.filter(b => b.id !== 'cue');
      room.state.balls.push({ id: 'cue', num: 0, x, y, r: BALL_R, vx: 0, vy: 0, color: '#fff', stripe: false });
      room.ballInHand = false;
      sendToRoom(room, makeStatePayload(room));
      return;
    }

    if (t === 'chat') {
      const room = rooms.get(ws.room);
      if (!room) return;
      sendToRoom(room, { t: 'chat', from: ws.name || 'Player', msg: m.msg });
      return;
    }

    if (t === 'request_state') {
      const room = rooms.get(ws.room);
      if (!room) return;
      sendToRoom(room, makeStatePayload(room));
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.id);
    room.lastActive = Date.now();
    // if host left, tear down the room cleanly
    if (room.hostId === ws.id) {
      sendToRoom(room, { t: 'error', msg: 'host-left', reason: 'host-closed-room' });
      rooms.delete(room.code);
      return;
    }
    if (room.players.length === 0) {
      // mark lastActive and let cleanup sweep delete after ROOM_IDLE_MS
      room.lastActive = Date.now();
    } else {
      sendToRoom(room, makeStatePayload(room));
    }
  });
});

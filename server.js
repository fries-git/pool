// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const server = app.listen(PORT, () => console.log(`HTTP running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* --- Game constants --- */
const TABLE_W = 800;
const TABLE_H = 400;
const BALL_R = 10;
const POCKET_RADIUS = 24;
const TICK_RATE = 60;
const FRICTION = 0.99;
const SHOOT_SCALE = 14; // power -> initial velocity
const STOP_THRESH = 0.06; // below this considered stopped

/* pocket positions (six) */
const POCKETS = [
  { x: 0, y: 0 },
  { x: TABLE_W / 2, y: 0 },
  { x: TABLE_W, y: 0 },
  { x: 0, y: TABLE_H },
  { x: TABLE_W / 2, y: TABLE_H },
  { x: TABLE_W, y: TABLE_H },
];

const rooms = new Map();

/* helpers */
function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

/* setup standard 8-ball rack with apex */
function makeRack() {
  // apex position (x increases to right)
  const apexX = TABLE_W - 160;
  const apexY = TABLE_H / 2;
  const balls = [];

  // numbers/colors mapping (1..15). We'll store number, color, stripe boolean
  const palette = {
    1: { color: '#FFD400' }, // yellow
    2: { color: '#0047AB' }, // blue
    3: { color: '#C41E3A' }, // red
    4: { color: '#6A0DAD' }, // purple
    5: { color: '#FF8C00' }, // orange
    6: { color: '#006400' }, // green
    7: { color: '#6F1D1B' }, // maroon
    8: { color: '#000000' }, // black
    9: { color: '#FFD400' },
    10: { color: '#0047AB' },
    11: { color: '#C41E3A' },
    12: { color: '#6A0DAD' },
    13: { color: '#FF8C00' },
    14: { color: '#006400' },
    15: { color: '#6F1D1B' }
  };

  // Cue ball
  balls.push({ id: 'cue', num: 0, x: 130, y: TABLE_H / 2, r: BALL_R, vx: 0, vy: 0, color: '#ffffff', stripe: false });

  // triangle formation for 1..15
  let idNum = 1;
  const spacing = BALL_R * 2 + 0.5;
  for (let row = 0; row < 5; row++) {
    const rowX = apexX + row * spacing;
    for (let k = 0; k <= row; k++) {
      const rowY = apexY + (k - row / 2) * spacing;
      if (idNum > 15) break;
      const stripe = idNum >= 9;
      balls.push({
        id: 'b' + idNum,
        num: idNum,
        x: rowX,
        y: rowY,
        r: BALL_R,
        vx: 0,
        vy: 0,
        color: palette[idNum].color,
        stripe
      });
      idNum++;
    }
  }
  return balls;
}

/* Physics: elastic collision for equal mass balls */
function resolveBallCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return;
  const minDist = a.r + b.r;
  if (dist >= minDist) return;

  // unit normal
  const nx = dx / dist;
  const ny = dy / dist;

  // relative velocity b - a
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;

  // if velocities are separating, skip (velAlongNormal > 0 -> moving apart)
  if (velAlongNormal > 0) return;

  const e = 1.0; // restitution (elastic)
  const j = -(1 + e) * velAlongNormal / 2; // equal mass -> divide by 2

  const ix = j * nx;
  const iy = j * ny;

  a.vx -= ix;
  a.vy -= iy;
  b.vx += ix;
  b.vy += iy;

  // positional correction to avoid sinking
  const overlap = minDist - dist;
  const correction = (overlap / 2) + 0.01;
  a.x -= nx * correction;
  a.y -= ny * correction;
  b.x += nx * correction;
  b.y += ny * correction;
}

/* pocket detection */
function checkPocket(ball) {
  for (const p of POCKETS) {
    const d = Math.hypot(ball.x - p.x, ball.y - p.y);
    if (d <= POCKET_RADIUS) return true;
  }
  return false;
}

/* whether all balls are practically stopped */
function ballsStopped(room) {
  return room.state.balls.every(b => Math.hypot(b.vx || 0, b.vy || 0) < STOP_THRESH);
}

/* broadcast helper */
function sendToRoom(room, obj) {
  const s = JSON.stringify(obj);
  room.players.forEach(pl => { if (pl.ws.readyState === 1) pl.ws.send(s); });
}

/* create new room */
function createRoom(createdByName) {
  const code = randCode(4);
  const room = {
    code,
    players: [],
    turnIndex: 0,
    // assignedGroups: { playerId: 'solids'/'stripes' } set after first legal pocket
    assigned: null,
    state: {
      balls: makeRack(),
      pocketed: [], // list of numbers pocketed
    },
    ballInHand: false,
    lastEvent: null // short message to broadcast
  };
  rooms.set(code, room);
  return room;
}

/* update physics & game logic each tick */
function tickRooms() {
  rooms.forEach(room => {
    const balls = room.state.balls;

    // integrate velocities
    for (const b of balls) {
      b.x += b.vx;
      b.y += b.vy;
      b.vx *= FRICTION;
      b.vy *= FRICTION;

      // wall bounce
      if (b.x - b.r < 0) { b.x = b.r; b.vx = -b.vx; }
      if (b.x + b.r > TABLE_W) { b.x = TABLE_W - b.r; b.vx = -b.vx; }
      if (b.y - b.r < 0) { b.y = b.r; b.vy = -b.vy; }
      if (b.y + b.r > TABLE_H) { b.y = TABLE_H - b.r; b.vy = -b.vy; }
    }

    // collisions
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        resolveBallCollision(balls[i], balls[j]);
      }
    }

    // pocket detection - collect pocketed indices in this tick
    const pocketedThisTick = [];
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (checkPocket(b)) {
        // remove ball
        balls.splice(i, 1);
        room.state.pocketed.push(b.num);
        pocketedThisTick.push(b);
      }
    }

    // handle pocketed events (fouls, assignment, wins)
    if (pocketedThisTick.length > 0) {
      // determine which player made the shot = previous player (the one who shot last)
      // we assume turn was advanced immediately after shoot; we store lastShooterId temporarily on room
      const shooterId = room.lastShooterId || room.players[(room.turnIndex + room.players.length - 1) % room.players.length]?.id;

      // process each pocketed ball in order
      let madeOwn = false;
      let madeOpponent = false;
      let cueScratched = false;
      for (const pb of pocketedThisTick) {
        if (pb.num === 0) {
          // cue scratched
          cueScratched = true;
        } else if (pb.num === 8) {
          // 8-ball pocketed
          // determine legality
          if (!room.assigned) {
            // 8 before groups assigned => immediate loss for shooter
            room.lastEvent = { type: 'lose', by: shooterId, reason: '8-pocketed-early' };
            sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooterId)?.name || 'Opponent', reason: '8 illegally pocketed' });
            // reset room after a short delay (not implemented auto reset here)
          } else {
            // check if shooter has cleared their group
            const shooterGroup = room.assigned[shooterId];
            const groupNums = shooterGroup === 'solids' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
            const cleared = groupNums.every(n => room.state.pocketed.includes(n));
            if (cleared && !cueScratched) {
              room.lastEvent = { type: 'win', by: shooterId, reason: '8-pocketed-legal' };
              sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id === shooterId)?.name || 'Winner', reason: '8 legally pocketed' });
            } else {
              // pocketed illegally
              room.lastEvent = { type: 'lose', by: shooterId, reason: '8-illegal' };
              sendToRoom(room, { t: 'game_over', winner: room.players.find(p => p.id !== shooterId)?.name || 'Opponent', reason: '8 pocketed illegally' });
            }
          }
        } else {
          // normal object ball
          const isSolid = pb.num >= 1 && pb.num <= 7;
          // assign groups if not assigned yet
          if (!room.assigned && shooterId) {
            room.assigned = {};
            room.assigned[shooterId] = isSolid ? 'solids' : 'stripes';
            // assign other players the opposite group
            room.players.forEach(p => {
              if (p.id !== shooterId) room.assigned[p.id] = (isSolid ? 'stripes' : 'solids');
            });
            room.lastEvent = { type: 'assign', by: shooterId, group: room.assigned[shooterId] };
            sendToRoom(room, { t: 'assigned', playerId: shooterId, group: room.assigned[shooterId] });
          }
          // track if shooter made their group ball
          if (room.assigned && shooterId) {
            const shooterGroup = room.assigned[shooterId];
            const made = (shooterGroup === 'solids' && isSolid) || (shooterGroup === 'stripes' && !isSolid);
            if (made) madeOwn = true; else madeOpponent = true;
          }
        }
      }

      // fouls and turn resolution
      if (cueScratched) {
        // cue pocket -> foul, ball-in-hand to opponent
        room.ballInHand = true;
        room.lastEvent = { type: 'foul', by: shooterId, reason: 'cue-pocket' };
        // set cue back to table center-left for placement later
        // remove any existing cue (should already be removed if pocketed)
      }

      // determine whether shooter keeps turn:
      // if shooter made at least one own-group ball and didn't scratch -> keep turn
      // else turn passes (unless cue pocket happened -> turn passes and ball-in-hand)
      if (!cueScratched) {
        if (madeOwn && !madeOpponent) {
          // shooter keeps turn; do not advance turnIndex
          room.lastEvent = { type: 'info', msg: 'Made own ball - continue' };
        } else {
          // pass turn
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
        }
      } else {
        // foul: pass turn to opponent
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }

      // clear lastShooterId
      delete room.lastShooterId;
    }

    // broadcast updated state after handling events
    broadcastRoomState(room);
  });
}

/* Broadcast state shape simplified for client */
function broadcastRoomState(room) {
  const payload = {
    t: 'state',
    state: {
      balls: room.state.balls.map(b => ({
        id: b.id,
        num: b.num,
        x: b.x,
        y: b.y,
        r: b.r,
        vx: b.vx,
        vy: b.vy,
        color: b.color,
        stripe: b.stripe
      })),
      pocketed: room.state.pocketed.slice(),
      players: room.players.map(p => ({ id: p.id, name: p.name, group: room.assigned ? room.assigned[p.id] : null })),
      turn: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
      ballInHand: room.ballInHand || false,
      lastEvent: room.lastEvent || null
    }
  };
  sendToRoom(room, payload);
  room.lastEvent = null;
}

/* periodic tick */
setInterval(tickRooms, 1000 / TICK_RATE);

/* WebSocket handling */
wss.on('connection', ws => {
  ws.id = uuidv4();

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const t = m.t;

    if (t === 'create') {
      const room = createRoom(m.name || 'Player');
      ws.room = room.code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      broadcastRoomState(room);
      return;
    }

    if (t === 'join') {
      const code = (m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ t: 'error', msg: 'room-not-found' }));
        return;
      }
      ws.room = code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: ws.id }));
      broadcastRoomState(room);
      return;
    }

    if (t === 'shoot') {
      const room = rooms.get(ws.room);
      if (!room) return;
      // enforce turn and balls stopped and no ball-in-hand placement active
      if (room.players[room.turnIndex].id !== ws.id) return;
      if (!ballsStopped(room)) return;
      if (room.ballInHand) return; // must place cue first
      // register last shooter
      room.lastShooterId = ws.id;
      // apply velocity to cue
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) return;
      cue.vx = Math.cos(m.angle) * (m.power || 0) * SHOOT_SCALE;
      cue.vy = Math.sin(m.angle) * (m.power || 0) * SHOOT_SCALE;
      // advance turn immediately only if shot causes no pocket? We'll let pocket logic decide continuation.
      // For safety we don't change turn here; pocket handling will decide.
      broadcastRoomState(room);
      return;
    }

    if (t === 'chat') {
      const room = rooms.get(ws.room);
      if (!room) return;
      const payload = { t: 'chat', from: ws.name || 'Player', msg: m.msg };
      sendToRoom(room, payload);
      return;
    }

    if (t === 'request_state') {
      const room = rooms.get(ws.room);
      if (room) broadcastRoomState(room);
      return;
    }

    if (t === 'place_cue') {
      // place cue when ballInHand true and it's player's turn
      const room = rooms.get(ws.room);
      if (!room) return;
      if (!room.ballInHand) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      // remove existing cue if present (should not be present)
      room.state.balls = room.state.balls.filter(b => b.id !== 'cue');
      // clamp position inside table and away from pockets a bit
      let x = Math.max(BALL_R + 5, Math.min(TABLE_W - BALL_R - 5, m.x || 150));
      let y = Math.max(BALL_R + 5, Math.min(TABLE_H - BALL_R - 5, m.y || TABLE_H / 2));
      room.state.balls.push({ id: 'cue', num: 0, x, y, r: BALL_R, vx: 0, vy: 0, color: '#fff', stripe: false });
      room.ballInHand = false;
      broadcastRoomState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.id);
    if (room.players.length === 0) rooms.delete(ws.room);
    else broadcastRoomState(room);
  });
});


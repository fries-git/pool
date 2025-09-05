// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

/* --- simple rooms HTTP list for server browser --- */
app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach(r => {
    list.push({ code: r.code, players: r.players.length, host: r.hostName || null });
  });
  res.json(list);
});

const server = app.listen(PORT, () => console.log(`HTTP running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* --- Game constants --- */
const TABLE_W = 800;
const TABLE_H = 400;
const BALL_R = 10;
const POCKET_RADIUS = 24;
const TICK_RATE = 30; // physics update rate (server)
const BROADCAST_RATE = 20; // how many state broadcasts per second
const FRICTION = 0.993; // higher -> less friction (more realistic)
const STOP_THRESH = 0.02; // below this velocity considered stopped (snap to zero)
const SHOOT_SCALE = 14;
const MAX_PLAYERS = 2;

const POCKETS = [
  { x: 0, y: 0 }, { x: TABLE_W/2, y: 0 }, { x: TABLE_W, y: 0 },
  { x: 0, y: TABLE_H }, { x: TABLE_W/2, y: TABLE_H }, { x: TABLE_W, y: TABLE_H }
];

const rooms = new Map();

/* helpers */
function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* build standard rack + cue (15 object balls + cue) */
function makeRack() {
  const balls = [];
  const BALL_SP = BALL_R * 2 + 0.5;
  // cue
  balls.push({ id: 'cue', num: 0, x: 130, y: TABLE_H/2, r: BALL_R, vx:0, vy:0, color:'#ffffff', stripe:false });
  // color map
  const palette = {
    1:'#FFD400',2:'#0047AB',3:'#C41E3A',4:'#6A0DAD',5:'#FF8C00',6:'#006400',7:'#6F1D1B',
    8:'#000000',9:'#FFD400',10:'#0047AB',11:'#C41E3A',12:'#6A0DAD',13:'#FF8C00',14:'#006400',15:'#6F1D1B'
  };
  const apexX = TABLE_W - 160;
  const apexY = TABLE_H/2;
  let n = 1;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      if (n > 15) break;
      const x = apexX + row * BALL_SP;
      const y = apexY + (i - row/2) * BALL_SP;
      balls.push({ id:`b${n}`, num:n, x, y, r:BALL_R, vx:0, vy:0, color: palette[n], stripe: n>=9 });
      n++;
    }
  }
  return balls;
}

/* collision */
function resolveBallCollision(a,b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx,dy);
  if (dist === 0) return;
  const minDist = a.r + b.r;
  if (dist >= minDist) return;
  const nx = dx / dist;
  const ny = dy / dist;
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rel = rvx*nx + rvy*ny;
  if (rel > 0) return;
  const e = 0.99;
  const j = -(1+e)*rel/2;
  const ix = j*nx, iy = j*ny;
  a.vx -= ix; a.vy -= iy;
  b.vx += ix; b.vy += iy;
  // positional correction
  const overlap = minDist - dist;
  const corr = overlap/2 + 0.01;
  a.x -= nx*corr; a.y -= ny*corr;
  b.x += nx*corr; b.y += ny*corr;
}

/* pocket check */
function inPocket(ball) {
  for (const p of POCKETS) {
    if (Math.hypot(ball.x - p.x, ball.y - p.y) <= POCKET_RADIUS) return true;
  }
  return false;
}

/* all stopped */
function ballsStopped(room) {
  return room.state.balls.every(b => Math.hypot(b.vx||0, b.vy||0) < STOP_THRESH);
}

/* create room */
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
    lastBroadcast: Date.now()
  };
  rooms.set(code, room);
  return room;
}

/* broadcast (attach server timestamp) */
function sendToRoom(room, obj) {
  const payload = JSON.stringify(Object.assign({ serverTime: Date.now() }, obj));
  room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(payload); });
}

/* prepare state for clients */
function makeStatePayload(room) {
  return {
    t: 'state',
    state: {
      balls: room.state.balls.map(b => ({
        id: b.id, num: b.num, x: b.x, y: b.y, r: b.r, vx: b.vx, vy: b.vy, color: b.color, stripe: b.stripe
      })),
      pocketed: room.state.pocketed.slice(),
      players: room.players.map(p => ({ id: p.id, name: p.name, group: room.assigned ? room.assigned[p.id] : null })),
      turn: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
      ballInHand: !!room.ballInHand,
      lastEvent: room.lastEvent
    }
  };
}

/* physics tick at TICK_RATE */
setInterval(() => {
  rooms.forEach(room => {
    const balls = room.state.balls;
    // integrate
    for (const b of balls) {
      b.x += b.vx / TICK_RATE * 60; // normalize movement to 60fps feel
      b.y += b.vy / TICK_RATE * 60;
      b.vx *= FRICTION;
      b.vy *= FRICTION;
      // snap small velocities
      if (Math.hypot(b.vx, b.vy) < STOP_THRESH) { b.vx = 0; b.vy = 0; }
      // walls
      if (b.x - b.r < 0) { b.x = b.r; b.vx = -b.vx * 0.98; }
      if (b.x + b.r > TABLE_W) { b.x = TABLE_W - b.r; b.vx = -b.vx * 0.98; }
      if (b.y - b.r < 0) { b.y = b.r; b.vy = -b.vy * 0.98; }
      if (b.y + b.r > TABLE_H) { b.y = TABLE_H - b.r; b.vy = -b.vy * 0.98; }
    }
    // collisions
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        resolveBallCollision(balls[i], balls[j]);
      }
    }
    // pockets
    const pocketedNow = [];
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (inPocket(b)) {
        balls.splice(i,1);
        room.state.pocketed.push(b.num);
        pocketedNow.push(b);
      }
    }
    // process pocketed events (simplified: assignment, 8-ball rules, fouls)
    if (pocketedNow.length) {
      const shooter = room.lastShooterId || room.players[(room.turnIndex + room.players.length - 1) % room.players.length]?.id;
      let cuePocket = pocketedNow.some(p => p.num === 0);
      // assignment
      pocketedNow.forEach(pb => {
        if (pb.num === 0) return;
        if (!room.assigned && shooter) {
          const solids = pb.num >=1 && pb.num <=7;
          room.assigned = {};
          room.players.forEach(pl => { room.assigned[pl.id] = (pl.id === shooter) ? (solids ? 'solids' : 'stripes') : (solids ? 'stripes' : 'solids'); });
          sendToRoom(room, { t:'assigned', playerId: shooter, group: room.assigned[shooter] });
        }
      });
      // basic 8-ball win/lose check
      pocketedNow.forEach(pb => {
        if (pb.num === 8) {
          if (!room.assigned) {
            // illegal 8
            sendToRoom(room, { t:'game_over', winner: room.players.find(p => p.id !== shooter)?.name || 'Opponent', reason: '8 illegally pocketed' });
          } else {
            const shooterGroup = room.assigned[shooter];
            const groupNums = shooterGroup === 'solids' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
            const cleared = groupNums.every(n => room.state.pocketed.includes(n));
            if (cleared && !cuePocket) {
              sendToRoom(room, { t:'game_over', winner: room.players.find(p => p.id === shooter)?.name || 'Winner', reason: '8 legally pocketed' });
            } else {
              sendToRoom(room, { t:'game_over', winner: room.players.find(p => p.id !== shooter)?.name || 'Opponent', reason: '8 pocketed illegally' });
            }
          }
        }
      });
      // fouls: cue pocket => ball-in-hand to opponent
      if (cuePocket) {
        room.ballInHand = true;
        sendToRoom(room, { t:'foul', msg:'cue-pocket', playerId: shooter });
      }
      // simple turn resolution: if shooter made own group and didn't scratch they keep turn. Otherwise pass.
      let madeOwn = false, madeOpp = false;
      if (room.assigned && shooter) {
        const shooterGroup = room.assigned[shooter];
        pocketedNow.forEach(pb => {
          if (pb.num === 0 || pb.num === 8) return;
          const isSolid = pb.num >=1 && pb.num <=7;
          const made = (shooterGroup === 'solids' && isSolid) || (shooterGroup === 'stripes' && !isSolid);
          if (made) madeOwn = true; else madeOpp = true;
        });
      }
      if (!cuePocket) {
        if (!madeOwn || madeOpp) {
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
        }
      } else {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }
      room.lastShooterId = null;
      room.lastEvent = { pocketed: pocketedNow.map(p=>p.num) };
    }

    // throttled broadcast
    const now = Date.now();
    if (now - room.lastBroadcast >= 1000 / BROADCAST_RATE) {
      room.lastBroadcast = now;
      sendToRoom(room, makeStatePayload(room));
    }
  });
}, 1000 / TICK_RATE);

/* WebSocket handling */
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
      ws.send(JSON.stringify({ t:'joined', code: room.code, id: ws.id }));
      sendToRoom(room, makeStatePayload(room));
      return;
    }
    if (t === 'join') {
      // server prevents hosts from joining rooms (they are rooms' creators)
      if (ws.isHost) {
        ws.send(JSON.stringify({ t:'error', msg: 'hosts-cannot-join-rooms' }));
        return;
      }
      const code = (m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ t:'error', msg:'room-not-found' })); return; }
      if (room.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t:'error', msg:'room-full' })); return; }
      ws.room = code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t:'joined', code: room.code, id: ws.id }));
      sendToRoom(room, makeStatePayload(room));
      return;
    }
    if (t === 'shoot') {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      if (!ballsStopped(room)) return;
      if (room.ballInHand) return;
      // register shooter
      room.lastShooterId = ws.id;
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) return;
      cue.vx = Math.cos(m.angle) * (m.power || 0) * SHOOT_SCALE;
      cue.vy = Math.sin(m.angle) * (m.power || 0) * SHOOT_SCALE;
      // broadcast immediate minimal state
      sendToRoom(room, makeStatePayload(room));
      return;
    }
    if (t === 'chat') {
      const room = rooms.get(ws.room);
      if (!room) return;
      sendToRoom(room, { t:'chat', from: ws.name || 'Player', msg: m.msg });
      return;
    }
    if (t === 'request_state') {
      const room = rooms.get(ws.room);
      if (!room) return;
      sendToRoom(room, makeStatePayload(room));
      return;
    }
    if (t === 'place_cue') {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (!room.ballInHand) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      // clamp
      let x = Math.max(BALL_R + 5, Math.min(TABLE_W - BALL_R - 5, m.x || 150));
      let y = Math.max(BALL_R + 5, Math.min(TABLE_H - BALL_R - 5, m.y || TABLE_H/2));
      // remove any existing cue then add
      room.state.balls = room.state.balls.filter(b => b.id !== 'cue');
      room.state.balls.push({ id:'cue', num:0, x, y, r:BALL_R, vx:0, vy:0, color:'#fff', stripe:false });
      room.ballInHand = false;
      sendToRoom(room, makeStatePayload(room));
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.id);
    // if host leaves, drop room and notify
    if (room.hostId === ws.id) {
      sendToRoom(room, { t:'error', msg:'host-left', reason:'host-closed-room' });
      rooms.delete(room.code);
      return;
    }
    if (room.players.length === 0) rooms.delete(room.code);
    else sendToRoom(room, makeStatePayload(room));
  });
});

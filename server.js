// Simple authoritative server + static file host
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });


const PORT = process.env.PORT || 3000;
app.use(express.static('public')); // client HTML goes in /public


// rooms: {code: {players: Map(clientId->ws), state: {...}, lastUpdate}}
const rooms = new Map();


function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // avoid ambiguous letters
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}


function createRoom() {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = {
    code,
    players: new Map(),
    state: createInitialState(),
    lastTick: Date.now()
  };
  rooms.set(code, room);
  return room;
}


function createInitialState() {
  // simple 2D top-down pool: 8 balls + cue ball
  const balls = [];
  const radius = 10;
  // place cue ball
  balls.push({ id: 'cue', x: 140, y: 200, vx: 0, vy: 0, r: radius });
  // simple rack (triangle)
  const startX = 540, startY = 200;
  let id = 1;
  for (let row = 0; row < 4; row++) {
    for (let c = 0; c <= row; c++) {
      balls.push({
        id: 'b' + id++,
        x: startX + row * (radius * 2 + 1),
        y: startY + (c - row/2) * (radius * 2 + 1),
        vx: 0, vy: 0, r: radius
      });
    }
  }
  return { balls, table: { w: 800, h: 400 }, timestamp: Date.now() };
}


// physics helpers
function stepPhysics(state, dt) {
  const balls = state.balls;
  // integrate
  for (const b of balls) {
    // simple damping
    b.vx *= 0.999;
    b.vy *= 0.999;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // wall collisions
    if (b.x - b.r < 0) { b.x = b.r; b.vx = -b.vx; }
    if (b.x + b.r > state.table.w) { b.x = state.table.w - b.r; b.vx = -b.vx; }
    if (b.y - b.r < 0) { b.y = b.r; b.vy = -b.vy; }
    if (b.y + b.r > state.table.h) { b.y = state.table.h - b.r; b.vy = -b.vy; }
  }
  // ball-ball collisions naive O(n^2)
  for (let i = 0; i < balls.length; i++) {
    for (let j = i+1; j < balls.length; j++) {
      const A = balls[i], B = balls[j];
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const dist2 = dx*dx + dy*dy;
      const minDist = A.r + B.r;
      if (dist2 <= minDist*minDist && dist2 > 0) {
        const dist = Math.sqrt(dist2);
        const nx = dx / dist;
        const ny = dy / dist;
        // relative velocity along normal
        const rvx = B.vx - A.vx;
        const rvy = B.vy - A.vy;
        const relVel = rvx * nx + rvy * ny;
        if (relVel < 0) {
          // simple equal-mass elastic impulse
          const impulse = - (1.9) * relVel / 2; // little extra elasticity
          const ix = impulse * nx;
          const iy = impulse * ny;
          A.vx -= ix;
          A.vy -= iy;
          B.vx += ix;
          B.vy += iy;
        }
        // positional correction to avoid sinking
        const overlap = minDist - dist;
        const correction = overlap / 2 + 0.01;
        A.x -= nx * correction;
        A.y -= ny * correction;
        B.x += nx * correction;
        B.y += ny * correction;
      }
    }
  }
  state.timestamp = Date.now();
}


// server tick per room
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = (now - room.lastTick) / 1000;
    if (dt <= 0) continue;
    // limit dt for stability
    const steps = Math.max(1, Math.min(5, Math.floor(dt*60)));
    const subDt = dt / steps;
    for (let i=0;i<steps;i++) stepPhysics(room.state, subDt);
    room.lastTick = now;
    // broadcast (throttle)
    const payload = JSON.stringify({ t: 'state', state: room.state });
    for (const [, ws] of room.players) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}, 50); // broadcast ~20Hz, physics integrated above


wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.room = null;


  ws.on('message', (msg) => {
    let m;
    try { m = JSON.parse(msg.toString()); } catch(e) { return; }
    if (m.t === 'create') {
      const room = createRoom();
      joinRoom(ws, room.code);
    } else if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase();
      if (!rooms.has(code)) {
        ws.send(JSON.stringify({ t: 'error', msg: 'room-not-found' }));
        return;
      }
      joinRoom(ws, code);
    } else if (m.t === 'shoot') {
      // {t:'shoot', power, angle}
      const room = rooms.get(ws.room);
      if (!room) return;
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) return;
      // only allow if cue slow enough
      const speed = Math.hypot(cue.vx, cue.vy);
      if (speed > 5) return;
      const power = Math.max(0, Math.min(1, +m.power || 0));
      const angle = +m.angle || 0;
      const force = power * 700; // tune constant
      cue.vx += Math.cos(angle) * force;
      cue.vy += Math.sin(angle) * force;
    } else if (m.t === 'request_state') {
      const room = rooms.get(ws.room);
      if (room) ws.send(JSON.stringify({ t: 'state', state: room.state }));
    }
  });


  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) {
      const room = rooms.get(ws.room);
      room.players.delete(ws.id);
      if (room.players.size === 0) rooms.delete(room.code);
    }
  });
});


function joinRoom(ws, code) {
  const room = rooms.get(code) || createRoom(code);
  room.players.set(ws.id, ws);
  ws.room = room.code;
  ws.send(JSON.stringify({ t: 'joined', code: room.code }));
  // immediately send authoritative state
  ws.send(JSON.stringify({ t: 'state', state: room.state }));
}


server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
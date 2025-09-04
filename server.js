const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const server = app.listen(PORT, () => console.log(`HTTP running on ${PORT}`));
const wss = new WebSocketServer({ server });

const rooms = new Map();

// Utils
function generateRoomCode(len = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Ball collision
function collideBalls(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < a.r + b.r && dist !== 0) {
    const nx = dx / dist;
    const ny = dy / dist;
    const dvx = a.vx - b.vx;
    const dvy = a.vy - b.vy;
    const rel = dvx * nx + dvy * ny;
    if (rel > 0) return;
    const impulse = 2 * rel / 2; // mass=1
    a.vx -= impulse * nx;
    a.vy -= impulse * ny;
    b.vx += impulse * nx;
    b.vy += impulse * ny;
    const overlap = a.r + b.r - dist;
    a.x -= nx * overlap / 2;
    a.y -= ny * overlap / 2;
    b.x += nx * overlap / 2;
    b.y += ny * overlap / 2;
  }
}

function updateBalls(room) {
  if (!room.state) return;
  const balls = room.state.balls;
  for (const b of balls) {
    b.x += b.vx;
    b.y += b.vy;
    b.vx *= 0.97;
    b.vy *= 0.97;
    if (b.x - b.r < 0) { b.x = b.r; b.vx *= -1; }
    if (b.x + b.r > 800) { b.x = 800 - b.r; b.vx *= -1; }
    if (b.y - b.r < 0) { b.y = b.r; b.vy *= -1; }
    if (b.y + b.r > 400) { b.y = 400 - b.r; b.vy *= -1; }
  }
  for (let i = 0; i < balls.length; i++)
    for (let j = i + 1; j < balls.length; j++)
      collideBalls(balls[i], balls[j]);
}

// Check if all balls nearly stopped
function ballsStopped(room) {
  return room.state.balls.every(b => Math.hypot(b.vx, b.vy) < 0.05);
}

function broadcastState(room) {
  const payload = JSON.stringify({
    t: 'state',
    state: {
      balls: room.state.balls,
      players: room.players.map(p => ({ id: p.id, name: p.name })),
      turn: room.players[room.turnIndex]?.id || null
    }
  });
  room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(payload); });
}

function nextTurn(room) {
  if (!room.players.length) return;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
}

// Physics & broadcast loop
setInterval(() => {
  rooms.forEach(room => {
    updateBalls(room);
    broadcastState(room);
  });
}, 1000 / 30);

// WebSocket
wss.on('connection', ws => {
  ws.id = uuidv4();

  ws.on('message', msg => {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    const t = m.t;

    // create room
    if (t === 'create') {
      const code = generateRoomCode();
      const room = {
        code,
        players: [],
        turnIndex: 0,
        state: {
          balls: [
            { id: 'cue', x: 400, y: 300, r: 8, vx: 0, vy: 0 },
            { id: 'b1', x: 500, y: 300, r: 8, vx: 0, vy: 0 },
            { id: 'b2', x: 550, y: 300, r: 8, vx: 0, vy: 0 },
            { id: 'b3', x: 600, y: 300, r: 8, vx: 0, vy: 0 },
            { id: 'b4', x: 650, y: 300, r: 8, vx: 0, vy: 0 }
          ]
        }
      };
      rooms.set(code, room);
      ws.room = code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code, id: ws.id }));
      return;
    }

    // join room
    if (t === 'join') {
      const code = m.code;
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ t: 'error', msg: 'Room not found' })); return; }
      ws.room = code;
      ws.name = m.name || 'Player';
      room.players.push({ id: ws.id, ws, name: ws.name });
      ws.send(JSON.stringify({ t: 'joined', code, id: ws.id }));
      return;
    }

    // shoot
    if (t === 'shoot') {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (room.players[room.turnIndex].id !== ws.id) return;
      if (!ballsStopped(room)) return; // only shoot if balls stopped
      const cue = room.state.balls.find(b => b.id === 'cue');
      if (!cue) return;
      cue.vx = Math.cos(m.angle) * m.power * 10;
      cue.vy = Math.sin(m.angle) * m.power * 10;
      nextTurn(room);
      return;
    }

    // chat
    if (t === 'chat') {
      const room = rooms.get(ws.room);
      if (!room) return;
      const payload = JSON.stringify({ t: 'chat', from: ws.name, msg: m.msg });
      room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(payload); });
      return;
    }

    // request state
    if (t === 'request_state') {
      const room = rooms.get(ws.room);
      if (room) broadcastState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.id);
    if (room.players.length === 0) rooms.delete(ws.room);
  });
});

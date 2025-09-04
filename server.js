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
function generateRoomCode(len=4){
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code='';
  for(let i=0;i<len;i++) code+=chars[Math.floor(Math.random()*chars.length)];
  return code;
}

// Physics
function updateBalls(room){
  if(!room.state) return;
  for(const b of room.state.balls){
    b.x += b.vx;
    b.y += b.vy;
    // Friction
    b.vx *= 0.98;
    b.vy *= 0.98;
    // Bounce walls
    if(b.x-b.r<0){b.x=b.r;b.vx*=-1;}
    if(b.x+b.r>800){b.x=800-b.r;b.vx*=-1;}
    if(b.y-b.r<0){b.y=b.r;b.vy*=-1;}
    if(b.y+b.r>400){b.y=400-b.r;b.vy*=-1;}
  }
}

// Send state
function broadcastState(room){
  const payload=JSON.stringify({t:'state',state:room.state});
  room.players.forEach(p=>{if(p.ws.readyState===1)p.ws.send(payload);});
}

// Player order
function nextTurn(room){
  room.turnIndex=(room.turnIndex+1)%room.players.length;
}

// Tick
setInterval(()=>{
  rooms.forEach(room=>{
    updateBalls(room);
    broadcastState(room);
  });
},1000/30);

// WebSocket handling
wss.on('connection', ws=>{
  ws.id=uuidv4();
  ws.on('message', message=>{
    let msg;
    try{ msg=JSON.parse(message);}catch{ return; }
    const t=msg.t;
    // Create room
    if(t==='create'){
      const code=generateRoomCode();
      const room={code,players:[],turnIndex:0,state:{
        balls:[
          {id:'cue',x:400,y:300,r:8,vx:0,vy:0},
          {id:'b1',x:500,y:300,r:8,vx:0,vy:0},
          {id:'b2',x:550,y:300,r:8,vx:0,vy:0}
        ]
      }};
      rooms.set(code,room);
      ws.room=code;
      ws.name=msg.name||'Player';
      room.players.push({id:ws.id,ws,name:ws.name});
      ws.send(JSON.stringify({t:'joined',code,id:ws.id}));
      console.log(`Room created: ${code} by ${ws.name}`);
      return;
    }
    // Join room
    if(t==='join'){
      const code=msg.code;
      const room=rooms.get(code);
      if(!room){ws.send(JSON.stringify({t:'error',msg:'Room not found'}));return;}
      ws.room=code;
      ws.name=msg.name||'Player';
      room.players.push({id:ws.id,ws,name:ws.name});
      ws.send(JSON.stringify({t:'joined',code,id:ws.id}));
      console.log(`${ws.name} joined room ${code}`);
      return;
    }
    // Shoot
    if(t==='shoot'){
      const room=rooms.get(ws.room);
      if(!room || !room.state) return;
      const player=room.players[room.turnIndex];
      if(player.id!==ws.id) return; // not this player's turn
      const cue=room.state.balls.find(b=>b.id==='cue');
      if(!cue) return;
      cue.vx=Math.cos(msg.angle)*msg.power*10;
      cue.vy=Math.sin(msg.angle)*msg.power*10;
      nextTurn(room);
      return;
    }
    // Chat
    if(t==='chat'){
      const room=rooms.get(ws.room);
      if(!room) return;
      const payload=JSON.stringify({t:'chat',from:ws.name,msg:msg.msg});
      room.players.forEach(p=>{if(p.ws.readyState===1)p.ws.send(payload);});
      return;
    }
    // Request state
    if(t==='request_state'){
      const room=rooms.get(ws.room);
      if(room && room.state) ws.send(JSON.stringify({t:'state',state:room.state}));
      return;
    }
  });

  ws.on('close', ()=>{
    const room=rooms.get(ws.room);
    if(!room) return;
    room.players=room.players.filter(p=>p.id!==ws.id);
    if(room.players.length===0) rooms.delete(ws.room);
  });
});

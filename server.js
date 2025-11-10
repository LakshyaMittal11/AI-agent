// server.js
// Lightweight signaling + realtime chat for WebRTC app
// Usage:
//   npm init -y
//   npm install express socket.io
//   node server.js
//
// Open: http://localhost:3000

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// allow simple CORS for dev
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// serve static frontend from ./public
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  console.log(`🟢 Connected: ${socket.id}`);

  // init per-socket data
  socket.data = socket.data || { name: 'Anonymous', room: null };

  // Client: socket.emit('join', { room, name })
  socket.on('join', ({ room, name } = {}) => {
    try {
      if (!room) {
        socket.emit('error', { message: 'room required' });
        return;
      }
      socket.join(room);
      socket.data.room = room;
      socket.data.name = (typeof name === 'string' && name.trim()) ? name.trim() : 'Anonymous';

      console.log(`👤 ${socket.id} (${socket.data.name}) joined room ${room}`);

      // send list of others in room to joining client
      const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
      const otherClients = clients
        .filter(id => id !== socket.id)
        .map(id => {
          const s = io.sockets.sockets.get(id);
          return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous' };
        });
      socket.emit('existingPeers', otherClients);

      // notify others about this join (so they can prepare / create offers if call started)
      socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name });
    } catch (err) {
      console.error('join error', err);
    }
  });

  // signaling: { to, data } where data is offer/answer/candidate
  socket.on('signal', ({ to, data } = {}) => {
    try {
      if (!data) return;
      if (to) {
        // P2P signaling
        io.to(to).emit('signal', { from: socket.id, data });
      } else if (socket.data.room) {
        // broadcast within room (excluding sender)
        socket.to(socket.data.room).emit('signal', { from: socket.id, data });
      }
      // optional debug
      // console.log(`🔁 signal from ${socket.id} to ${to || 'room:' + socket.data.room}`, data.type || (data.candidate ? 'candidate' : 'unknown'));
    } catch (err) {
      console.warn('signal error', err);
    }
  });

  // chatMessage: { room, text }
  socket.on('chatMessage', ({ room, text } = {}) => {
    try {
      if (!room || typeof text !== 'string') return;
      const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
      console.log(`💬 [${room}] ${socket.id} (${name}): ${text}`);
      socket.to(room).emit('chatMessage', { from: socket.id, name, text });
    } catch (err) {
      console.warn('chatMessage error', err);
    }
  });

  // leave -> notify others and leave room
  socket.on('leave', () => {
    try {
      const room = socket.data.room;
      const name = socket.data.name || 'Anonymous';
      if (room) {
        console.log(`🚪 ${socket.id} (${name}) left room ${room}`);
        socket.to(room).emit('peer-left', { id: socket.id, name });
        socket.leave(room);
        socket.data.room = null;
      }
    } catch (err) {
      console.warn('leave error', err);
    }
  });

  // disconnect
  socket.on('disconnect', (reason) => {
    try {
      const room = socket.data.room;
      const name = socket.data.name || 'Anonymous';
      if (room) {
        socket.to(room).emit('peer-left', { id: socket.id, name });
      }
      console.log(`🔴 Disconnected: ${socket.id} (${name}) reason=${reason}`);
    } catch (err) {
      console.warn('disconnect error', err);
    }
  });

  // small health-check
  socket.on('ping-server', cb => {
    if (typeof cb === 'function') cb({ ok: true, ts: Date.now() });
  });
});

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

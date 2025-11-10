// server.js
// Lightweight signaling + realtime chat (no DB).
// Usage: node server.js
// Put your client files in ./public and open http://localhost:3000

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow CORS in case you open from other origins during dev
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET","POST"]
  }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Simple in-memory room -> [socketId,...] mapping is available via adapter, but
// we centralize some debug info via logs.
io.on('connection', socket => {
  console.log(`🟢 Connected: ${socket.id}`);

  // initialize per-socket metadata
  socket.data = socket.data || {};
  socket.room = socket.room || null;

  // Join expects: { room, name }
  socket.on('join', ({ room, name } = {}) => {
    try {
      if (!room) {
        socket.emit('error', { message: 'room required' });
        return;
      }
      socket.join(room);
      socket.room = room;
      socket.data.name = (typeof name === 'string' && name.trim()) ? name.trim() : 'Anonymous';
      console.log(`👤 ${socket.id} (${socket.data.name}) joined room ${room}`);

      // Optionally send empty chat history (not persisted)
      socket.emit('chatHistory', []);

      // Tell others a peer joined (so they can create offers)
      socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name });

      // Tell the joining socket about existing peers (id + name)
      const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
      const otherClients = clients
        .filter(id => id !== socket.id)
        .map(id => {
          const s = io.sockets.sockets.get(id);
          return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous' };
        });

      socket.emit('existingPeers', otherClients);
    } catch (err) {
      console.error('join error', err);
    }
  });

  // Generic signaling: { to, data }
  socket.on('signal', ({ to, data } = {}) => {
    if (!data) return;
    if (to) {
      // point-to-point
      io.to(to).emit('signal', { from: socket.id, data });
    } else if (socket.room) {
      // broadcast to room (except sender)
      socket.to(socket.room).emit('signal', { from: socket.id, data });
    }
  });

  // Chat message: { room, text } -> broadcast with sender name
  socket.on('chatMessage', ({ room, text } = {}) => {
    if (!room || typeof text !== 'string') return;
    const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
    console.log(`💬 [${room}] ${socket.id} (${name}): ${text}`);
    socket.to(room).emit('chatMessage', { from: socket.id, name, text });
  });

  // Leave room (client requested)
  socket.on('leave', () => {
    if (socket.room) {
      const room = socket.room;
      const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
      socket.to(room).emit('peer-left', { id: socket.id, name });
      socket.leave(room);
      socket.room = null;
      console.log(`🚪 ${socket.id} (${name}) left room ${room}`);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', (reason) => {
    const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
    if (socket.room) {
      socket.to(socket.room).emit('peer-left', { id: socket.id, name });
    }
    console.log(`🔴 Disconnected: ${socket.id} (${name}) reason=${reason}`);
  });

  // Optional: small health debug events
  socket.on('ping-server', (cb) => {
    if (typeof cb === 'function') cb({ ok: true, ts: Date.now() });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

// server.js (no mongoose) - lightweight signaling + realtime chat (no DB)
// Supports username on join so peers know who joined
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  console.log('🟢 Socket connected:', socket.id);

  // join now expects an object: { room, name }
  socket.on('join', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.room = room;
    socket.data = socket.data || {};
    socket.data.name = name && name.trim() ? name.trim() : 'Anonymous';
    console.log(`👤 ${socket.id} (${socket.data.name}) joined room ${room}`);

    // No DB: send empty chat history so frontend can handle it
    socket.emit('chatHistory', []);

    // notify others in the room about this new peer (include name)
    socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name });

    // tell this socket about existing peers so it can initiate connections
    const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
    const otherClients = clients
      .filter(id => id !== socket.id)
      .map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous' };
      });
    socket.emit('existingPeers', otherClients);
  });

  // WebRTC signaling
  socket.on('signal', ({ to, data }) => {
    if (to) {
      io.to(to).emit('signal', { from: socket.id, data });
    } else if (socket.room) {
      socket.to(socket.room).emit('signal', { from: socket.id, data });
    }
  });

  // Chat messages (real-time only, not persisted) - include sender name
  socket.on('chatMessage', ({ room, text }) => {
    const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
    console.log(`💬 [${room}] ${socket.id} (${name}): ${text}`);
    socket.to(room).emit('chatMessage', { from: socket.id, name, text });
  });

  socket.on('leave', () => {
    if (socket.room) {
      const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
      socket.to(socket.room).emit('peer-left', { id: socket.id, name });
      socket.leave(socket.room);
      delete socket.room;
    }
  });

  socket.on('disconnect', () => {
    const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
    if (socket.room) socket.to(socket.room).emit('peer-left', { id: socket.id, name });
    console.log('🔴 Socket disconnected:', socket.id, name);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

// server.js (no mongoose) - lightweight signaling + realtime chat (no DB)
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

  socket.on('join', room => {
    socket.join(room);
    socket.room = room;
    console.log(`👤 ${socket.id} joined room ${room}`);

    // No DB: send empty chat history so frontend can handle it
    socket.emit('chatHistory', []);

    // notify others in the room about this new peer
    socket.to(room).emit('peer-joined', { id: socket.id });

    // tell this socket about existing peers so it can initiate connections
    const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
    const otherClients = clients.filter(id => id !== socket.id);
    socket.emit('existingPeers', otherClients);
  });

  // WebRTC signaling
  // data: { to?, type?, sdp?, candidate? }
  socket.on('signal', ({ to, data }) => {
    if (to) {
      io.to(to).emit('signal', { from: socket.id, data });
    } else if (socket.room) {
      // broadcast to room (used for offers from caller)
      socket.to(socket.room).emit('signal', { from: socket.id, data });
    }
  });

  // Chat messages (real-time only, not persisted)
  socket.on('chatMessage', ({ room, text }) => {
    console.log(`💬 [${room}] ${socket.id}: ${text}`);
    socket.to(room).emit('chatMessage', { from: socket.id, text });
  });

  socket.on('leave', () => {
    if (socket.room) {
      socket.to(socket.room).emit('peer-left', { id: socket.id });
      socket.leave(socket.room);
      delete socket.room;
    }
  });

  socket.on('disconnect', () => {
    if (socket.room) socket.to(socket.room).emit('peer-left', { id: socket.id });
    console.log('🔴 Socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

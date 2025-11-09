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

    // notify others in the room
    socket.to(room).emit('peer-joined', { id: socket.id });
  });

  // WebRTC signaling
  socket.on('signal', ({ to, data }) => {
    if (to) {
      io.to(to).emit('signal', { from: socket.id, data });
    } else if (socket.room) {
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
    }
  });

  socket.on('disconnect', () => {
    if (socket.room) socket.to(socket.room).emit('peer-left', { id: socket.id });
    console.log('🔴 Socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

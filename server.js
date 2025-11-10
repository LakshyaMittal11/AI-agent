// server.js (updated) - signaling + member meta (device/timezone/country-guess)
// Usage: npm init -y && npm install express socket.io && node server.js

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

// server-side room member tracker
const roomMembersMap = new Map(); // room -> Set(socketId)

// safe name sanitize
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Anonymous';
  const n = name.trim();
  if (!n) return 'Anonymous';
  if (n.length > 50) return n.slice(0, 50);
  return n;
}

// helper: return members with meta: [{ id, name, meta }]
function getRoomMembersWithMeta(room) {
  try {
    const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
    return clients.map(id => {
      const s = io.sockets.sockets.get(id);
      return {
        id,
        name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous',
        meta: (s && s.data && s.data.meta) ? s.data.meta : {}
      };
    });
  } catch (err) {
    return [];
  }
}

// emit full members structured payload
function emitRoomMembers(room) {
  const members = getRoomMembersWithMeta(room);
  const payload = { members, count: members.length, ts: Date.now() };
  io.to(room).emit('roomMembers', payload);
  // also emit lightweight meta if clients want it separately
  io.to(room).emit('roomMeta', { count: payload.count, ts: payload.ts });
  return payload;
}

// compute and emit delta between stored set and current set (include meta)
function emitRoomDelta(room) {
  const prevSet = roomMembersMap.get(room) || new Set();
  const currentClients = Array.from(io.sockets.adapter.rooms.get(room) || []);
  const currSet = new Set(currentClients);

  const joined = currentClients.filter(id => !prevSet.has(id)).map(id => {
    const s = io.sockets.sockets.get(id);
    return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous', meta: (s && s.data && s.data.meta) ? s.data.meta : {} };
  });

  const left = Array.from(prevSet).filter(id => !currSet.has(id)).map(id => {
    // once left, socket object might not exist — best-effort
    const s = io.sockets.sockets.get(id);
    return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous', meta: (s && s.data && s.data.meta) ? s.data.meta : {} };
  });

  // update map
  roomMembersMap.set(room, currSet);

  const delta = { joined, left, ts: Date.now() };
  if (joined.length || left.length) {
    io.to(room).emit('roomDelta', delta);
  }
  return delta;
}

io.on('connection', socket => {
  console.log(`🟢 Connected: ${socket.id}`);

  socket.data = socket.data || { name: 'Anonymous', room: null, meta: {} };

  // join: accept optional clientMeta
  socket.on('join', ({ room, name, clientMeta } = {}) => {
    try {
      if (!room) {
        socket.emit('error', { message: 'room required' });
        return;
      }

      const safeName = sanitizeName(name);
      socket.data.name = safeName;
      socket.data.meta = (clientMeta && typeof clientMeta === 'object') ? clientMeta : {};

      // if already in same room, send members to sync
      if (socket.data.room === room) {
        const payload = emitRoomMembers(room);
        socket.emit('existingPeers', payload.members.filter(m => m.id !== socket.id));
        return;
      }

      // join
      socket.join(room);
      socket.data.room = room;

      console.log(`👤 ${socket.id} (${socket.data.name}) joined room ${room} — meta:`, socket.data.meta);

      // send list of others
      const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
      const otherClients = clients
        .filter(id => id !== socket.id)
        .map(id => {
          const s = io.sockets.sockets.get(id);
          return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous', meta: (s && s.data && s.data.meta) ? s.data.meta : {} };
        });
      socket.emit('existingPeers', otherClients);

      // notify others
      socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name, meta: socket.data.meta });

      // ensure map exists and add
      if (!roomMembersMap.has(room)) roomMembersMap.set(room, new Set());
      roomMembersMap.get(room).add(socket.id);

      // emit diffs + full roster
      emitRoomDelta(room);
      emitRoomMembers(room);
    } catch (err) {
      console.error('join error', err);
    }
  });

  // signaling
  socket.on('signal', ({ to, data } = {}) => {
    try {
      if (!data) return;
      if (to) {
        io.to(to).emit('signal', { from: socket.id, data });
      } else if (socket.data.room) {
        socket.to(socket.data.room).emit('signal', { from: socket.id, data });
      }
    } catch (err) {
      console.warn('signal error', err);
    }
  });

  // chat
  socket.on('chatMessage', ({ room, text } = {}) => {
    try {
      if (!room || typeof text !== 'string') return;
      const name = socket.data && socket.data.name ? socket.data.name : 'Anonymous';
      socket.to(room).emit('chatMessage', { from: socket.id, name, text });
    } catch (err) {
      console.warn('chatMessage error', err);
    }
  });

  // leave
  socket.on('leave', () => {
    try {
      const room = socket.data.room;
      const name = socket.data.name || 'Anonymous';
      const meta = socket.data.meta || {};
      if (room) {
        console.log(`🚪 ${socket.id} (${name}) left room ${room}`);
        socket.to(room).emit('peer-left', { id: socket.id, name, meta });
        socket.leave(room);
        socket.data.room = null;

        // update map
        const set = roomMembersMap.get(room);
        if (set && set.has(socket.id)) {
          set.delete(socket.id);
          roomMembersMap.set(room, set);
        }

        emitRoomDelta(room);
        emitRoomMembers(room);
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
      const meta = socket.data.meta || {};
      if (room) {
        console.log(`🔴 Disconnected: ${socket.id} (${name}) reason=${reason}`);
        socket.to(room).emit('peer-left', { id: socket.id, name, meta });

        const set = roomMembersMap.get(room);
        if (set && set.has(socket.id)) {
          set.delete(socket.id);
          roomMembersMap.set(room, set);
        }

        emitRoomDelta(room);
        emitRoomMembers(room);
      } else {
        console.log(`🔴 Disconnected (no-room): ${socket.id} (${name}) reason=${reason}`);
      }

      socket.data.room = null;
      socket.data.meta = {};
    } catch (err) {
      console.warn('disconnect error', err);
    }
  });

  // health
  socket.on('ping-server', cb => {
    if (typeof cb === 'function') cb({ ok: true, ts: Date.now() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

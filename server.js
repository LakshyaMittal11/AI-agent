// server.js (fixed + safer + require-name) - signaling + member meta (device/timezone/country-guess)
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

// sanitize meta: keep only small useful fields and trim strings
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  if (typeof meta.deviceType === 'string') out.deviceType = meta.deviceType.slice(0, 20);
  if (typeof meta.language === 'string') out.language = meta.language.slice(0, 20);
  if (typeof meta.timezone === 'string') out.timezone = meta.timezone.slice(0, 50);
  if (typeof meta.countryGuess === 'string') out.countryGuess = meta.countryGuess.slice(0, 20);
  // avoid huge userAgent strings; keep only prefix if present
  if (typeof meta.userAgent === 'string') out.userAgent = meta.userAgent.slice(0, 120);
  out._sanitizedAt = Date.now();
  return out;
}

// helper: safe getter for room client IDs (returns array)
function getRoomClientIds(room) {
  try {
    const s = io.sockets.adapter.rooms.get(room);
    if (!s) return [];
    return Array.from(s);
  } catch (err) {
    return [];
  }
}

// helper: return members with meta: [{ id, name, meta }]
function getRoomMembersWithMeta(room) {
  try {
    const clients = getRoomClientIds(room);
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
  // lightweight meta
  io.to(room).emit('roomMeta', { count: payload.count, ts: payload.ts });
  return payload;
}

// compute and emit delta between stored set and current set (include meta)
function emitRoomDelta(room) {
  const prevSet = roomMembersMap.get(room) || new Set();
  const currentClients = getRoomClientIds(room);
  const currSet = new Set(currentClients);

  const joined = currentClients.filter(id => !prevSet.has(id)).map(id => {
    const s = io.sockets.sockets.get(id);
    return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous', meta: (s && s.data && s.data.meta) ? s.data.meta : {} };
  });

  const left = Array.from(prevSet).filter(id => !currSet.has(id)).map(id => {
    // socket may be gone; best-effort name/meta from last-known (we don't store historical meta separately)
    const s = io.sockets.sockets.get(id);
    return { id, name: (s && s.data && s.data.name) ? s.data.name : 'Anonymous', meta: (s && s.data && s.data.meta) ? s.data.meta : {} };
  });

  // update map (if empty, delete)
  if (currSet.size === 0) {
    roomMembersMap.delete(room);
  } else {
    roomMembersMap.set(room, currSet);
  }

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
      // === require name check (server-side enforcement) ===
      const trimmedName = (typeof name === 'string') ? name.trim() : '';
      if (!trimmedName) {
        // ask client to provide a name before joining
        socket.emit('require-name', { message: 'Name required to join the room' });
        return;
      }

      if (!room) {
        socket.emit('error', { message: 'room required' });
        return;
      }

      const safeName = sanitizeName(trimmedName);
      socket.data.name = safeName;
      socket.data.meta = sanitizeMeta(clientMeta);

      // if already in same room, send members to sync
      if (socket.data.room === room) {
        const members = getRoomMembersWithMeta(room).filter(m => m.id !== socket.id);
        socket.emit('existingPeers', members);
        return;
      }

      // if previously in another room, leave it first (clean up map + notify)
      if (socket.data.room && socket.data.room !== room) {
        const prevRoom = socket.data.room;
        socket.to(prevRoom).emit('peer-left', { id: socket.id, name: socket.data.name, meta: socket.data.meta });
        socket.leave(prevRoom);
        const prevSet = roomMembersMap.get(prevRoom);
        if (prevSet && prevSet.has(socket.id)) {
          prevSet.delete(socket.id);
          if (prevSet.size === 0) roomMembersMap.delete(prevRoom);
          else roomMembersMap.set(prevRoom, prevSet);
        }
        emitRoomDelta(prevRoom);
        emitRoomMembers(prevRoom);
      }

      // join new room
      socket.join(room);
      socket.data.room = room;

      console.log(`👤 ${socket.id} (${socket.data.name}) joined room ${room} — meta:`, socket.data.meta);

      // send list of others
      const clients = getRoomClientIds(room);
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
      // emit to room excluding sender
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
          if (set.size === 0) roomMembersMap.delete(room);
          else roomMembersMap.set(room, set);
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
          if (set.size === 0) roomMembersMap.delete(room);
          else roomMembersMap.set(room, set);
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
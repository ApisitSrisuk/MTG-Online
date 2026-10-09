'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');
const { parseDecklist, resolveDeck } = require('./scryfall');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const channel = (room, pid) => `${room.id}:${pid}`;

function broadcast(room) {
  for (const pid of room.order) io.to(channel(room, pid)).emit('state', room.viewFor(pid));
}

io.on('connection', (socket) => {
  let ctx = null; // { room, pid }

  const handle = (fn) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, data: await fn(payload || {}) });
    } catch (err) {
      reply({ ok: false, error: err.message, rule: Boolean(err.rule) });
    }
  };

  const requireRoom = () => {
    if (!ctx) throw new Error('ยังไม่ได้เข้าห้อง');
    return ctx;
  };

  const leave = () => {
    if (!ctx) return;
    const { room, pid } = ctx;
    socket.leave(channel(room, pid));
    ctx = null;
    // Another tab of the same player may still be connected.
    if (!io.sockets.adapter.rooms.get(channel(room, pid))?.size) {
      room.disconnect(pid);
      broadcast(room);
    }
  };

  socket.on('join', handle(({ roomId, playerId, name }) => {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(playerId))) throw new Error('playerId ไม่ถูกต้อง');
    const code = String(roomId || '').trim().toUpperCase();
    if (code && !/^[A-Z0-9]{4,8}$/.test(code)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const displayName = String(name || '').trim().slice(0, 24) || 'ผู้เล่น';

    // An unknown code (e.g. after a server restart) recreates that room so players can rejoin it.
    let room = code ? rooms.get(code) : null;
    if (!room) {
      room = new Room(code || newRoomCode());
      rooms.set(room.id, room);
    }
    if (ctx && (ctx.room !== room || ctx.pid !== playerId)) leave();
    room.join(playerId, displayName);
    ctx = { room, pid: playerId };
    socket.join(channel(room, playerId));
    broadcast(room);
    return { roomId: room.id };
  }));

  socket.on('deck', handle(async ({ text }) => {
    const { room, pid } = requireRoom();
    const entries = parseDecklist(text);
    if (!entries.length) throw new Error('ไม่พบรายการการ์ดใน decklist');
    const { cards, notFound } = await resolveDeck(entries);
    if (!cards.some((c) => c.section === 'main')) throw new Error('ไม่พบการ์ดใน main deck เลย');
    room.setDeck(pid, cards);
    broadcast(room);
    return { count: cards.length, notFound };
  }));

  socket.on('act', handle((action) => {
    const { room, pid } = requireRoom();
    const data = room.act(pid, action);
    // A silent peek changes nothing anyone else can see.
    if (!(action.type === 'peek' && action.silent)) broadcast(room);
    return data;
  }));

  socket.on('disconnect', leave);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.anyoneConnected && now - room.lastActive > ROOM_TTL_MS) rooms.delete(id);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`MTG Online พร้อมแล้วที่ http://localhost:${PORT}`);
});

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const ROUND_TIME_SEC = 80;
const BETWEEN_ROUNDS_SEC = 6;
const MIN_PLAYERS_TO_START = 2;

const WORDS_ES = [
  "arepa","perro","gato","carro","casa","avión","banana","pizza","playa","montaña",
  "teléfono","computadora","fútbol","guitarra","árbol","flor","barco","llave","sombrero",
  "zapato","reloj","helado","tiburón","vampiro","pirata","dragón","café","cebolla",
  "camisa","bicicleta","semáforo","pájaro","nube","estrella","luna","sol","camión","robot"
];

function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function maskWord(word) { return word.replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "_"); }
function nowMs() { return Date.now(); }

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(), // socketId -> {id,name,score,guessedThisRound}
      order: [],
      hostId: null,
      state: "lobby", // lobby|between|playing
      drawerId: null,
      word: null,
      roundEndsAt: null,
      timerInterval: null
    });
  }
  return rooms.get(roomId);
}

function snapshot(roomId) {
  const room = getRoom(roomId);
  const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score }));
  return {
    roomId,
    hostId: room.hostId,
    state: room.state,
    drawerId: room.drawerId,
    maskedWord: room.word ? maskWord(room.word) : null,
    players,
    roundEndsAt: room.roundEndsAt
  };
}

function emitRoom(roomId) {
  io.to(roomId).emit("room:update", snapshot(roomId));
}

function cleanupRoomIfEmpty(roomId) {
  const room = getRoom(roomId);
  if (room.players.size === 0) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    rooms.delete(roomId);
  }
}

function nextDrawer(room) {
  if (room.order.length === 0) return null;
  if (!room.drawerId) return room.order[0];
  const idx = room.order.indexOf(room.drawerId);
  const nextIdx = (idx + 1) % room.order.length;
  return room.order[nextIdx];
}

function resetGuessed(room) {
  for (const p of room.players.values()) p.guessedThisRound = false;
}

function remainingSeconds(room) {
  return Math.max(0, Math.ceil((room.roundEndsAt - nowMs()) / 1000));
}

function scoreForGuess(remSec) {
  return 50 + Math.floor((remSec / ROUND_TIME_SEC) * 100);
}
function scoreForDrawer(numCorrect) {
  return numCorrect * 30;
}

function startBetween(roomId) {
  const room = getRoom(roomId);
  room.state = "between";
  room.word = null;
  room.roundEndsAt = nowMs() + BETWEEN_ROUNDS_SEC * 1000;

  io.to(roomId).emit("system:message", { text: "⏳ Preparando la siguiente ronda..." });
  emitRoom(roomId);

  setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.players.size < MIN_PLAYERS_TO_START) {
      r.state = "lobby";
      r.drawerId = null;
      r.word = null;
      r.roundEndsAt = null;
      io.to(roomId).emit("system:message", { text: "🧩 Esperando más jugadores para empezar." });
      emitRoom(roomId);
      return;
    }
    startRound(roomId);
  }, BETWEEN_ROUNDS_SEC * 1000);
}

function startRound(roomId) {
  const room = getRoom(roomId);
  room.state = "playing";
  resetGuessed(room);

  room.drawerId = nextDrawer(room);
  room.word = randChoice(WORDS_ES);
  room.roundEndsAt = nowMs() + ROUND_TIME_SEC * 1000;

  io.to(roomId).emit("canvas:clear");
  io.to(roomId).emit("system:message", { text: "🖍️ ¡Nueva ronda!" });

  io.to(room.drawerId).emit("word:secret", { word: room.word });
  io.to(roomId).emit("word:masked", { masked: maskWord(room.word) });

  emitRoom(roomId);

  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r) return;

    const remaining = remainingSeconds(r);
    io.to(roomId).emit("timer", { remaining });

    if (remaining <= 0) {
      clearInterval(r.timerInterval);
      r.timerInterval = null;
      io.to(roomId).emit("system:message", { text: `⌛ Se acabó el tiempo. La palabra era: **${r.word}**` });
      startBetween(roomId);
    }
  }, 1000);
}

function tryAutoStart(roomId) {
  const room = getRoom(roomId);
  if (room.players.size >= MIN_PLAYERS_TO_START && room.state === "lobby") {
    startBetween(roomId);
  }
}

io.on("connection", (socket) => {
  socket.on("room:join", ({ roomId, name }) => {
    roomId = (roomId || "").trim().slice(0, 24) || "public";
    name = (name || "Jugador").trim().slice(0, 18) || "Jugador";

    const room = getRoom(roomId);
    socket.join(roomId);

    room.players.set(socket.id, { id: socket.id, name, score: 0, guessedThisRound: false });
    room.order = room.order.filter(id => id !== socket.id);
    room.order.push(socket.id);

    if (!room.hostId) room.hostId = socket.id;
    socket.data.roomId = roomId;

    io.to(roomId).emit("system:message", { text: `✅ ${name} se unió a la sala.` });
    emitRoom(roomId);

    // Si ya está jugando, sincroniza info al nuevo
    if (room.state === "playing" && room.word) {
      socket.emit("word:masked", { masked: maskWord(room.word) });
      socket.emit("timer", { remaining: remainingSeconds(room) });
      if (room.drawerId === socket.id) socket.emit("word:secret", { word: room.word });
    }

    tryAutoStart(roomId);
  });

  socket.on("room:start", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (socket.id !== room.hostId) return;
    if (room.players.size < MIN_PLAYERS_TO_START) {
      socket.emit("system:message", { text: "⚠️ Necesitas al menos 2 jugadores." });
      return;
    }
    if (room.state === "lobby") startBetween(roomId);
  });

  socket.on("chat:send", ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const player = room.players.get(socket.id);
    if (!player) return;

    text = (text || "").toString().trim();
    if (!text) return;
    if (text.length > 120) text = text.slice(0, 120);

    // Adivinar (solo si no es dibujante)
    if (room.state === "playing" && room.word && socket.id !== room.drawerId) {
      const normalized = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
      const target = room.word.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

      if (!player.guessedThisRound && normalized === target) {
        player.guessedThisRound = true;

        const rem = remainingSeconds(room);
        const pts = scoreForGuess(rem);
        player.score += pts;

        io.to(roomId).emit("system:message", { text: `🎉 ${player.name} adivinó la palabra (+${pts}).` });
        emitRoom(roomId);

        const guessers = [...room.players.values()].filter(p => p.id !== room.drawerId && p.guessedThisRound);
        const totalNeeded = Math.max(0, room.players.size - 1);

        if (guessers.length >= totalNeeded) {
          const drawer = room.players.get(room.drawerId);
          if (drawer) {
            const dPts = scoreForDrawer(guessers.length);
            drawer.score += dPts;
            io.to(roomId).emit("system:message", { text: `🏅 ${drawer.name} (dibujante) gana +${dPts}.` });
          }

          if (room.timerInterval) clearInterval(room.timerInterval);
          room.timerInterval = null;

          io.to(roomId).emit("system:message", { text: `✅ Todos adivinaron. La palabra era: **${room.word}**` });
          startBetween(roomId);
        }
        return;
      }
    }

    // Chat normal
    io.to(roomId).emit("chat:message", { from: player.name, text });
  });

  socket.on("draw:stroke", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.state !== "playing") return;
    if (socket.id !== room.drawerId) return;

    socket.to(roomId).emit("draw:stroke", payload);
  });

  socket.on("canvas:clear", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.state !== "playing") return;
    if (socket.id !== room.drawerId) return;
    io.to(roomId).emit("canvas:clear");
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const leaving = room.players.get(socket.id);
    room.players.delete(socket.id);
    room.order = room.order.filter(id => id !== socket.id);

    if (leaving) io.to(roomId).emit("system:message", { text: `👋 ${leaving.name} salió.` });

    if (room.hostId === socket.id) {
      room.hostId = room.order[0] || null;
      if (room.hostId) io.to(roomId).emit("system:message", { text: "👑 Nuevo host asignado." });
    }

    if (room.state === "playing" && room.drawerId === socket.id) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.timerInterval = null;
      io.to(roomId).emit("system:message", { text: "⚠️ El dibujante salió. Saltando ronda..." });
      startBetween(roomId);
    }

    emitRoom(roomId);
    cleanupRoomIfEmpty(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

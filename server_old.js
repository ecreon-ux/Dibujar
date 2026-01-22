import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;
const WORDS = ["perro","gato","arepa","pizza","avión","auto","casa","árbol","fútbol","robot"];

let rooms = {};

function mask(word){
  return word.replace(/[a-záéíóúñ]/gi,"_");
}

io.on("connection", socket => {

  socket.on("join", ({room,name})=>{
    socket.join(room);
    socket.room = room;
    socket.name = name;

    if(!rooms[room]){
      rooms[room] = {
        players:[],
        drawer:0,
        word:null
      };
    }

    rooms[room].players.push(socket.id);
    io.to(room).emit("msg", `${name} se unió`);
    startRound(room);
  });

  socket.on("draw", data=>{
    socket.to(socket.room).emit("draw", data);
  });

  socket.on("guess", text=>{
    let room = rooms[socket.room];
    if(!room || !room.word) return;

    if(text.toLowerCase() === room.word){
      io.to(socket.room).emit("msg", `🎉 ${socket.name} adivinó: ${room.word}`);
      startRound(socket.room);
    } else {
      socket.to(socket.room).emit("chat", {name:socket.name,text});
    }
  });

  socket.on("disconnect", ()=>{
    let room = rooms[socket.room];
    if(!room) return;
    room.players = room.players.filter(id=>id!==socket.id);
  });

});

function startRound(room){
  let r = rooms[room];
  if(!r || r.players.length < 1) return;

  r.drawer = (r.drawer + 1) % r.players.length;
  r.word = WORDS[Math.floor(Math.random()*WORDS.length)];

  let drawerId = r.players[r.drawer];
  io.to(room).emit("clear");
  io.to(drawerId).emit("word", r.word);
  io.to(room).emit("masked", mask(r.word));
}

server.listen(PORT, ()=> {
  console.log("Servidor listo en http://localhost:3000");
});

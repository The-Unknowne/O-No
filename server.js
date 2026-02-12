const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const waitingPlayers = [];

/* ================= GAME ROOM ================= */
class GameRoom {
  constructor(roomId, p1, p2) {
    this.roomId = roomId;
    this.players = [
      { id: p1.id, name: p1.name, hand: [], calledUno: false },
      { id: p2.id, name: p2.name, hand: [], calledUno: false }
    ];
    this.deck = [];
    this.discardPile = [];
    this.currentPlayer = 0;
    this.currentColor = null;
    this.currentValue = null;
    this.direction = 1;
    this.stackedDrawCount = 0;
    this.settings = {
      allowStacking: false,
      allowSpecial07: false
    };
    this.gameStarted = false;
  }

  createDeck() {
    const COLORS = ["red", "blue", "green", "yellow"];
    const NUMBERS = ["0","1","2","3","4","5","6","7","8","9"];
    const ACTIONS = ["Skip", "Reverse", "+2"];

    this.deck = [];

    COLORS.forEach(color => {
      this.deck.push({ color, value: "0", type: "number" });
      for (let i = 0; i < 2; i++) {
        NUMBERS.slice(1).forEach(v => this.deck.push({ color, value: v, type: "number" }));
        ACTIONS.forEach(v => this.deck.push({ color, value: v, type: "action" }));
      }
    });

    for (let i = 0; i < 4; i++) {
      this.deck.push({ color: "wild", value: "Wild", type: "wild" });
      this.deck.push({ color: "wild", value: "Wild+4", type: "wild" });
    }

    this.shuffle();
  }

  shuffle() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  dealCards(count = 7) {
    this.players.forEach(p => {
      p.hand = [];
      for (let i = 0; i < count; i++) p.hand.push(this.deck.pop());
    });

    let start;
    do start = this.deck.pop();
    while (start.type !== "number");

    this.discardPile = [start];
    this.currentColor = start.color;
    this.currentValue = start.value;
  }

  stateFor(playerId) {
    const me = this.players.findIndex(p => p.id === playerId);
    const opp = me === 0 ? 1 : 0;

    return {
      roomId: this.roomId,
      yourHand: this.players[me].hand,
      opponentName: this.players[opp].name,
      opponentCardCount: this.players[opp].hand.length,
      topCard: this.discardPile.at(-1),
      currentColor: this.currentColor,
      currentPlayer: this.currentPlayer,
      isYourTurn: this.currentPlayer === me,
      deckCount: this.deck.length
    };
  }
}

/* ================= SOCKETS ================= */
io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("findGame", name => {
    if (waitingPlayers.length) {
      const opp = waitingPlayers.shift();
      const roomId = "room_" + Date.now();

      const room = new GameRoom(roomId, opp, { id: socket.id, name });
      rooms.set(roomId, room);

      socket.join(roomId);
      opp.socket.join(roomId);

      socket.emit("gameFound", { roomId, opponent: opp.name });
      opp.socket.emit("gameFound", { roomId, opponent: name });
    } else {
      waitingPlayers.push({ id: socket.id, name, socket });
      socket.emit("waiting");
    }
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameStarted) return;

    room.createDeck();
    room.dealCards();
    room.gameStarted = true;

    room.players.forEach(p => {
      io.to(p.id).emit("gameStarted", room.stateFor(p.id));
    });
  });

  socket.on("playCard", ({ roomId, index, color }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const pIndex = room.players.findIndex(p => p.id === socket.id);
    if (room.currentPlayer !== pIndex) return;

    const card = room.players[pIndex].hand[index];
    if (!card) return;

    const valid =
      card.color === room.currentColor ||
      card.value === room.currentValue ||
      card.type === "wild";

    if (!valid) return;

    room.players[pIndex].hand.splice(index, 1);
    room.discardPile.push(card);

    room.currentColor = card.type === "wild" ? color : card.color;
    room.currentValue = card.value;

    handleEffect(room, card, pIndex);
    broadcast(room);
  });

  socket.on("drawCard", ({ roomId }) => {
    const room = rooms.get(roomId);
    const p = room.players.findIndex(p => p.id === socket.id);
    if (room.currentPlayer !== p) return;

    room.players[p].hand.push(room.deck.pop());
    room.currentPlayer = p === 0 ? 1 : 0;
    broadcast(room);
  });

  socket.on("disconnect", () => {
    waitingPlayers.splice(waitingPlayers.findIndex(p => p.id === socket.id), 1);
    rooms.forEach((room, id) => {
      if (room.players.some(p => p.id === socket.id)) {
        io.to(id).emit("opponentDisconnected");
        rooms.delete(id);
      }
    });
  });
});

/* ================= HELPERS ================= */
function handleEffect(room, card, p) {
  const o = p === 0 ? 1 : 0;
  if (card.value === "Skip" || card.value === "Reverse") return;
  if (card.value === "+2") room.players[o].hand.push(room.deck.pop(), room.deck.pop());
  if (card.value === "Wild+4")
    room.players[o].hand.push(...Array(4).fill().map(() => room.deck.pop()));
  room.currentPlayer = o;
}

function broadcast(room) {
  room.players.forEach(p => {
    io.to(p.id).emit("gameState", room.stateFor(p.id));
  });
}

server.listen(PORT, () =>
  console.log(`✅ O,No server running on port ${PORT}`)
);

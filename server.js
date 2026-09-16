const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 10000);
const app = express();

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "50mb" }));

// 1. Protection : AUCUN site web, AUCUN dashboard affiché
// Si un visiteur ouvre l'adresse dans un navigateur, il reçoit un 404 neutre
app.get("/", (_req, res) => {
  res.status(404).send("Not Found");
});

// Endpoint de santé pour le maintien en éveil (cron-job.org / UptimeRobot)
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "aurora-messenger-relay", timestamp: Date.now() });
});

// Mémoire tampon circulaire des derniers messages en cas de coupure (jusqu'à 300 messages)
const messageStore = new Map(); // threadId -> Array<Message>
const uploadStore = new Map();  // fileId -> { data, mime, name }

function saveMessage(msg) {
  if (!msg || !msg.threadId) return;
  const list = messageStore.get(msg.threadId) || [];
  list.push(msg);
  if (list.length > 300) list.shift();
  messageStore.set(msg.threadId, list);
}

// Routes REST de secours pour le chat
app.get("/api/chat/threads/:id/messages", (req, res) => {
  const list = messageStore.get(req.params.id) || [];
  res.json({ success: true, messages: list });
});

app.post("/api/chat/messages", (req, res) => {
  const msg = req.body;
  if (!msg || !msg.id) return res.status(400).json({ error: "Message invalide" });
  saveMessage(msg);
  io.emit("chat:message", msg);
  res.json({ success: true, message: msg });
});

// Upload léger de photos / notes vocales en secours
app.post("/api/chat/upload", (req, res) => {
  const { data, filename, mimeType } = req.body || {};
  if (!data) return res.status(400).json({ error: "Aucun fichier reçu" });
  const id = "up_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  uploadStore.set(id, { data, filename: filename || "fichier", mimeType: mimeType || "application/octet-stream" });
  res.json({ success: true, url: `/api/chat/uploads/${id}`, id });
});

app.get("/api/chat/uploads/:id", (req, res) => {
  const file = uploadStore.get(req.params.id);
  if (!file) return res.status(404).send("Fichier introuvable");
  res.setHeader("Content-Type", file.mimeType);
  if (file.data.startsWith("data:")) {
    const base64Data = file.data.split(",")[1];
    return res.send(Buffer.from(base64Data, "base64"));
  }
  res.send(Buffer.from(file.data, "base64"));
});

// Tout autre chemin renvoie 404
app.use((_req, res) => res.status(404).send("Not Found"));

const server = http.createServer(app);

// 2. Serveur Socket.IO pour le temps réel et l'interphone d'urgence
const io = new Server(server, {
  cors: { origin: "*" },
  path: "/call", // Compatible avec chatClient.ts et callClient.ts
  transports: ["polling", "websocket"],
});

const onlineUsers = new Map(); // socketId -> { userId, userName }

io.on("connection", (socket) => {
  // Identification utilisateur
  socket.on("chat:identify", (user) => {
    if (!user || !user.userId) return;
    onlineUsers.set(socket.id, { userId: user.userId, userName: user.userName || "Proche" });
    io.emit("chat:presence", {
      userId: user.userId,
      status: "online",
      onlineUsers: Array.from(onlineUsers.values()),
    });
  });

  // Relais des messages instantanés
  socket.on("chat:message", (msg) => {
    saveMessage(msg);
    socket.broadcast.emit("chat:message", msg);
  });

  // Relais de la saisie en cours (typing indicator)
  socket.on("chat:typing", (evt) => {
    socket.broadcast.emit("chat:typing", evt);
  });

  socket.on("chat:stop-typing", (evt) => {
    socket.broadcast.emit("chat:stop-typing", evt);
  });

  // Relais des accusés de lecture / réception
  socket.on("chat:read", (evt) => {
    socket.broadcast.emit("chat:read", evt);
  });

  socket.on("chat:delivered", (evt) => {
    socket.broadcast.emit("chat:delivered", evt);
  });

  // Relais des réactions (emojis)
  socket.on("chat:reaction", (evt) => {
    socket.broadcast.emit("chat:reaction", evt);
  });

  // Signalisation d'appels / interphone WebRTC de secours
  socket.on("join", (data) => socket.broadcast.emit("peer-joined", { sid: socket.id, ...data }));
  socket.on("offer", (data) => socket.broadcast.emit("offer", data));
  socket.on("answer", (data) => socket.broadcast.emit("answer", data));
  socket.on("ice-candidate", (data) => socket.broadcast.emit("ice-candidate", data));
  socket.on("hangup", (data) => socket.broadcast.emit("hangup", data));

  socket.on("disconnect", () => {
    const user = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (user) {
      io.emit("chat:presence", {
        userId: user.userId,
        status: "offline",
        onlineUsers: Array.from(onlineUsers.values()),
      });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[aurora-relay] Passerelle Messenger de secours écoute sur le port ${PORT}`);
});

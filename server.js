const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 8000);
const app = express();

// CORS permissif pour toutes les requêtes directes et mobiles
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "50mb" }));

// 1. Protection : AUCUN site web, AUCUN dashboard public affiché
app.get("/", (_req, res) => {
  res.status(404).send("Not Found");
});

// Endpoint de santé pour le maintien en éveil (cron-job.org / UptimeRobot)
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "aurora-messenger-relay",
    version: "2.1-reactions-read-sync",
    timestamp: Date.now(),
    onlineUsersCount: onlineUsers.size,
  });
});

// Mémoire tampon circulaire des derniers messages en cas de coupure (jusqu'à 500 messages par thread)
const messageStore = new Map(); // threadId -> Array<Message>
const uploadStore = new Map();  // fileId -> { data, mime, name }
const threadStore = new Map();  // threadId -> Thread

// Utilisateurs pré-configurés et dynamiquement découverts
const registeredUsers = new Map([
  ["user-admin-01", { id: "user-admin-01", name: "Administrateur", role: "admin", avatarColor: "#fbbf24" }],
  ["user-family-02", { id: "user-family-02", name: "Famille", role: "family", avatarColor: "#34d399" }],
  ["user-guest-03", { id: "user-guest-03", name: "Invité", role: "guest", avatarColor: "#fbbf24" }],
  ["user-1788377270406-i26g", { id: "user-1788377270406-i26g", name: "Nadia", role: "family", avatarColor: "#fbbf24" }],
]);

// Fil général par défaut
threadStore.set("family-general", {
  id: "family-general",
  type: "group",
  name: "Famille",
  participants: ["Tous"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
  quickEmoji: "👍",
  chatTheme: "ocean",
});

function saveMessage(msg) {
  if (!msg || !msg.threadId) return;
  const list = messageStore.get(msg.threadId) || [];
  // Éviter les doublons
  const existingIdx = list.findIndex((m) => m.id === msg.id);
  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...msg };
  } else {
    list.push(msg);
    if (list.length > 500) list.shift();
  }
  messageStore.set(msg.threadId, list);

  // Mettre à jour le dernier message du thread
  const thread = threadStore.get(msg.threadId) || {
    id: msg.threadId,
    type: "direct",
    name: msg.senderName || "Conversation",
    participants: [msg.senderId],
    createdAt: new Date().toISOString(),
  };
  thread.lastMessage = msg;
  thread.updatedAt = msg.timestamp || new Date().toISOString();
  threadStore.set(msg.threadId, thread);
}

// ── Routes REST de secours pour le chat ──

// Récupération des contacts et de leur présence réelle en direct
app.get("/api/chat/contacts", (_req, res) => {
  const onlineList = Array.from(onlineUsers.values());
  const onlineUserIds = new Set(onlineList.map((u) => String(u.userId).toLowerCase().trim()));
  const onlineUserNames = new Set(onlineList.map((u) => String(u.userName).toLowerCase().trim()));

  const contacts = Array.from(registeredUsers.values()).map((u) => {
    const isOnline =
      onlineUserIds.has(String(u.id).toLowerCase().trim()) ||
      onlineUserNames.has(String(u.name).toLowerCase().trim());
    return {
      id: u.id,
      name: u.name,
      role: u.role || "family",
      avatarColor: u.avatarColor || "#3b82f6",
      avatarUrl: u.avatarUrl || "",
      online: isOnline,
    };
  });

  // Ajouter les utilisateurs connectés non encore listés
  for (const connected of onlineList) {
    if (
      connected.userId &&
      !contacts.some(
        (c) =>
          c.id.toLowerCase() === connected.userId.toLowerCase() ||
          c.name.toLowerCase() === connected.userName.toLowerCase()
      )
    ) {
      contacts.push({
        id: connected.userId,
        name: connected.userName,
        role: connected.role || "family",
        avatarColor: "#3b82f6",
        avatarUrl: connected.avatarUrl || "",
        online: true,
      });
    }
  }

  res.json({ contacts });
});

// Récupération des conversations (threads)
app.get("/api/chat/threads", (req, res) => {
  const reqUserId = String(req.query.userId || "").toLowerCase().trim();
  const reqUserName = String(req.query.userName || "").toLowerCase().trim();

  let threads = Array.from(threadStore.values());
  if (reqUserId || reqUserName) {
    threads = threads.filter((t) => {
      if (t.type === "group" || t.id === "family-general") return true;
      if (!t.participants || t.participants.length === 0) return true;
      return t.participants.some((p) => {
        const pl = String(p).toLowerCase().trim();
        return pl === reqUserId || pl === reqUserName;
      });
    });
  }

  res.json({ threads });
});

// Synchronisation complète depuis le serveur local Aurora
app.post("/api/chat/sync", (req, res) => {
  const { threads, messages, users } = req.body || {};
  let syncedThreads = 0;
  let syncedMessages = 0;

  if (Array.isArray(threads)) {
    threads.forEach((t) => {
      if (t && t.id) {
        const existing = threadStore.get(t.id);
        threadStore.set(t.id, { ...existing, ...t });
        syncedThreads++;
      }
    });
  }

  if (Array.isArray(messages)) {
    messages.forEach((m) => {
      if (m && m.id && m.threadId) {
        saveMessage(m);
        syncedMessages++;
      }
    });
  }

  if (Array.isArray(users)) {
    users.forEach((u) => {
      if (u && u.id) {
        registeredUsers.set(u.id, {
          id: u.id,
          name: u.name || "Utilisateur",
          role: u.role || "family",
          avatarUrl: u.avatarUrl || "",
        });
      }
    });
  }

  res.json({ success: true, syncedThreads, syncedMessages });
});

// Création / mise à jour de thread avec détection stricte des conversations directes existantes
app.post("/api/chat/threads", (req, res) => {
  const payload = req.body || {};
  const { type, creatorId, creatorName, targetUserId, targetUserName, name, participants } = payload;

  if (type === "direct") {
    const userA_keys = new Set();
    if (creatorId) userA_keys.add(String(creatorId).toLowerCase().trim());
    if (creatorName) userA_keys.add(String(creatorName).toLowerCase().trim());

    const userB_keys = new Set();
    if (targetUserId) userB_keys.add(String(targetUserId).toLowerCase().trim());
    if (targetUserName) userB_keys.add(String(targetUserName).toLowerCase().trim());
    if (name) userB_keys.add(String(name).toLowerCase().trim());

    if (Array.isArray(participants) && participants.length >= 2) {
      if (participants[0]) userA_keys.add(String(participants[0]).toLowerCase().trim());
      if (participants[2]) userA_keys.add(String(participants[2]).toLowerCase().trim());
      if (participants[1]) userB_keys.add(String(participants[1]).toLowerCase().trim());
      if (participants[3]) userB_keys.add(String(participants[3]).toLowerCase().trim());
    }

    userA_keys.delete("");
    userB_keys.delete("");

    // Vérifier si un fil direct existe déjà pour ces deux correspondants
    for (const t of threadStore.values()) {
      if (t.type !== "direct" || t.id === "direct-aurora") continue;
      const tParts = (t.participants || []).map((p) => String(p).toLowerCase().trim());
      const hasA = Array.from(userA_keys).some((k) => tParts.includes(k));
      const hasB = Array.from(userB_keys).some((k) => tParts.includes(k));
      if (hasA && hasB) {
        return res.json({ success: true, thread: t });
      }
    }
  }

  const id = payload.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const thread = {
    ...payload,
    id,
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  threadStore.set(id, thread);
  broadcastAll("chat:thread-new", thread);
  res.json({ success: true, thread });
});

app.put("/api/chat/threads/:id", (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  const existing = threadStore.get(id) || { id, createdAt: new Date().toISOString() };
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  threadStore.set(id, updated);
  broadcastAll("chat:thread-update", updated);
  res.json({ success: true, thread: updated });
});

app.delete("/api/chat/threads/:id", (req, res) => {
  const id = req.params.id;
  threadStore.delete(id);
  messageStore.delete(id);
  broadcastAll("chat:thread-deleted", { threadId: id });
  res.json({ success: true });
});

// Messages d'un fil de discussion
app.get("/api/chat/threads/:id/messages", (req, res) => {
  const list = messageStore.get(req.params.id) || [];
  res.json({ success: true, messages: list });
});

// Effacer les messages d'un fil
app.delete("/api/chat/threads/:id/messages", (req, res) => {
  const id = req.params.id;
  messageStore.set(id, []);
  broadcastAll("chat:thread-cleared", { threadId: id });
  res.json({ success: true });
});

// Envoi d'un message (génère un ID si non fourni pour accepter tout type d'émetteur)
app.post("/api/chat/messages", (req, res) => {
  const msg = req.body;
  if (!msg || !msg.threadId) {
    return res.status(400).json({ error: "Message invalide : threadId requis" });
  }

  // Garantir un ID unique et un timestamp
  if (!msg.id) {
    msg.id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }
  if (!msg.timestamp) {
    msg.timestamp = new Date().toISOString();
  }
  if (!msg.reactions) {
    msg.reactions = [];
  }
  msg.status = "sent";

  const list = messageStore.get(msg.threadId) || [];
  const isDuplicate = list.some((m) => m.id === msg.id);

  saveMessage(msg);

  if (!isDuplicate) {
    broadcastAll("chat:message", msg);
  }

  res.json({ success: true, message: msg });
});

// Réactions emojis sur un message
app.post("/api/chat/messages/:id/react", (req, res) => {
  const messageId = req.params.id;
  const { emoji, userId, userName, threadId: reqThreadId } = req.body || {};
  if (!emoji || !userId) return res.status(400).json({ error: "Données de réaction manquantes" });

  let foundMsg = null;
  for (const list of messageStore.values()) {
    const m = list.find((item) => item.id === messageId);
    if (m) {
      foundMsg = m;
      break;
    }
  }

  const threadId = reqThreadId || foundMsg?.threadId || "family-general";

  if (!foundMsg) {
    // Si le message n'est pas encore en mémoire dans le relais (ex: redémarrage instance ou message créé avant bascule),
    // on ne renvoie pas 404 : on initialise la réaction et on la diffuse en direct !
    foundMsg = {
      id: messageId,
      threadId,
      reactions: [{ emoji, userId, userName: userName || "Proche" }],
      timestamp: new Date().toISOString(),
      status: "sent",
    };
    saveMessage(foundMsg);
  } else {
    if (!Array.isArray(foundMsg.reactions)) {
      foundMsg.reactions = [];
    }

    const existingIdx = foundMsg.reactions.findIndex(
      (r) => r.userId === userId && r.emoji === emoji
    );
    if (existingIdx >= 0) {
      foundMsg.reactions.splice(existingIdx, 1);
    } else {
      foundMsg.reactions.push({ emoji, userId, userName: userName || "Proche" });
    }
  }

  broadcastAll("chat:reaction", {
    messageId,
    reactions: foundMsg.reactions,
    threadId: foundMsg.threadId || threadId,
  });

  res.json({ success: true, reactions: foundMsg.reactions });
});

// Modification de message (edit)
app.put("/api/chat/messages/:id", (req, res) => {
  const messageId = req.params.id;
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "Texte requis" });

  let foundMsg = null;
  for (const list of messageStore.values()) {
    const m = list.find((item) => item.id === messageId);
    if (m) {
      foundMsg = m;
      break;
    }
  }

  if (!foundMsg) {
    return res.status(404).json({ error: "Message non trouvé" });
  }

  foundMsg.text = text;
  foundMsg.edited = true;
  foundMsg.editedAt = new Date().toISOString();

  broadcastAll("chat:message-updated", foundMsg);
  res.json({ success: true, message: foundMsg });
});

// Suppression de message
app.delete("/api/chat/messages/:id", (req, res) => {
  const messageId = req.params.id;
  let deleted = false;
  let threadId = "";

  for (const [tId, list] of messageStore.entries()) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      list.splice(idx, 1);
      deleted = true;
      threadId = tId;
      break;
    }
  }

  if (deleted) {
    broadcastAll("chat:message-deleted", { messageId, threadId });
  }
  res.json({ success: true });
});

// Accusés de lecture et réception
app.post("/api/chat/threads/:id/read", (req, res) => {
  const threadId = req.params.id;
  const { userId } = req.body || {};

  const list = messageStore.get(threadId) || [];
  list.forEach((m) => {
    if (m.senderId !== userId) {
      m.status = "read";
    }
  });

  const thread = threadStore.get(threadId);
  if (thread) {
    thread.unreadCount = 0;
  }

  broadcastAll("chat:read", { threadId, userId });
  res.json({ success: true });
});

app.post("/api/chat/threads/:id/delivered", (req, res) => {
  const threadId = req.params.id;
  const { userId } = req.body || {};

  const list = messageStore.get(threadId) || [];
  list.forEach((m) => {
    if (m.senderId !== userId && m.status === "sent") {
      m.status = "delivered";
    }
  });

  broadcastAll("chat:delivered", { threadId, userId });
  res.json({ success: true });
});

// Upload de photos / notes vocales en secours
app.post("/api/chat/upload", (req, res) => {
  const { data, base64, filename, mimeType, type } = req.body || {};
  const payloadData = data || base64;
  if (!payloadData) return res.status(400).json({ error: "Aucun fichier reçu" });

  const id = "up_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  const detectedMime =
    mimeType ||
    (type === "audio"
      ? "audio/webm"
      : type === "video"
      ? "video/mp4"
      : "image/jpeg");

  const fileRecord = {
    data: payloadData,
    filename: filename || `fichier_${id}`,
    mimeType: detectedMime,
  };
  uploadStore.set(id, fileRecord);
  if (filename) {
    uploadStore.set(filename, fileRecord);
  }

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

app.get("/chat-uploads/:filename", (req, res) => {
  const file = uploadStore.get(req.params.filename);
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

// 2. Serveurs Socket.IO : supporte à la fois le chemin standard (/socket.io) et /call
// avec maxHttpBufferSize à 50 Mo pour autoriser photos et notes vocales sans déconnexion.
const io = new Server(server, {
  cors: { origin: "*" },
  path: "/socket.io",
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 5e7,
});

const ioCall = new Server(server, {
  cors: { origin: "*" },
  path: "/call",
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 5e7,
});

const onlineUsers = new Map(); // socketId -> { userId, userName, role, avatarUrl }

// Fonction universelle d'émission vers tous les clients connectés
function broadcastAll(event, data) {
  try {
    io.emit(event, data);
    io.of("/call").emit(event, data);
  } catch {}
  try {
    ioCall.emit(event, data);
    ioCall.of("/call").emit(event, data);
  } catch {}
}

// Fonction de calcul et diffusion de la présence en temps réel
function broadcastPresence() {
  const users = Array.from(onlineUsers.values());
  const onlineUserIds = Array.from(new Set(users.map((u) => u.userId).filter(Boolean)));
  const onlineUserNames = Array.from(new Set(users.map((u) => u.userName).filter(Boolean)));

  const presencePayload = {
    onlineUserIds,
    onlineUserNames,
    onlineUsers: users,
  };

  broadcastAll("chat:presence", presencePayload);
}

function registerSocketHandlers(socket) {
  // Envoyer immédiatement l'état actuel de présence dès la connexion
  const currentUsers = Array.from(onlineUsers.values());
  socket.emit("chat:presence", {
    onlineUserIds: Array.from(new Set(currentUsers.map((u) => u.userId).filter(Boolean))),
    onlineUserNames: Array.from(new Set(currentUsers.map((u) => u.userName).filter(Boolean))),
    onlineUsers: currentUsers,
  });

  // Identification utilisateur (compatible avec objet user ou data string)
  socket.on("chat:identify", (user) => {
    if (!user) return;
    const userId = user.userId || user.id;
    const userName = user.userName || user.name || "Proche";
    if (!userId) return;

    onlineUsers.set(socket.id, {
      userId,
      userName,
      role: user.role || "family",
      avatarUrl: user.avatarUrl || "",
    });

    registeredUsers.set(userId, {
      id: userId,
      name: userName,
      role: user.role || "family",
      avatarUrl: user.avatarUrl || "",
    });

    broadcastPresence();
  });

  // Événement join (visio / interphone / identifiant utilisateur)
  socket.on("join", (data) => {
    if (data?.userId) {
      onlineUsers.set(socket.id, {
        userId: data.userId,
        userName: data.name || "Appareil",
        role: data.role || "kiosk",
      });
      broadcastPresence();
    }
    socket.broadcast.emit("peer-joined", { sid: socket.id, ...data });
  });

  // Relais des messages instantanés (diffusé à tous les clients connectés)
  socket.on("chat:message", (msg) => {
    if (msg) {
      if (!msg.id) msg.id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (!msg.timestamp) msg.timestamp = new Date().toISOString();
      saveMessage(msg);
    }
    broadcastAll("chat:message", msg);
  });

  // Relais de la saisie en cours
  socket.on("chat:typing", (evt) => {
    broadcastAll("chat:typing", evt);
  });

  socket.on("chat:stop-typing", (evt) => {
    broadcastAll("chat:stop-typing", evt);
  });

  // Relais des accusés de lecture / réception
  socket.on("chat:read", (evt) => {
    if (evt?.threadId && evt?.userId) {
      const list = messageStore.get(evt.threadId) || [];
      list.forEach((m) => {
        if (m.senderId !== evt.userId) m.status = "read";
      });
    }
    broadcastAll("chat:read", evt);
  });

  socket.on("chat:delivered", (evt) => {
    if (evt?.threadId && evt?.userId) {
      const list = messageStore.get(evt.threadId) || [];
      list.forEach((m) => {
        if (m.senderId !== evt.userId && m.status === "sent") m.status = "delivered";
      });
    }
    broadcastAll("chat:delivered", evt);
  });

  // Relais des réactions
  socket.on("chat:reaction", (evt) => {
    if (evt?.messageId && evt?.reactions) {
      for (const list of messageStore.values()) {
        const m = list.find((item) => item.id === evt.messageId);
        if (m) {
          m.reactions = evt.reactions;
          break;
        }
      }
    }
    broadcastAll("chat:reaction", evt);
  });

  // Signalisation d'appels / interphone WebRTC de secours
  socket.on("offer", (data) => broadcastAll("offer", data));
  socket.on("answer", (data) => broadcastAll("answer", data));
  socket.on("ice-candidate", (data) => broadcastAll("ice-candidate", data));
  socket.on("hangup", (data) => broadcastAll("hangup", data));

  socket.on("disconnect", () => {
    const user = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (user) {
      broadcastPresence();
    }
  });
}

// Enregistrement des écouteurs sur tous les namespaces (racine et /call)
io.on("connection", registerSocketHandlers);
io.of("/call").on("connection", registerSocketHandlers);

ioCall.on("connection", registerSocketHandlers);
ioCall.of("/call").on("connection", registerSocketHandlers);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[aurora-relay] Passerelle Messenger de secours écoute sur le port ${PORT}`);
});

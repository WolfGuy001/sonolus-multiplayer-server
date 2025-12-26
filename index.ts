import express from "express";
import path from "path";
import cors from "cors";
import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { Sonolus } from "@sonolus/express";
import { Text } from "@sonolus/core";
import { MultiplayerRoom } from "./multiplayer";

const port = 3000;
const app = express();
const server = http.createServer(app);

app.set("trust proxy", true);

const rooms = new Map<string, MultiplayerRoom>();
const sessions = new Map<string, any>();

// Публичный ключ Sonolus для верификации (из документации)
const SONOLUS_PUBLIC_KEY = {
  kty: "EC",
  crv: "P-256",
  x: "d2B14ZAn-zDsqY42rHofst8rw3XB90-a5lT80NFdXo0",
  y: "Hxzi9DHrlJ4CVSJVRnydxFWBZAgkFxZXbyxPSa8SJQw",
};

function verifySonolusSignature(body: Buffer, signature: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: SONOLUS_PUBLIC_KEY as any,
      format: "jwk",
    });
    const verify = crypto.createVerify("sha256");
    verify.update(body);
    verify.end();
    return verify.verify(key, signature, "base64");
  } catch (e) {
    console.error("[Security] Signature verification failed:", e);
    return false;
  }
}

// --- MIDDLEWARE ---

app.use(cors({ exposedHeaders: ["Sonolus-Version"] }));

// Захватываем сырое тело запроса для корректной передачи в поле authentication
app.use(
  express.json({
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (req.url.startsWith("/multiplayer")) return next();
  res.set("Sonolus-Version", "1.0.2");
  next();
});

// --- AUTHENTICATION & JOIN HANDLERS ---

// Реализация POST /sonolus/authenticate
app.post("/sonolus/authenticate", (req: any, res) => {
  console.log("[Auth] Authenticate request received");
  const signature = req.headers["sonolus-signature"];
  if (!signature || !verifySonolusSignature(req.rawBody, signature)) {
    console.warn("[Auth] Invalid signature or missing header");
    return res.status(401).json({ message: "Invalid signature" });
  }

  const session = Buffer.from(JSON.stringify(req.body.userProfile)).toString(
    "base64",
  );
  console.log("[Auth] Session created for user:", req.body.userProfile.name);
  res.json({
    session: session,
    expiration: Date.now() + 30 * 60 * 1000,
  });
});

// Реализация POST /sonolus/rooms/:itemName
app.post("/sonolus/rooms/:itemName", (req: any, res) => {
  const itemName = req.params.itemName;
  const signature = req.headers["sonolus-signature"];
  console.log(`[RoomJoin] Request for room: ${itemName}`);

  if (!rooms.has(itemName)) {
    console.warn(`[RoomJoin] Room not found: ${itemName}`);
    return res.status(404).json({ message: "Room not found" });
  }

  const authentication = req.rawBody.toString("base64");
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    authentication,
    signature: signature || "",
  });

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const wsUrl = `${protocol === "https" ? "wss" : "ws"}://${host}/multiplayer`;

  console.log(
    `[RoomJoin] Success. URL: ${wsUrl}?room=${itemName}&session=${sessionId}`,
  );
  res.json({
    url: `${wsUrl}?room=${itemName}&session=${sessionId}`,
    type: "round",
    session: sessionId,
  });
});

// --- WEBSOCKET SERVER ---

const wss = new WebSocketServer({ noServer: true });

// Inject mandatory Sonolus-Version header into the WebSocket upgrade response
// Inject mandatory Sonolus-Version header into the WebSocket upgrade response
wss.on("headers", (headers) => {
  headers.push("Sonolus-Version: 1.0.2");
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(
    request.url || "",
    `http://${request.headers.host || "localhost"}`,
  );

  if (url.pathname === "/multiplayer") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const roomId = url.searchParams.get("room");
      const session = url.searchParams.get("session");

      if (!roomId || !rooms.has(roomId) || !session) {
        ws.close(1008, "Invalid connection params");
        return;
      }

      try {
        const room = rooms.get(roomId)!;
        const sessionData = sessions.get(session);

        if (!sessionData) {
          ws.close(1008, "Session not found");
          return;
        }

        const originalBody = JSON.parse(
          Buffer.from(sessionData.authentication, "base64").toString(),
        );
        const profile = originalBody.userProfile;

        const roomUser = {
          authentication: sessionData.authentication,
          signature: sessionData.signature,
        };

        console.log(`[WS] Authorized: ${profile.name} (ID: ${profile.id})`);
        room.addUser(roomUser, profile, ws);

        ws.on("message", (message: any) => {
          try {
            const command = JSON.parse(message.toString());
            console.log(`[WS] Received command from ${profile.name}:`, command.type, JSON.stringify(command).substring(0, 100));
            room.handleCommand(profile.id, command);
          } catch (e) {
            console.error("[WS] Command error:", e);
          }
        });

        ws.on("close", (code: number) => {
          console.log(`[WS] Connection closed for ${profile.name}. Code: ${code}`);
          room.removeUser(profile.id);
        });
      } catch (err) {
        console.error("[WS] Fatal Error:", err);
        ws.close(1011, "Auth failed");
      }
    });
  } else {
    socket.destroy();
  }
});

// --- SONOLUS SETUP ---

const publicUrl = "http://192.168.0.6:3000";

const sonolus = new Sonolus({
  address: publicUrl,
  fallbackLocale: "en",
  room: {
    creates: {
      basic: {
        title: { en: "Create Custom Lobby", ru: "Создать лобби" },
        requireConfirmation: false,
        options: {
          title: {
            type: "text",
            name: { en: "#TITLE", ru: "Название" },
            placeholder: {
              en: "Enter lobby name...",
              ru: "Введите название...",
            },
            def: "My Awesome Lobby",
            limit: 30,
            required: true,
            shortcuts: []
          },
        },
      },
    },
  },
});

if (!(sonolus as any).room) (sonolus as any).room = (sonolus as any).rooms;

sonolus.room.infoHandler = async () => ({
  sections: [
    {
      title: { en: "Public Rooms", ru: "Публичные комнаты" },
      itemType: "room",
      items: (sonolus.room as any).items,
    },
  ],
});

sonolus.title = { en: "Sonolus Server", ru: "Сервер Sonolus" };
sonolus.description = {
  en: "Verified Round Multiplayer Server",
  ru: "Сервер с проверкой подписи",
};
sonolus.banner = {
  hash: "deddadfe62e9ba31ba317eb35df91b65f61f186e",
  url: `${publicUrl}/sonolus/banner`,
};

const testRoomId = "test-room";
const testRoom = new MultiplayerRoom(testRoomId, {
  en: "Test Public Lobby",
  ru: "Тестовое лобби",
});
rooms.set(testRoomId, testRoom);

sonolus.room.items.push({
  name: testRoomId,
  title: testRoom.title,
  subtitle: { en: "Welcome to multiplayer!", ru: "Добро пожаловать!" },
  master: { en: "System", ru: "Система" },
  tags: [],
});

sonolus.serverInfoHandler = () => ({
  title: sonolus.title,
  description: sonolus.description,
  buttons: [
    { type: "multiplayer" },
    { type: "post" },
    { type: "level" },
    { type: "skin" },
    { type: "background" },
    { type: "effect" },
    { type: "particle" },
    { type: "engine" },
    { type: "replay" },
    { type: "configuration" },
  ],
  configuration: { options: sonolus.configuration.options },
  banner: sonolus.banner,
});

// Настройка обработчиков результатов (если библиотека поддерживает)
if ((sonolus as any).levelResult) {
  (sonolus as any).levelResult.infoHandler = async () => ({
    submits: [
      {
        type: "basic",
        title: { en: "Submit Replay", ru: "Отправить реплей" },
        requireConfirmation: false,
        options: {},
      },
    ],
  });
}

app.use(sonolus.router);
app.get("/sonolus/banner", (req, res) =>
  res.sendFile(path.join(__dirname, "banner.png")),
);

server.listen(port, () => {
  console.log(`--- SONOLUS SERVER READY (WITH AUTH) ---`);
});

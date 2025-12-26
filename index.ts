import express from "express";
import path from "path";
import cors from "cors";
import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { Sonolus } from "@sonolus/express";
import { Text } from "@sonolus/core";
import { MultiplayerRoom } from "./multiplayer";
import { resultsStore } from "./resultsStore";

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

// --- LEADERBOARD ---

app.get("/leaderboard", (req, res) => {
  console.log("[Leaderboard] Accessing leaderboard page");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:;",
  );
  const history = resultsStore.getHistory();

  // Calculate Global Rating
  const globalStats = new Map<string, { name: string; totalScore: number; matchCount: number }>();
  history.forEach(match => {
    match.results.forEach(r => {
      const stats = globalStats.get(r.userId) || { name: r.userName || 'Unknown', totalScore: 0, matchCount: 0 };
      stats.totalScore += r.result.arcadeScore;
      stats.matchCount += 1;
      stats.name = r.userName || stats.name; // Keep latest name
      globalStats.set(r.userId, stats);
    });
  });

  const sortedGlobal = Array.from(globalStats.values())
    .sort((a, b) => b.totalScore - a.totalScore);

  let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Match History</title>
        <style>
            body { font-family: sans-serif; background: #222; color: #eee; padding: 20px; }
            table { width: 100%; border-collapse: collapse; background: #333; margin-bottom: 30px; }
            th, td { padding: 10px; border: 1px solid #444; text-align: left; vertical-align: top; }
            th { background: #444; }
            .rank-1 { color: #ffd700; font-weight: bold; }
            .rank-2 { color: #c0c0c0; font-weight: bold; }
            .rank-3 { color: #cd7f32; font-weight: bold; }
            .grade-allPerfect { color: #ffeb3b; text-shadow: 0 0 5px #ffeb3b; }
            .grade-fullCombo { color: #03a9f4; }
            .grade-pass { color: #8bc34a; }
            .grade-fail { color: #f44336; }
            .level-artist { font-size: 0.8em; color: #aaa; }
            .section-title { margin-top: 40px; margin-bottom: 10px; color: #fff; border-bottom: 2px solid #444; padding-bottom: 5px; }
        </style>
    </head>
    <body>
        <h1>Лидерборд</h1>
        
        <h2 class="section-title">Общий рейтинг сервера</h2>
        <table>
            <thead>
                <tr>
                    <th style="width: 50px;">Место</th>
                    <th>Игрок</th>
                    <th style="text-align: right;">Всего очков</th>
                    <th style="text-align: right;">Матчей</th>
                </tr>
            </thead>
            <tbody>
    `;

  if (sortedGlobal.length === 0) {
    html += `<tr><td colspan="4" style="text-align:center; padding: 20px;">Рейтинг пока пуст.</td></tr>`;
  } else {
    sortedGlobal.forEach((player, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? `rank-${rank}` : "";
      html += `
                <tr>
                    <td class="${rankClass}">#${rank}</td>
                    <td><span class="${rankClass}">${player.name}</span></td>
                    <td style="text-align: right;">${player.totalScore.toLocaleString()}</td>
                    <td style="text-align: right;">${player.matchCount}</td>
                </tr>
            `;
    });
  }

  html += `
            </tbody>
        </table>

        <h2 class="section-title">История матчей</h2>
        <table>
            <thead>
                <tr>
                    <th>Дата</th>
                    <th>Рума</th>
                    <th>Уровень</th>
                    <th>Результаты</th>
                </tr>
            </thead>
            <tbody>
    `;

  if (history.length === 0) {
    html += `
            <tr>
                <td colspan="4" style="text-align:center; padding: 50px;">Нет истории матчей.</td>
            </tr>
    `;
  }

  history.forEach((match) => {
    const date = new Date(match.timestamp).toLocaleString();

    const rawLevel = match.level as any;
    const rawTitle = rawLevel?.title;
    const levelTitle =
      typeof rawTitle === "string"
        ? rawTitle
        : rawTitle?.en || rawTitle?.ru || rawLevel?.name || "Unknown Level";

    const rawArtist = rawLevel?.artists;
    const levelArtist =
      typeof rawArtist === "string"
        ? rawArtist
        : rawArtist?.en || rawArtist?.ru || "";

    // Sort results by score desc
    const sortedResults = [...match.results].sort(
      (a, b) => b.result.arcadeScore - a.result.arcadeScore,
    );

    let resultsHtml = '<table style="width:100%; background:transparent;">';
    sortedResults.forEach((r, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? `rank-${rank}` : "";
      const gradeClass = `grade-${r.result.grade}`;
      const userName = r.userName || "Unknown";

      resultsHtml += `
                <tr>
                    <td style="border:none; width: 30px;" class="${rankClass}">#${rank}</td>
                    <td style="border:none;">
                        <span class="${rankClass}">${userName}</span>
                    </td>
                    <td style="border:none; text-align:right;">${r.result.arcadeScore.toLocaleString()}</td>
                    <td style="border:none; text-align:right;" class="${gradeClass}">${r.result.grade}</td>
                    <td style="border:none; text-align:right; font-size:0.8em;">Combo: ${r.result.combo}</td>
                </tr>
            `;
    });
    resultsHtml += "</table>";

    html += `
            <tr>
                <td>${date}</td>
                <td>${match.roomName}</td>
                <td>
                    <div><strong>${levelTitle}</strong></div>
                    <div class="level-artist">${levelArtist}</div>
                </td>
                <td style="padding: 0;">${resultsHtml}</td>
            </tr>
        `;
  });

  html += `
            </tbody>
        </table>
        <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
            <form id="reset-form" action="/reset-leaderboard" method="POST">
                <input type="hidden" name="password" id="reset-password">
                <button type="submit" style="background: #f44336; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                    Reset Match History
                </button>
            </form>
        </div>
        <script>
            document.getElementById('reset-form').onsubmit = function(e) {
                const pw = prompt('Ненене, сначала пароль:');
                if (!pw) return false;
                document.getElementById('reset-password').value = pw;
                return true;
            };
        </script>
    </body>
    </html>
    `;

  res.send(html);
});

app.post("/reset-leaderboard", (req, res) => {
  const password = req.body.password;
  // Можно вынести пароль в константу или .env. Сейчас "admin" для примера.
  if (password !== "admin") {
    console.warn("[Leaderboard] Reset failed: Invalid password");
    return res.status(403).send("Invalid password. <a href='/leaderboard'>Go back</a>");
  }

  console.log("[Leaderboard] Resetting match history (authorized)");
  resultsStore.clearHistory();
  res.redirect("/leaderboard");
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

app.get("/sonolus/banner", (req, res) =>
  res.sendFile(path.join(__dirname, "banner.png")),
);


app.use(sonolus.router);

app.use((req, res) => {
  console.warn(`[404] Route not found: ${req.method} ${req.url}`);
  res.set("Sonolus-Version", "1.0.2");
  res.status(404).send("Not Found");
});

server.listen(port, () => {
  console.log(`--- SONOLUS SERVER READY (WITH AUTH) ---`);
});

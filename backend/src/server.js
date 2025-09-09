const path = require("path");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const admin = require("firebase-admin");
const { getPool, migrate } = require("./db");

// Load environment
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Initialize Firebase Admin using GOOGLE_APPLICATION_CREDENTIALS or explicit key
function initFirebaseAdmin() {
  if (admin.apps.length) return;
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      // eslint-disable-next-line no-console
      console.log(
        "Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS"
      );
      return;
    }

    const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : path.join(__dirname, "..", "serviceAccountKey.json");

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    // eslint-disable-next-line no-console
    console.log("Firebase Admin initialized via service account json");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Failed to initialize Firebase Admin:", e.message);
    throw e;
  }
}

initFirebaseAdmin();

const app = express();
app.use(cors());
app.use(bodyParser.json());
const pool = getPool();
// Run migrations at startup
migrate().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("DB migration failed:", e);
  process.exit(1);
});

// Helpers
async function createOrGetUser({ externalId, name, email }) {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE email = ? OR external_id = ? LIMIT 1",
    [email || null, externalId || null]
  );
  if (rows.length) return rows[0];
  const [res] = await pool.query(
    "INSERT INTO users (external_id, name, email) VALUES (?, ?, ?)",
    [externalId || null, name || null, email || null]
  );
  const [created] = await pool.query(
    "SELECT * FROM users WHERE id = ? LIMIT 1",
    [res.insertId]
  );
  return created[0];
}

async function upsertDeviceToken({ userId, token, platform }) {
  const [rows] = await pool.query(
    "SELECT * FROM device_tokens WHERE token = ? LIMIT 1",
    [token]
  );
  if (rows.length) {
    const existing = rows[0];
    await pool.query(
      "UPDATE device_tokens SET user_id = ?, platform = ?, last_seen_at = NOW() WHERE id = ?",
      [userId, platform || null, existing.id]
    );
    const [updated] = await pool.query(
      "SELECT * FROM device_tokens WHERE id = ? LIMIT 1",
      [existing.id]
    );
    return updated[0];
  }
  const [res] = await pool.query(
    "INSERT INTO device_tokens (user_id, token, platform, last_seen_at) VALUES (?, ?, ?, NOW())",
    [userId, token, platform || null]
  );
  const [created] = await pool.query(
    "SELECT * FROM device_tokens WHERE id = ? LIMIT 1",
    [res.insertId]
  );
  return created[0];
}

async function createMessage({ title, body, data }) {
  const [res] = await pool.query(
    "INSERT INTO messages (title, body, data_json) VALUES (?, ?, CAST(? AS JSON))",
    [title || null, body || null, data ? JSON.stringify(data) : null]
  );
  const [rows] = await pool.query(
    "SELECT * FROM messages WHERE id = ? LIMIT 1",
    [res.insertId]
  );
  return rows[0];
}

async function queueDelivery({
  messageId,
  userId,
  tokenId,
  status = "queued",
  error = null,
  sentAt = null,
}) {
  const [res] = await pool.query(
    "INSERT INTO message_deliveries (message_id, user_id, token_id, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
    [messageId, userId || null, tokenId || null, status, error, sentAt]
  );
  const [rows] = await pool.query(
    "SELECT * FROM message_deliveries WHERE id = ? LIMIT 1",
    [res.insertId]
  );
  return rows[0];
}

async function sendToToken({ token, title, body, data }) {
  const message = {
    token,
    notification: title || body ? { title, body } : undefined,
    data: data
      ? Object.fromEntries(
          Object.entries(data).map(([k, v]) => [String(k), String(v)])
        )
      : undefined,
    android: { priority: "high" },
    apns: { headers: { "apns-priority": "10" } },
  };
  const result = await admin.messaging().send(message);
  console.log(result);
}
const token =
  "dJmUaKL7QhK2VjPzuGc9fM:APA91bExusrRfFspY80Mo92kGee4_T_nx9CjwbTM6yfd2KfYVI9qv0LSo4zj-LEz9h-2d3MbILSfs2uhKDTO-y0XO7JnvYkAE6wSc1mS_ylrXCjlY7ktaAQ";
const title = "Hello";
const body = "Hello World";
const data = { key: "value" };

sendToToken({ token, title, body, data });
// Routes
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create user
app.post("/users", async (req, res) => {
  try {
    const { externalId, name, email } = req.body || {};
    const user = await createOrGetUser({ externalId, name, email });
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Register/associate a device token
app.post("/tokens", async (req, res) => {
  try {
    const { userId, token, platform } = req.body || {};
    if (!userId || !token)
      return res.status(400).json({ error: "userId and token are required" });
    const [userRows] = await pool.query(
      "SELECT * FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    if (!userRows.length)
      return res.status(404).json({ error: "User not found" });
    const t = await upsertDeviceToken({ userId, token, platform });
    res.json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create message and send to a single user or broadcast
app.post("/messages", async (req, res) => {
  try {
    const { title, body, data, userId } = req.body || {};
    const msg = await createMessage({ title, body, data });

    let tokens = [];
    if (userId) {
      const [rows] = await pool.query(
        "SELECT dt.*, u.id as user_id FROM device_tokens dt JOIN users u ON u.id = dt.user_id WHERE u.id = ?",
        [userId]
      );
      tokens = rows;
    } else {
      const [rows] = await pool.query(
        "SELECT dt.*, u.id as user_id FROM device_tokens dt JOIN users u ON u.id = dt.user_id"
      );
      tokens = rows;
    }

    const results = [];
    for (const t of tokens) {
      const delivery = await queueDelivery({
        messageId: msg.id,
        userId: t.user_id,
        tokenId: t.id,
        status: "queued",
      });
      try {
        const id = await sendToToken({ token: t.token, title, body, data });
        await pool.query(
          "UPDATE message_deliveries SET status = ?, sent_at = NOW(), error = NULL WHERE id = ?",
          ["sent", delivery.id]
        );
        results.push({ token: t.token, status: "sent", messageId: id });
      } catch (err) {
        await pool.query(
          "UPDATE message_deliveries SET status = ?, error = ? WHERE id = ?",
          ["failed", String(err.message || err), delivery.id]
        );
        results.push({
          token: t.token,
          status: "failed",
          error: String(err.message || err),
        });
      }
    }

    res.json({ message: msg, deliveries: results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List a user's messages (deliveries join)
app.get("/users/:id/messages", async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT md.*, m.title, m.body, m.data_json
       FROM message_deliveries md
       JOIN messages m ON m.id = md.message_id
       WHERE md.user_id = ?
       ORDER BY md.created_at DESC`,
      [userId]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        error: r.error,
        sentAt: r.sent_at,
        createdAt: r.created_at,
        message: {
          id: r.message_id,
          title: r.title,
          body: r.body,
          data: r.data_json
            ? typeof r.data_json === "string"
              ? JSON.parse(r.data_json)
              : r.data_json
            : null,
        },
      }))
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FCM backend listening on http://localhost:${PORT}`);
});

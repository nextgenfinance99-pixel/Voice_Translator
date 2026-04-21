require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { DeepgramClient } = require("@deepgram/sdk");
const { Translate } = require("@google-cloud/translate").v2;

// ── Config ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error("❌  Missing DEEPGRAM_API_KEY in .env");
  process.exit(1);
}
if (!GOOGLE_TRANSLATE_API_KEY) {
  console.error("❌  Missing GOOGLE_TRANSLATE_API_KEY in .env");
  process.exit(1);
}

// ── Express + Socket.IO setup ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// ── Deepgram client (reuse across connections) ──────────────────────────
const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

// ── Google Translate client (v2 — uses simple API key) ──────────────────
const translateClient = new Translate({ key: GOOGLE_TRANSLATE_API_KEY });

/**
 * Translate text using Google Cloud Translation API v2.
 */
async function translateText(text, sourceLang, targetLang) {
  const [translation] = await translateClient.translate(text, {
    from: sourceLang,
    to: targetLang,
  });
  return translation;
}

// ── Socket.IO ───────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`🔌  Client connected: ${socket.id}`);

  let dgSocket = null;
  let dgReady = false;
  let keepAliveInterval = null;

  function cleanupDeepgram() {
    dgReady = false;
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    if (dgSocket) {
      try { dgSocket.close(); } catch (_) { /* ignore */ }
      dgSocket = null;
    }
  }

  // Client sends { sourceLang, targetLang } to start a session
  socket.on("start-stream", async ({ sourceLang = "en", targetLang = "te" } = {}) => {
    console.log(`🎙  Starting stream: ${sourceLang} → ${targetLang}`);

    // Clean up any existing connection first
    cleanupDeepgram();

    // Map language codes to Deepgram-compatible models
    const dgLanguageMap = {
      en: "en-US",
      te: "te",
    };
    const dgLang = dgLanguageMap[sourceLang] || sourceLang;

    try {
      // Step 1: Create the socket object (does NOT connect yet — startClosed: true)
      console.log("🔗  Creating Deepgram socket...");
      const connection = await deepgram.listen.v1.connect({
        language: dgLang,
        model: "nova-3",
        smart_format: true,
        interim_results: true,
        utterance_end_ms: 1500,
        vad_events: true,
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
      });

      dgSocket = connection;

      // Step 2: Register event handlers BEFORE calling connect()
      connection.on("open", () => {
        console.log("✅  Deepgram WebSocket opened");
        dgReady = true;
        socket.emit("transcription-ready");
      });

      connection.on("message", async (data) => {
        try {
          const msg = typeof data === "string" ? JSON.parse(data) : data;

          // Only process transcript results
          if (msg.type !== "Results") return;

          const transcript = msg.channel?.alternatives?.[0]?.transcript;
          if (!transcript || transcript.trim() === "") return;

          const isFinal = msg.is_final;

          // Send the original transcript to the client
          socket.emit("transcript", { text: transcript, isFinal, sourceLang });

          // Only translate final (confirmed) transcripts
          if (isFinal) {
            try {
              const translated = await translateText(transcript, sourceLang, targetLang);
              socket.emit("translation", {
                original: transcript,
                translated,
                sourceLang,
                targetLang,
              });
            } catch (err) {
              console.error("Translation error:", err.message);
              socket.emit("error-message", { message: "Translation failed: " + err.message });
            }
          }
        } catch (parseErr) {
          console.error("Error processing Deepgram message:", parseErr);
        }
      });

      connection.on("error", (err) => {
        console.error("❌  Deepgram error:", err);
        socket.emit("error-message", { message: "Deepgram error: " + String(err) });
      });

      connection.on("close", () => {
        console.log("🔒  Deepgram connection closed");
        dgReady = false;
        clearInterval(keepAliveInterval);
      });

      // Step 3: Actually initiate the WebSocket connection
      console.log("⏳  Connecting to Deepgram...");
      connection.connect();

      // Step 4: Wait for it to be open
      await connection.waitForOpen();
      console.log("✅  Deepgram is ready to receive audio");

      // Step 5: Keep the connection alive with periodic pings
      keepAliveInterval = setInterval(() => {
        if (dgSocket && dgReady) {
          try {
            dgSocket.sendKeepAlive({ type: "KeepAlive" });
          } catch (_) { /* ignore if closed */ }
        }
      }, 10000);

    } catch (err) {
      console.error("❌  Failed to connect to Deepgram:", err);
      socket.emit("error-message", {
        message: "Failed to start transcription: " + (err.message || String(err)),
      });
    }
  });

  // Receive raw audio data from the client
  socket.on("audio-data", (data) => {
    if (dgSocket && dgReady) {
      try {
        dgSocket.sendMedia(data);
      } catch (err) {
        console.error("Error sending audio to Deepgram:", err.message);
      }
    }
  });

  // Stop transcription
  socket.on("stop-stream", () => {
    console.log("⏹  Stopping stream");
    cleanupDeepgram();
  });

  // Translate-only endpoint (for typed text)
  socket.on("translate-text", async ({ text, sourceLang, targetLang }) => {
    try {
      const translated = await translateText(text, sourceLang, targetLang);
      socket.emit("translation", {
        original: text,
        translated,
        sourceLang,
        targetLang,
      });
    } catch (err) {
      console.error("Translation error:", err.message);
      socket.emit("error-message", { message: "Translation failed: " + err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌  Client disconnected: ${socket.id}`);
    cleanupDeepgram();
  });
});

// ── Start server ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌐  GlobalConnect server running at http://localhost:${PORT}\n`);
});

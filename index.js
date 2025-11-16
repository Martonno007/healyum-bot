require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const cors = require("cors");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // usato per proteggere /cron/daily

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN mancante nel .env");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ SUPABASE_URL o SUPABASE_SERVICE_KEY mancanti nel .env");
  process.exit(1);
}
if (!CRON_SECRET) {
  console.error("❌ CRON_SECRET mancante nel .env");
  process.exit(1);
}

// ---------- CLIENTS ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

app.use(cors());
app.use(express.json());

// ---------- COSTANTI ----------
const WEB_APP_URL = "https://healyum-miniapp.vercel.app/";
const FEE = 0.02;

// Orario di “cambio giorno” del pool in Europe/Rome
const LOCK_HOUR = 15;
const LOCK_MINUTE = 30;

// ---------- UTILS ----------

/**
 * Restituisce un oggetto Date che rappresenta "ora" nel fuso Europe/Rome.
 */
function getRomeNow(baseDate = new Date()) {
  return new Date(
    baseDate.toLocaleString("en-US", { timeZone: "Europe/Rome" })
  );
}

/**
 * Restituisce "YYYY-MM-DD" calcolato nel fuso Europe/Rome.
 */
function getRomeDateStr(date = new Date()) {
  const rome = getRomeNow(date);
  const year = rome.getFullYear();
  const month = String(rome.getMonth() + 1).padStart(2, "0");
  const day = String(rome.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Ritorna { id: "TSLA-YYYY-MM-DD", dateStr: "YYYY-MM-DD" } per la data data.
 */
function getMarketIdForRomeDate(date = new Date()) {
  const dateStr = getRomeDateStr(date);
  return { id: `TSLA-${dateStr}`, dateStr };
}

/**
 * Identifica il **mercato attivo in questo momento**.
 *
 * Regola:
 *  - prima delle 15:30 Europe/Rome → mercato del GIORNO PRIMA
 *  - dalle 15:30 in poi → mercato del GIORNO CORRENTE
 */
function getActiveMarketIdRome(now = new Date()) {
  const romeNow = getRomeNow(now);
  const h = romeNow.getHours();
  const m = romeNow.getMinutes();

  const beforeLock = h < LOCK_HOUR || (h === LOCK_HOUR && m < LOCK_MINUTE);
  const effectiveDate = new Date(romeNow);

  if (beforeLock) {
    // prima delle 15:30 → il pool "attivo" è quello di ieri
    effectiveDate.setDate(effectiveDate.getDate() - 1);
  }
  // altrimenti (dalle 15:30 in poi) → use today

  return getMarketIdForRomeDate(effectiveDate);
}

/**
 * Calcola da quanto tempo il mercato è aperto (in minuti) a partire da opened_at.
 */
function getMinutesSinceOpened(market) {
  if (!market.opened_at) return null;
  const opened = new Date(market.opened_at);
  const diffMs = Date.now() - opened.getTime();
  return Math.floor(diffMs / 60000);
}

/**
 * Crea o ritorna il **mercato attivo** in questo momento.
 * (Se è la prima volta che lo usi per quella giornata, lo crea)
 */
async function getOrCreateActiveMarket() {
  const { id: marketId, dateStr } = getActiveMarketIdRome();

  let { data: market, error } = await supabase
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .single();

  if (!market) {
    const openedAt = new Date().toISOString();
    const { data, error: insErr } = await supabase
      .from("markets")
      .insert({
        id: marketId,
        underlying: "TSLA",
        date: dateStr,
        status: "OPEN",
        up_pool: 0,
        down_pool: 0,
        opened_at: openedAt,
      })
      .select()
      .single();
    if (insErr) throw insErr;
    market = data;
  } else if (error && error.code !== "PGRST116") {
    throw error;
  }

  return market;
}

/**
 * Ritorna il **mercato attivo**, se esiste (senza crearlo).
 */
async function getActiveMarketIfExists() {
  const { id: marketId } = getActiveMarketIdRome();
  const { data: market, error } = await supabase
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .single();
  if (error && error.code === "PGRST116") return null;
  if (error) throw error;
  return market;
}

/**
 * Ritorna il market "più recente":
 *  1) se esiste un OPEN prende quello
 *  2) altrimenti prende comunque l'ultimo per data (LOCKED/RESOLVED)
 */
async function getLatestMarket() {
  // prima provo un OPEN
  let { data: openMarkets, error } = await supabase
    .from("markets")
    .select("*")
    .eq("status", "OPEN")
    .order("date", { ascending: false })
    .limit(1);

  if (error) throw error;

  let market = openMarkets && openMarkets[0];

  if (!market) {
    // nessun OPEN → prendo l'ultimo per data
    const { data: anyMarkets, error: anyErr } = await supabase
      .from("markets")
      .select("*")
      .order("date", { ascending: false })
      .limit(1);

    if (anyErr) throw anyErr;
    market = anyMarkets && anyMarkets[0];
  }

  return market || null;
}

/**
 * Calcola #voti e volume USDC da tabella bets per un dato mercato.
 */
async function getVotesAndVolume(marketId) {
  const { data: bets, error } = await supabase
    .from("bets")
    .select("side, stake, created_at")
    .eq("market_id", marketId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const totalVotes = bets.length;
  const volumeUsdc = bets.reduce(
    (sum, b) => sum + (Number(b.stake) || 0),
    0
  );

  return { bets, totalVotes, volumeUsdc };
}

/**
 * Costruisce lo storico per il grafico:
 * punti cumulativi nel tempo con pct_up/pct_down, total_votes, volume_usdc.
 */
function buildHistoryFromBets(bets) {
  const history = [];
  let upPool = 0;
  let downPool = 0;
  let votes = 0;
  let volume = 0;

  for (const b of bets) {
    const stake = Number(b.stake) || 0;
    if (b.side === "UP") {
      upPool += stake;
    } else if (b.side === "DOWN") {
      downPool += stake;
    }
    votes += 1;
    volume += stake;

    const total = upPool + downPool;
    const pct_up = total === 0 ? 0.5 : upPool / total;
    const pct_down = 1 - pct_up;

    history.push({
      ts: b.created_at,
      pct_up,
      pct_down,
      total_votes: votes,
      volume_usdc: volume,
    });
  }

  return history;
}

// ---------- BOT EVENTS ----------
bot.on("polling_error", (err) => console.error("Polling error:", err));

bot.onText(/\/start/, async (msg) => {
  try {
    // opzionale: assicuriamo che il mercato attivo esista
    await getOrCreateActiveMarket();
  } catch (e) {
    console.error("Error ensuring active market on /start:", e);
  }

  bot.sendMessage(
    msg.chat.id,
    "⚡ Welcome to Healyum!\nPredict Tesla: will it go UP or DOWN?",
    {
      reply_markup: {
        keyboard: [
          [
            {
              text: "🚀 Open Healyum Mini-App",
              web_app: { url: WEB_APP_URL },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    }
  );
});

bot.onText(/\/status/, async (msg) => {
  try {
    const market = await getActiveMarketIfExists();
    if (!market) {
      return bot.sendMessage(
        msg.chat.id,
        "No active market yet. It will open automatically at the US market open."
      );
    }

    const minutesOpen = getMinutesSinceOpened(market);
    const ageText =
      minutesOpen != null
        ? `Open since ${minutesOpen} minutes.`
        : "opened_at not set.";

    bot.sendMessage(
      msg.chat.id,
      `📊 Active market: ${market.id}\nStatus: ${market.status}\nUP pool: ${market.up_pool}\nDOWN pool: ${market.down_pool}\n${ageText}`
    );
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, "❌ Error loading market status.");
  }
});

bot.onText(/\/resolve_(up|down)/, async (msg, match) => {
  const winningSide = match[1].toUpperCase();
  await resolveTodayMarket(msg.chat.id, winningSide);
});

bot.on("message", async (msg) => {
  console.log("New message:", JSON.stringify(msg, null, 2));
  if (msg.web_app_data && msg.web_app_data.data) {
    await handleWebAppData(msg);
  }
});

// ---------- WEBAPP HANDLER ----------
async function handleWebAppData(msg) {
  try {
    const payload = JSON.parse(msg.web_app_data.data);
    console.log("Parsed web_app_data:", payload);

    if (payload.type !== "BET") return;

    const rawSide = payload.side;
    const side = rawSide === "TESLA_UP" ? "UP" : "DOWN";
    const stake = Number(payload.stake || 1);

    const userId = await getOrCreateUser(msg.from);
    const market = await getOrCreateActiveMarket();

    if (market.status !== "OPEN") {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Market ${market.id} is not open.`
      );
    }

    // salva la bet
    await supabase.from("bets").insert({
      user_id: userId,
      market_id: market.id,
      side,
      stake,
    });

    // aggiorna i pool (approccio semplice, va bene per MVP)
    const newUpPool = market.up_pool + (side === "UP" ? stake : 0);
    const newDownPool = market.down_pool + (side === "DOWN" ? stake : 0);

    await supabase
      .from("markets")
      .update({ up_pool: newUpPool, down_pool: newDownPool })
      .eq("id", market.id);

    bot.sendMessage(
      msg.chat.id,
      `Got it ✅ You chose ${side} with stake ${stake} on ${market.id}\nCurrent pool → UP: ${newUpPool} | DOWN: ${newDownPool}`
    );
  } catch (e) {
    console.error("Error in handleWebAppData", e);
    bot.sendMessage(msg.chat.id, "❌ Error saving your bet.");
  }
}

// ---------- USER & RESOLUTION LOGIC ----------
async function getOrCreateUser(from) {
  const { id, username, first_name } = from;
  await supabase
    .from("users")
    .upsert({ id, username, first_name }, { onConflict: "id" });
  return id;
}

/**
 * Per ora lasciamo che /resolve_up e /resolve_down
 * risolvano il mercato “attivo” in quel momento.
 */
async function resolveTodayMarket(chatId, winningSide) {
  const market = await getActiveMarketIfExists();
  if (!market) {
    return bot.sendMessage(chatId, "No active market.");
  }

  const { data: bets } = await supabase
    .from("bets")
    .select("*")
    .eq("market_id", market.id);

  const upPool = market.up_pool;
  const downPool = market.down_pool;
  const totalPool = upPool + downPool;
  const winnersPool = winningSide === "UP" ? upPool : downPool;

  if (!winnersPool || winnersPool <= 0) {
    await supabase
      .from("markets")
      .update({
        status: "RESOLVED",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", market.id);

    return bot.sendMessage(
      chatId,
      `Market ${market.id} resolved with no winners on ${winningSide}.`
    );
  }

  const distributable = totalPool * (1 - FEE);
  const multiplier = distributable / winnersPool;

  for (const bet of bets || []) {
    if (bet.side === winningSide) {
      const payout = bet.stake * multiplier;
      await supabase.from("bets").update({ payout }).eq("id", bet.id);
      bot.sendMessage(
        bet.user_id,
        `🎉 You WON on ${market.id}! Payout: ${payout.toFixed(2)}`
      );
    }
  }

  await supabase
    .from("markets")
    .update({ status: "RESOLVED", resolved_at: new Date().toISOString() })
    .eq("id", market.id);

  bot.sendMessage(chatId, `Market ${market.id} resolved.`);
}

// ---------- CRON ROUTE (chiamata una volta al giorno alle 15:30 Europe/Rome) ----------
app.get("/cron/daily", async (req, res) => {
  try {
    if (req.query.secret !== CRON_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    const now = new Date();
    const romeNow = getRomeNow(now);

    // Mercato che sta FINENDO (pool precedente, aperto ieri alle 15:30)
    const yesterdayRome = new Date(romeNow);
    yesterdayRome.setDate(yesterdayRome.getDate() - 1);
    const yesterdayInfo = getMarketIdForRomeDate(yesterdayRome);

    // Mercato che sta PER INIZIARE (nuovo pool di oggi)
    const todayInfo = getMarketIdForRomeDate(romeNow);

    const marketIdYesterday = yesterdayInfo.id;
    const marketIdToday = todayInfo.id;

    // 1️⃣ CHIUDI IL MERCATO DI IERI SE ESISTE (LOCKED)
    const { data: oldMarket } = await supabase
      .from("markets")
      .select("*")
      .eq("id", marketIdYesterday)
      .single();

    let lockedYesterday = false;

    if (oldMarket && oldMarket.status === "OPEN") {
      await supabase
        .from("markets")
        .update({
          status: "LOCKED",
          locked_at: now.toISOString(),
        })
        .eq("id", marketIdYesterday);

      lockedYesterday = true;
      console.log("Locked yesterday’s market:", marketIdYesterday);
    }

    // 2️⃣ CREA SEMPRE il nuovo mercato OGGI (apertura nuovo pool alle 15:30)
    const { data: existingToday } = await supabase
      .from("markets")
      .select("*")
      .eq("id", marketIdToday)
      .single();

    let createdToday = false;

    if (!existingToday) {
      await supabase.from("markets").insert({
        id: marketIdToday,
        underlying: "TSLA",
        date: todayInfo.dateStr,
        status: "OPEN",
        up_pool: 0,
        down_pool: 0,
        opened_at: now.toISOString(),
      });

      createdToday = true;
      console.log("Created today’s market:", marketIdToday);
    }

    return res.json({
      ok: true,
      lockedYesterday,
      createdToday,
      marketIdYesterday,
      marketIdToday,
    });
  } catch (err) {
    console.error("CRON ERROR", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- EXPRESS API ----------

// healthcheck
app.get("/", (_, res) => res.send("Healyum bot running 🟢"));

/**
 * API vecchia usata da /status
 */
app.get("/market/today", async (_, res) => {
  try {
    const market = await getActiveMarketIfExists();
    if (!market) return res.status(404).json({ error: "no_market" });

    const minutesOpen = getMinutesSinceOpened(market);
    res.json({
      id: market.id,
      status: market.status,
      up_pool: market.up_pool,
      down_pool: market.down_pool,
      opened_at: market.opened_at,
      locked_at: market.locked_at,
      resolved_at: market.resolved_at,
      minutes_open: minutesOpen,
    });
  } catch (e) {
    console.error("Error in /market/today:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * Nuova API per la mini-app: ultimo market (OPEN se possibile).
 * Restituisce percentuali (0-1), numero voti e volume usdc.
 */
app.get("/api/markets/latest", async (req, res) => {
  try {
    const market = await getLatestMarket();
    if (!market) {
      return res.status(404).json({ error: "no_market" });
    }

    const up = Number(market.up_pool) || 0;
    const down = Number(market.down_pool) || 0;
    const totalShares = up + down;
    const pct_up = totalShares === 0 ? 0.5 : up / totalShares;
    const pct_down = 1 - pct_up;

    const { totalVotes, volumeUsdc } = await getVotesAndVolume(market.id);

    res.json({
      id: market.id,
      asset: (market.underlying || "TSLA") + "X",
      date: market.date,
      status: market.status,
      opened_at: market.opened_at,
      pct_up,
      pct_down,
      total_votes: totalVotes,
      volume_usdc: volumeUsdc,
      // per ora non gestiamo prezzi/URL reali → null
      open_price: null,
      current_price: null,
      wallet_url: null,
    });
  } catch (e) {
    console.error("Error in /api/markets/latest:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * Storico per grafico: /api/markets/:id/history?range=1h|6h|all
 * Ricostruito dai bets ordinati per created_at.
 */
app.get("/api/markets/:id/history", async (req, res) => {
  try {
    const marketId = req.params.id;
    const range = req.query.range || "all";

    const { bets, totalVotes, volumeUsdc } = await getVotesAndVolume(marketId);
    let history = buildHistoryFromBets(bets);

    // filtro per range temporale (dal client: 1h, 6h, all)
    if (range === "1h" || range === "6h") {
      const hours = range === "1h" ? 1 : 6;
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - hours);
      const cutoffMs = cutoff.getTime();
      history = history.filter((p) => new Date(p.ts).getTime() >= cutoffMs);
    }

    res.json({
      market_id: marketId,
      total_votes: totalVotes,
      volume_usdc: volumeUsdc,
      history,
    });
  } catch (e) {
    console.error("Error in /api/markets/:id/history:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Healyum running on port ${PORT}`);
});

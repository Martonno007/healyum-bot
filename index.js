require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const cors = require("cors");

// In Node 18+ fetch è globale. Se usi una versione più vecchia su Render,
// installa "node-fetch" e importa fetch manualmente.

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

// simbolo stock reale (Tesla)
const STOCK_SYMBOL = "TSLA";

// ---------- UTILS BASE TIMEZONE ----------

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
 * Calcola da quanto tempo il mercato è aperto (in minuti) a partire da opened_at.
 */
function getMinutesSinceOpened(market) {
  if (!market.opened_at) return null;
  const opened = new Date(market.opened_at);
  const diffMs = Date.now() - opened.getTime();
  return Math.floor(diffMs / 60000);
}

// ---------- UTIL STOCK PRICE (TSLA REALE) ----------

/**
 * Legge il prezzo corrente di TSLA da Yahoo Finance.
 * Usa l'endpoint pubblico chart.
 */
async function fetchStockPrice() {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${STOCK_SYMBOL}?interval=1m&range=1d`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("TSLA price HTTP error:", res.status, res.statusText);
      return null;
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice;

    if (typeof price !== "number") {
      console.error("TSLA price not found in Yahoo response");
      return null;
    }

    return price; // prezzo in USD
  } catch (e) {
    console.error("TSLA price fetch error:", e);
    return null;
  }
}

// ---------- MARKET HELPERS ----------

/**
 * Restituisce il market OPEN più recente, se esiste.
 */
async function getActiveMarketIfExists() {
  const { data, error } = await supabase
    .from("markets")
    .select("*")
    .eq("status", "OPEN")
    .order("date", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

/**
 * Ritorna il market OPEN più recente,
 * se non esiste ne crea uno nuovo per la data di oggi (Europe/Rome).
 * Quando lo crea, salva anche il prezzo di apertura TSLA (open_price).
 */
async function getOrCreateActiveMarket() {
  const existing = await getActiveMarketIfExists();
  if (existing) return existing;

  const romeNow = getRomeNow();
  const { id: marketId, dateStr } = getMarketIdForRomeDate(romeNow);
  const openedAt = new Date().toISOString();

  const openPrice = await fetchStockPrice();

  const { data, error } = await supabase
    .from("markets")
    .insert({
      id: marketId,
      underlying: "TSLA",
      date: dateStr,
      status: "OPEN",
      up_pool: 0,
      down_pool: 0,
      opened_at: openedAt,
      open_price: openPrice,
      last_price: openPrice,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
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
        "No active market yet. It will open automatically."
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

    await supabase.from("bets").insert({
      user_id: userId,
      market_id: market.id,
      side,
      stake,
    });

    const newUpPool =
      (Number(market.up_pool) || 0) + (side === "UP" ? stake : 0);
    const newDownPool =
      (Number(market.down_pool) || 0) + (side === "DOWN" ? stake : 0);

    market.up_pool = newUpPool;
    market.down_pool = newDownPool;

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

  const upPool = Number(market.up_pool) || 0;
  const downPool = Number(market.down_pool) || 0;
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

// ---------- CRON ROUTE (una volta al giorno, ES: 00:00 Europe/Rome) ----------
app.get("/cron/daily", async (req, res) => {
  try {
    if (req.query.secret !== CRON_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    const now = new Date();
    const romeNow = getRomeNow(now);

    // Mercato che sta FINENDO (pool precedente)
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

    // 2️⃣ CREA SEMPRE il nuovo mercato OGGI (nuovo pool giornaliero)
    const { data: existingToday } = await supabase
      .from("markets")
      .select("*")
      .eq("id", marketIdToday)
      .single();

    let createdToday = false;

    if (!existingToday) {
      const openPrice = await fetchStockPrice();

      await supabase.from("markets").insert({
        id: marketIdToday,
        underlying: "TSLA",
        date: todayInfo.dateStr,
        status: "OPEN",
        up_pool: 0,
        down_pool: 0,
        opened_at: now.toISOString(),
        open_price: openPrice,
        last_price: openPrice,
      });

      createdToday = true;
      console.log(
        "Created today’s market:",
        marketIdToday,
        "open_price=",
        openPrice
      );
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
 * Restituisce percentuali (0-1), numero voti, volume usdc e prezzi TSLA.
 */
app.get("/api/markets/latest", async (_, res) => {
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

    // prezzo live TSLA
    const livePrice = await fetchStockPrice();
    if (livePrice !== null) {
      await supabase
        .from("markets")
        .update({ last_price: livePrice })
        .eq("id", market.id);
      market.last_price = livePrice;
    }

    res.json({
      id: market.id,
      asset: market.underlying || "TSLA",
      date: market.date,
      status: market.status,
      opened_at: market.opened_at,
      pct_up,
      pct_down,
      total_votes: totalVotes,
      volume_usdc: volumeUsdc,
      open_price: market.open_price ?? null,
      current_price: livePrice,
      wallet_url: null, // se un giorno vuoi linkare TSLAx nel wallet
    });
  } catch (e) {
    console.error("Error in /api/markets/latest", e);
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
    console.error("Error in /api/markets/:id/history", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Healyum running on port ${PORT}`);
});

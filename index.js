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

// ---------- UTILS ----------

/**
 * Ritorna "YYYY-MM-DD" calcolato nel fuso Europe/Rome
 */
function getRomeDateStr(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const [{ value: year }, , { value: month }, , { value: day }] =
    fmt.formatToParts(date);

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
 * ID mercato di oggi in fuso Europe/Rome.
 */
function getMarketIdForTodayRome() {
  return getMarketIdForRomeDate(new Date());
}

/**
 * Crea o ritorna il mercato per "oggi" (fuso Europe/Rome),
 * settando opened_at solo alla creazione.
 */
async function getOrCreateTodayMarket() {
  const { id: marketId, dateStr } = getMarketIdForTodayRome();

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
 * Ritorna il mercato di oggi, se esiste (senza crearlo).
 */
async function getTodayMarketIfExists() {
  const { id: marketId } = getMarketIdForTodayRome();
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
 * Calcola da quanto tempo il mercato è aperto (in minuti) a partire da opened_at.
 */
function getMinutesSinceOpened(market) {
  if (!market.opened_at) return null;
  const opened = new Date(market.opened_at);
  const diffMs = Date.now() - opened.getTime();
  return Math.floor(diffMs / 60000);
}

// ---------- BOT EVENTS ----------
bot.on("polling_error", (err) => console.error("Polling error:", err));

bot.onText(/\/start/, async (msg) => {
  try {
    // opzionale: assicuriamo che il mercato di oggi esista
    await getOrCreateTodayMarket();
  } catch (e) {
    console.error("Error ensuring today market on /start:", e);
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
    const market = await getTodayMarketIfExists();
    if (!market) {
      return bot.sendMessage(
        msg.chat.id,
        "No market for today yet. It will open automatically at the US market open."
      );
    }

    const minutesOpen = getMinutesSinceOpened(market);
    const ageText =
      minutesOpen != null
        ? `Open since ${minutesOpen} minutes.`
        : "Opened_at not set.";

    bot.sendMessage(
      msg.chat.id,
      `📊 Market ${market.id}\nStatus: ${market.status}\nUP pool: ${market.up_pool}\nDOWN pool: ${market.down_pool}\n${ageText}`
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
    const market = await getOrCreateTodayMarket();

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

async function resolveTodayMarket(chatId, winningSide) {
  const market = await getTodayMarketIfExists();
  if (!market) {
    return bot.sendMessage(chatId, "No market for today.");
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

// ---------- CRON ROUTE (chiamata da Google Cron alle 15:30 Europe/Rome) ----------
app.get("/cron/daily", async (req, res) => {
  try {
    if (req.query.secret !== CRON_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    const now = new Date();

    // Oggi e ieri calcolati nel fuso Europe/Rome
    const todayInfo = getMarketIdForRomeDate(now);

    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayInfo = getMarketIdForRomeDate(yesterdayDate);

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

    // 2️⃣ CREA SEMPRE il nuovo mercato OGGI (apertura nuovo pool)
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
app.get("/", (_, res) => res.send("Healyum bot running 🟢"));

app.get("/market/today", async (_, res) => {
  try {
    const market = await getTodayMarketIfExists();
    if (!market) return res.status(404).json({ error: "no market" });

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

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Healyum running on port ${PORT}`);
});

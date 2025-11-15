require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const cors = require("cors");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "dev-secret-change-me";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN mancante nel .env");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ SUPABASE_URL o SUPABASE_SERVICE_KEY mancanti nel .env");
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
const UNDERLYING = "TSLA";
const ROME_TZ = "Europe/Rome";

// ---------- UTILS DATA ----------

// Ritorna "YYYY-MM-DD" per la data in fuso orario Europe/Rome + offset in giorni
function getRomeDateString(offsetDays = 0) {
  const now = new Date();
  // spostiamo di offsetDays
  now.setUTCDate(now.getUTCDate() + offsetDays);

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return fmt.format(now); // es: "2025-11-14"
}

function getMarketIdForDateStr(dateStr) {
  return `${UNDERLYING}-${dateStr}`;
}

// Market di "oggi" in fuso Roma
function getTodayMarketId() {
  return getMarketIdForDateStr(getRomeDateString(0));
}

// Market di "ieri" in fuso Roma
function getYesterdayMarketId() {
  return getMarketIdForDateStr(getRomeDateString(-1));
}

// ---------- UTILS SUPABASE ----------

async function getMarketById(id, columns = "*") {
  const { data, error } = await supabase
    .from("markets")
    .select(columns)
    .eq("id", id)
    .single();

  if (error && error.code !== "PGRST116") {
    // 116 = no rows
    throw error;
  }
  return data || null;
}

async function createOpenMarketForToday() {
  const dateStr = getRomeDateString(0);
  const marketId = getMarketIdForDateStr(dateStr);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("markets")
    .insert({
      id: marketId,
      underlying: UNDERLYING,
      date: dateStr,
      status: "OPEN",
      up_pool: 0,
      down_pool: 0,
      opened_at: nowIso,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Garantisce che il mercato di oggi esista e sia almeno OPEN.
// NON chiude quello di ieri: questo lo fa il cron.
async function getOrCreateTodayOpenMarket() {
  const todayId = getTodayMarketId();
  let market = await getMarketById(todayId);

  if (!market) {
    console.log("[MARKET] Nessun market per oggi, lo creo ora:", todayId);
    market = await createOpenMarketForToday();
  } else if (market.status !== "OPEN") {
    console.log("[MARKET] Market oggi esiste ma non è OPEN, lo riapro:", todayId);
    const nowIso = market.opened_at || new Date().toISOString();
    const { data, error } = await supabase
      .from("markets")
      .update({
        status: "OPEN",
        opened_at: nowIso,
      })
      .eq("id", todayId)
      .select()
      .single();
    if (error) throw error;
    market = data;
  }

  return market;
}

// Chiude hard il mercato di ieri se è ancora OPEN
async function hardLockYesterdayMarket() {
  const yesterdayId = getYesterdayMarketId();
  const market = await getMarketById(yesterdayId);

  if (!market) {
    console.log("[CRON] Nessun market da chiudere per ieri:", yesterdayId);
    return { locked: false, reason: "no_market" };
  }

  if (market.status !== "OPEN") {
    console.log(
      "[CRON] Market di ieri esiste ma non è OPEN, stato attuale:",
      market.status
    );
    return { locked: false, reason: "not_open", status: market.status };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("markets")
    .update({
      status: "LOCKED",
      locked_at: nowIso,
    })
    .eq("id", yesterdayId);

  if (error) throw error;

  console.log("[CRON] Market di ieri LOCKED:", yesterdayId);
  return { locked: true, id: yesterdayId };
}

// ---------- UTENTI / BETS ----------

async function getOrCreateUser(from) {
  const { id, username, first_name } = from;
  await supabase
    .from("users")
    .upsert({ id, username, first_name }, { onConflict: "id" });
  return id;
}

// ---------- BOT EVENTS ----------

bot.on("polling_error", (err) => console.error("Polling error:", err));

bot.onText(/\/start/, (msg) => {
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
    const todayId = getTodayMarketId();
    const market = await getMarketById(
      todayId,
      "id,status,up_pool,down_pool,opened_at,locked_at"
    );

    if (!market) {
      return bot.sendMessage(
        msg.chat.id,
        `No market yet for today (${todayId}).`
      );
    }

    bot.sendMessage(
      msg.chat.id,
      `📊 Market ${market.id}\nStatus: ${market.status}\nUP pool: ${market.up_pool}\nDOWN pool: ${market.down_pool}\nOpened at: ${market.opened_at || "n/a"}`
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
    const market = await getOrCreateTodayOpenMarket();

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

// ---------- RESOLUTION LOGIC (manuale via /resolve_up /resolve_down) ----------

async function resolveTodayMarket(chatId, winningSide) {
  const todayId = getTodayMarketId();

  const market = await getMarketById(todayId);
  if (!market) {
    return bot.sendMessage(chatId, `No market for today (${todayId}).`);
  }

  const { data: bets, error: betsErr } = await supabase
    .from("bets")
    .select("*")
    .eq("market_id", todayId);

  if (betsErr) {
    console.error(betsErr);
    return bot.sendMessage(chatId, "❌ Error reading bets.");
  }

  const upPool = market.up_pool;
  const downPool = market.down_pool;
  const totalPool = upPool + downPool;
  const winnersPool = winningSide === "UP" ? upPool : downPool;

  const distributable = totalPool * (1 - FEE);
  const multiplier = winnersPool > 0 ? distributable / winnersPool : 0;

  for (const bet of bets) {
    if (bet.side === winningSide && winnersPool > 0) {
      const payout = bet.stake * multiplier;
      await supabase
        .from("bets")
        .update({ payout })
        .eq("id", bet.id);
      bot.sendMessage(
        bet.user_id,
        `🎉 You WON on ${todayId}! Payout: ${payout.toFixed(2)}`
      );
    }
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("markets")
    .update({ status: "RESOLVED", resolved_at: nowIso })
    .eq("id", todayId);

  if (updErr) {
    console.error(updErr);
    return bot.sendMessage(chatId, "❌ Error updating market status.");
  }

  bot.sendMessage(chatId, `Market ${todayId} resolved as ${winningSide}.`);
}

// ---------- EXPRESS API ----------

// Healthcheck
app.get("/", (_, res) => res.send("Healyum bot running 🟢"));

// Usato dalla mini-app per leggere il market corrente
app.get("/market/today", async (_, res) => {
  try {
    const todayId = getTodayMarketId();
    const market = await getMarketById(
      todayId,
      "id,status,up_pool,down_pool,opened_at"
    );

    if (!market) {
      return res.status(404).json({ error: "no market" });
    }

    res.json(market);
  } catch (e) {
    console.error("Error /market/today:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- CRON GIORNALIERO ----------
// Da chiamare una volta al giorno alle 15:30 (ora di Roma) con:
// POST https://healyum-bot.onrender.com/cron/daily?secret=TUO_CRON_SECRET
app.post("/cron/daily", async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    // 1) chiudi (LOCKED) il mercato di ieri se era ancora OPEN
    const lockResult = await hardLockYesterdayMarket();

    // 2) apri/assicurati OPEN il mercato di oggi
    const todayMarket = await getOrCreateTodayOpenMarket();

    res.json({
      ok: true,
      lock: lockResult,
      todayMarketId: todayMarket.id,
      todayStatus: todayMarket.status,
    });
  } catch (e) {
    console.error("Error /cron/daily:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Healyum running on port ${PORT}`);
});

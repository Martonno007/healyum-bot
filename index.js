require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const cors = require("cors");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
const WEB_APP_URL = "https://healyum-miniapp-cmdb.vercel.app/";
const FEE = 0.02;

// ---------- UTILS ----------
function getTodayMarketId() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `TSLA-${today}`;
}

async function getOrCreateUser(from) {
  const { id, username, first_name } = from;
  await supabase
    .from("users")
    .upsert({ id, username, first_name }, { onConflict: "id" });
  return id;
}

async function getOrCreateTodayMarket() {
  const marketId = getTodayMarketId();

  let { data: market, error } = await supabase
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .single();

  if (!market) {
    const { data, error: insErr } = await supabase
      .from("markets")
      .insert({
        id: marketId,
        underlying: "TSLA",
        date: new Date().toISOString().slice(0, 10),
        status: "OPEN",
        up_pool: 0,
        down_pool: 0,
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
    const marketId = getTodayMarketId();
    const { data: market } = await supabase
      .from("markets")
      .select("id,status,up_pool,down_pool")
      .eq("id", marketId)
      .single();

    if (!market) {
      return bot.sendMessage(
        msg.chat.id,
        `No market yet for ${marketId}. Place a bet first.`
      );
    }

    bot.sendMessage(
      msg.chat.id,
      `📊 Market ${market.id}\nStatus: ${market.status}\nUP pool: ${market.up_pool}\nDOWN pool: ${market.down_pool}`
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

// ---------- RESOLUTION LOGIC ----------
async function resolveTodayMarket(chatId, winningSide) {
  const marketId = getTodayMarketId();

  const { data: market } = await supabase
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .single();

  const { data: bets } = await supabase
    .from("bets")
    .select("*")
    .eq("market_id", marketId);

  const upPool = market.up_pool;
  const downPool = market.down_pool;
  const totalPool = upPool + downPool;
  const winnersPool = winningSide === "UP" ? upPool : downPool;

  const distributable = totalPool * (1 - FEE);
  const multiplier = distributable / winnersPool;

  for (const bet of bets) {
    if (bet.side === winningSide) {
      const payout = bet.stake * multiplier;
      await supabase
        .from("bets")
        .update({ payout })
        .eq("id", bet.id);
      bot.sendMessage(
        bet.user_id,
        `🎉 You WON on ${marketId}! Payout: ${payout.toFixed(2)}`
      );
    }
  }

  await supabase
    .from("markets")
    .update({ status: "RESOLVED", resolved_at: new Date().toISOString() })
    .eq("id", marketId);

  bot.sendMessage(chatId, `Market ${marketId} resolved.`);
}

// ---------- EXPRESS API ----------
app.get("/", (_, res) => res.send("Healyum bot running 🟢"));

app.get("/market/today", async (_, res) => {
  const marketId = getTodayMarketId();
  const { data: market } = await supabase
    .from("markets")
    .select("id,status,up_pool,down_pool")
    .eq("id", marketId)
    .single();

  if (!market) return res.status(404).json({ error: "no market" });

  res.json(market);
});

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Healyum running on port ${PORT}`);
});

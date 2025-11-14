require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// ---------- SUPABASE ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // service key
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_KEY mancanti nel .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ---------- TELEGRAM ----------
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN mancante nel .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();

const WEB_APP_URL = 'https://healyum-miniapp-cmdb.vercel.app/';
const FEE = 0.02; // 2%

// ---------- UTILS ----------
function getTodayMarketId() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `TSLA-${today}`;
}

async function getOrCreateUser(from) {
  const { id, username, first_name } = from;

  await supabase
    .from('users')
    .upsert({ id, username, first_name }, { onConflict: 'id' });

  return id;
}

async function getOrCreateTodayMarket() {
  const marketId = getTodayMarketId();

  let { data: market, error } = await supabase
    .from('markets')
    .select('*')
    .eq('id', marketId)
    .single();

  if (!market) {
    const { data, error: insErr } = await supabase
      .from('markets')
      .insert({
        id: marketId,
        underlying: 'TSLA',
        date: new Date().toISOString().slice(0, 10),
        status: 'OPEN',
        up_pool: 0,
        down_pool: 0
      })
      .select()
      .single();

    if (insErr) throw insErr;
    market = data;
  } else if (error && error.code !== 'PGRST116') {
    // PGRST116 = "row not found"
    throw error;
  }

  return market;
}

// ---------- BOT EVENTS ----------
bot.on('polling_error', (err) => console.error('Polling error:', err));

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '⚡ Welcome to Healyum!\nPredict Tesla: will it go UP or DOWN?',
    {
      reply_markup: {
        keyboard: [[
          {
            text: '🚀 Open Healyum Mini-App',
            web_app: { url: WEB_APP_URL }
          }
        ]],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

// /status → mostra il pool del mercato di oggi (da DB)
bot.onText(/\/status/, async (msg) => {
  try {
    const marketId = getTodayMarketId();
    const { data: market } = await supabase
      .from('markets')
      .select('id,status,up_pool,down_pool')
      .eq('id', marketId)
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
    bot.sendMessage(msg.chat.id, '❌ Error loading market status.');
  }
});

// /resolve_up e /resolve_down → risolvi mercato di oggi
bot.onText(/\/resolve_(up|down)/, async (msg, match) => {
  const winningSide = match[1].toUpperCase(); // UP o DOWN
  await resolveTodayMarket(msg.chat.id, winningSide);
});

// Messaggi + web_app_data
bot.on('message', async (msg) => {
  console.log('New message:', JSON.stringify(msg, null, 2));

  if (msg.web_app_data && msg.web_app_data.data) {
    await handleWebAppData(msg);
  }
});

// ---------- WEBAPP HANDLER (BET) ----------
async function handleWebAppData(msg) {
  try {
    const payload = JSON.parse(msg.web_app_data.data);
    console.log('Parsed web_app_data:', payload);

    if (payload.type !== 'BET') return;

    const rawSide = payload.side;
    const side = rawSide === 'TESLA_UP' ? 'UP' : 'DOWN';
    const stake = Number(payload.stake || 1);

    const userId = await getOrCreateUser(msg.from);
    const market = await getOrCreateTodayMarket();

    if (market.status !== 'OPEN') {
      return bot.sendMessage(msg.chat.id, `❌ Market ${market.id} is not open.`);
    }

    // salva bet
    const { error: betError } = await supabase.from('bets').insert({
      user_id: userId,
      market_id: market.id,
      side,
      stake
    });
    if (betError) throw betError;

    // aggiorna pool nel DB
    const isUp = side === 'UP';
    const newUpPool = Number(market.up_pool) + (isUp ? stake : 0);
    const newDownPool = Number(market.down_pool) + (!isUp ? stake : 0);

    const { error: updError } = await supabase
      .from('markets')
      .update({
        up_pool: newUpPool,
        down_pool: newDownPool
      })
      .eq('id', market.id);
    if (updError) throw updError;

    bot.sendMessage(
      msg.chat.id,
      `Got it ✅ You chose ${side} with stake ${stake} on ${market.id}\nCurrent pool → UP: ${newUpPool} | DOWN: ${newDownPool}`
    );
  } catch (e) {
    console.error('Error in handleWebAppData', e);
    bot.sendMessage(msg.chat.id, '❌ Error saving your bet.');
  }
}

// ---------- RESOLUTION LOGIC (DB) ----------
async function resolveTodayMarket(chatId, winningSide) {
  const marketId = getTodayMarketId();

  const { data: market, error: mErr } = await supabase
    .from('markets')
    .select('*')
    .eq('id', marketId)
    .single();
  if (mErr || !market) {
    return bot.sendMessage(chatId, `No market found for ${marketId}`);
  }
  if (market.status === 'RESOLVED') {
    return bot.sendMessage(chatId, `Market ${marketId} already resolved.`);
  }

  const { data: bets, error: bErr } = await supabase
    .from('bets')
    .select('*')
    .eq('market_id', marketId);
  if (bErr) {
    console.error(bErr);
    return bot.sendMessage(chatId, 'Error loading bets.');
  }
  if (!bets.length) {
    await supabase.from('markets').update({ status: 'RESOLVED' }).eq('id', marketId);
    return bot.sendMessage(chatId, `Market ${marketId} has no bets.`);
  }

  const upPool = Number(market.up_pool);
  const downPool = Number(market.down_pool);
  const totalPool = upPool + downPool;

  const winnersPool = winningSide === 'UP' ? upPool : downPool;
  const losersPool = totalPool - winnersPool;

  if (winnersPool === 0) {
    await supabase.from('markets').update({ status: 'RESOLVED' }).eq('id', marketId);
    return bot.sendMessage(chatId, `No winners on side ${winningSide} for market ${marketId}.`);
  }

  const distributable = totalPool * (1 - FEE);
  const multiplier = distributable / winnersPool;

  let summary = `✅ Market ${marketId} resolved. Winning side: ${winningSide}\n\n`;
  summary += `Total pool: ${totalPool}\nWinners pool: ${winnersPool}\nLosers pool: ${losersPool}\nMultiplier: x${multiplier.toFixed(3)}\n\nPayouts:\n`;

  for (const bet of bets) {
    if (bet.side === winningSide) {
      const winAmount = Number(bet.stake) * multiplier;

      await supabase
        .from('bets')
        .update({ payout: winAmount })
        .eq('id', bet.id);

      summary += `• User ${bet.user_id}: +${winAmount.toFixed(2)}\n`;
      bot.sendMessage(
        bet.user_id,
        `🎉 You WON on ${marketId} (${winningSide})!\nStake: ${bet.stake}\nPayout: ${winAmount.toFixed(2)}`
      );
    } else {
      summary += `• User ${bet.user_id}: lost ${bet.stake}\n`;
    }
  }

  await supabase
    .from('markets')
    .update({ status: 'RESOLVED', resolved_at: new Date().toISOString() })
    .eq('id', marketId);

  bot.sendMessage(chatId, summary);
}

// ---------- EXPRESS API ----------
app.get('/', (_, res) => res.send('Healyum bot running 🟢'));

app.get('/market/today', async (_, res) => {
  const marketId = getTodayMarketId();
  const { data: market } = await supabase
    .from('markets')
    .select('id,status,up_pool,down_pool')
    .eq('id', marketId)
    .single();

  if (!market) return res.status(404).json({ error: 'no market' });

  res.json(market);
});

app.listen(3000, () => console.log('Server Healyum running on port 3000'));

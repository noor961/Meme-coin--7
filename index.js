const { Telegraf } = require('telegraf');
const { TwitterApi } = require('twitter-api-v2');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Raydium } = require('@raydium-io/raydium-sdk-v2');
const axios = require('axios');
const natural = require('natural');
const winston = require('winston');

// إعداد التسجيل (Logging)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// إعداد Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// إعداد Twitter Client
const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// إعداد Solana Connection
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
let wallet;
try {
  wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PHANTOM_PRIVATE_KEY)));
} catch (error) {
  logger.error('Failed to load wallet:', error);
  process.exit(1);
}

// إعداد Raydium
const raydium = new Raydium({ connection });

// إعداد تحليل المشاعر
const sentimentAnalyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn');
const tokenizer = new natural.WordTokenizer();

// متغيرات لتتبع العمليات
const trackedCoins = new Map(); // { coin: { buyPrice, targetMultiplier, amount } }
let dailyOperations = 0;
const MAX_DAILY_OPERATIONS = 5; // 5 عمليات (شراء ثم بيع) يوميًا
const TARGET_MULTIPLIER_MIN = 2; // 2x
const TARGET_MULTIPLIER_MAX = 5; // 5x
const MARKET_CAP_THRESHOLD = 5000; // رأس مال سوقي حول 5000 دولار

// وظيفة لتحليل التغريدات وتحديد العملات الناشئة
async function analyzeTweets() {
  try {
    const tweets = await twitterClient.v2.search('#memeCoin');
    const potentialCoins = [];

    for await (const tweet of tweets) {
      const tokens = tokenizer.tokenize(tweet.text);
      const sentiment = sentimentAnalyzer.getSentiment(tokens);

      // تجنب العملات المخادعة
      if (sentiment < 0 || tweet.text.toLowerCase().includes('scam') || tweet.text.toLowerCase().includes('rug')) {
        logger.warn(`Skipping suspicious tweet: ${tweet.text}`);
        continue;
      }

      // استخراج العملات المحتملة (مثال: $TOKEN)
      const coinMatch = tweet.text.match(/\$[A-Z]+/);
      if (coinMatch) {
        const coin = coinMatch[0];
        potentialCoins.push({ coin, sentiment, tweet: tweet.text });
      }
    }

    // ترتيب العملات حسب المشاعر
    return potentialCoins.sort((a, b) => b.sentiment - a.sentiment);
  } catch (error) {
    logger.error('Error analyzing tweets:', error);
    return [];
  }
}

// وظيفة لجلب بيانات العملة (السعر ورأس المال السوقي)
async function getCoinData(coin) {
  try {
    // استخدام DexScreener API (مثال افتراضي)
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${coin.toLowerCase().replace('$', '')}`);
    const data = response.data.pairs?.[0];
    if (!data) return null;

    const price = data.priceUsd || 0;
    const marketCap = data.marketCap || 0;
    logger.info(`Fetched data for ${coin}: Price $${price}, Market Cap $${marketCap}`);
    return { price, marketCap };
  } catch (error) {
    logger.error(`Error fetching data for ${coin}:`, error);
    return null;
  }
}

// وظيفة للشراء على Raydium (مثال مبسط)
async function buyCoin(coin, amountInSol) {
  try {
    const coinData = await getCoinData(coin);
    if (!coinData) {
      bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Cannot buy ${coin}: Data not available.`);
      return false;
    }

    const { price, marketCap } = coinData;

    // التحقق من رأس المال السوقي
    if (marketCap > MARKET_CAP_THRESHOLD * 1.5 || marketCap < MARKET_CAP_THRESHOLD * 0.5) {
      bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Cannot buy ${coin}: Market Cap ($${marketCap}) not around $${MARKET_CAP_THRESHOLD}.`);
      return false;
    }

    // التحقق من السعر (شراء بسعر منخفض)
    if (price > 0.01) {
      bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Price of ${coin} ($${price}) is too high to buy.`);
      return false;
    }

    // تنفيذ معاملة شراء
    logger.info(`Buying ${amountInSol} SOL worth of ${coin} at $${price}`);
    bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Buying ${amountInSol} SOL worth of ${coin} at $${price}...`);
    trackedCoins.set(coin, { buyPrice: price, targetMultiplier: TARGET_MULTIPLIER_MIN, amount: amountInSol });
    dailyOperations++;
    return true;
  } catch (error) {
    logger.error(`Error buying ${coin}:`, error);
    bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Error buying ${coin}.`);
    return false;
  }
}

// وظيفة للبيع على Raydium (مثال مبسط)
async function sellCoin(coin) {
  try {
    const coinData = await getCoinData(coin);
    if (!coinData) return false;

    const currentPrice = coinData.price;
    const { buyPrice, targetMultiplier, amount } = trackedCoins.get(coin);

    if (currentPrice >= buyPrice * targetMultiplier) {
      logger.info(`Selling ${coin} at $${currentPrice} (Bought at $${buyPrice})`);
      bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Selling ${coin} at $${currentPrice} (Bought at $${buyPrice})! Profit: ${((currentPrice - buyPrice) / buyPrice * 100).toFixed(2)}%`);
      trackedCoins.delete(coin);
      dailyOperations++;
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`Error selling ${coin}:`, error);
    bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Error selling ${coin}.`);
    return false;
  }
}

// وظيفة دورية لتحليل العملات وتنفيذ العمليات
async function runDailyOperations() {
  if (dailyOperations >= MAX_DAILY_OPERATIONS * 2) {
    logger.info('Daily operation limit reached');
    return;
  }

  // تحليل العملات
  const coins = await analyzeTweets();
  if (coins.length === 0) {
    bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, 'No promising meme coins found.');
    return;
  }

  // اختيار أفضل عملة
  const topCoin = coins[0];
  const coinData = await getCoinData(topCoin.coin.replace('$', ''));
  if (!coinData) return;

  const { price, marketCap } = coinData;
  bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `Top Meme Coin: ${topCoin.coin}\nSentiment: ${topCoin.sentiment}\nPrice: $${price}\nMarket Cap: $${marketCap}\nTweet: ${topCoin.tweet}`);

  // شراء إذا كان السعر منخفض ورأس المال السوقي مناسب
  if (price > 0 && price < 0.01 && marketCap >= MARKET_CAP_THRESHOLD * 0.5 && marketCap <= MARKET_CAP_THRESHOLD * 1.5) {
    await buyCoin(topCoin.coin.replace('$', ''), 0.1); // شراء بقيمة 0.1 SOL
  }

  // مراقبة الأسعار والبيع
  for (const [coin] of trackedCoins) {
    const sold = await sellCoin(coin);
    if (sold) {
      logger.info(`Successfully sold ${coin}`);
    }
  }
}

// تشغيل دوري كل 4 ساعات (لتحقيق 5 عمليات يوميًا)
setInterval(runDailyOperations, 4 * 60 * 60 * 1000); // كل 4 ساعات
runDailyOperations(); // تشغيل فوري عند البدء

// أوامر Telegram
bot.start((ctx) => ctx.reply('Welcome to Meme Coin Bot!'));
bot.command('status', (ctx) => {
  ctx.reply(`Daily Operations: ${dailyOperations}/${MAX_DAILY_OPERATIONS * 2}\nTracked Coins: ${trackedCoins.size}`);
});

// معالجة الأخطاء
bot.catch((err, ctx) => {
  logger.error(`Error in Telegram bot: ${err}`);
  ctx.reply('An error occurred. Please try again later.');
});

// تشغيل البوت
bot.launch();
logger.info('Bot is running!');

// معالجة إغلاق التطبيق
process.on('SIGINT', () => {
  logger.info('Bot stopped');
  bot.stop();
  process.exit();
});

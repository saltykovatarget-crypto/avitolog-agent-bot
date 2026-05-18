require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic   = require("@anthropic-ai/sdk");
const { detectRoute } = require("./router");
const { getContextCases, getCaseTemplate, getTenSteps } = require("./cases");

// ─── Агенты ───────────────────────────────────────────────────────────────────
const AGENTS = {
  smm:                require("./agents/smm"),
  editor:             require("./agents/editor"),
  scriptwriter:       require("./agents/scriptwriter"),
  analyst:            require("./agents/analyst"),
  sales:              require("./agents/sales"),
  seo:                require("./agents/seo"),
  ideas:              require("./agents/ideas"),
  competitor:         require("./agents/competitor"),
  "content-director": require("./agents/content-director"),
  "case-writer":      require("./agents/case-writer"),
  "product-marketer": require("./agents/product-marketer"),
  community:          require("./agents/community"),
  onboarding:         require("./agents/onboarding"),
  "lead-magnet":      require("./agents/lead-magnet"),
  visual:             require("./agents/visual"),
  "office-hours":     require("./agents/office-hours"),
  chesky:             require("./agents/chesky"),
  adversarial:        require("./agents/adversarial"),
  paranoid:           require("./agents/paranoid"),
};

// ─── Конфиг ───────────────────────────────────────────────────────────────────
const TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const bot       = new TelegramBot(TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

console.log("🤖 Bot started. Allowed:", ALLOWED_IDS);

// ─── In-memory хранилище ──────────────────────────────────────────────────────
const histories   = new Map();
const ideasStore  = new Map();
const competStore = new Map();
const stopFlags   = new Set();
const lastResults = new Map(); // chatId → { text, request } для регенерации

// ─── Клавиатуры ───────────────────────────────────────────────────────────────
const MAIN_KB = {
  keyboard: [
    [{ text: "✍️ Пост" },       { text: "🎬 Reels" },       { text: "📋 Кейс" }],
    [{ text: "🕵️ Конкуренты" }, { text: "📰 Мониторинг" },  { text: "💡 Идеи" }],
    [{ text: "🗓 План недели" }, { text: "💰 Продажи" },     { text: "🎨 Визуал" }],
    [{ text: "⭐️ Сделай круче" },{ text: "🔨 QA-разбор" },  { text: "🆕 Новый чат" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

const BUTTON_MAP = {
  "✍️ Пост":         "напиши пост",
  "🎬 Reels":         "сценарий reels",
  "📋 Кейс":          "напиши кейс",
  "🔍 SEO статья":    "статья дзен",
  "🕵️ Конкуренты":   "/competitors",
  "📰 Мониторинг":   "/monitor",
  "💡 Идеи":         "/ideas",
  "🗓 План недели":   "план на неделю",
  "💰 Продажи":      "продающий оффер",
  "🎨 Визуал":       "обложка баннер",
  "⭐️ Сделай круче": "сделай круче:",
  "🔨 QA-разбор":    "сломай:",
  "🆕 Новый чат":    "/new",
};

function postActionsKb(chatId) {
  const kb = [
    [
      { text: "↻ Другой вариант", callback_data: `regen_${chatId}` },
      { text: "🔨 QA-разбор",     callback_data: `qa_${chatId}` },
    ],
    [
      { text: "⭐️ Сделай круче",  callback_data: `chesky_${chatId}` },
      { text: "💾 Сохранить идею", callback_data: `saveidea_${chatId}` },
    ],
    [
      { text: "🎨 Фото-баннер",      callback_data: `image_${chatId}` },
      { text: "🖼 Текст-баннер",      callback_data: `banner_${chatId}` },
    ],
  ];
  if (process.env.CHANNEL_ID) {
    kb.push([{ text: "📢 Опубликовать в канал", callback_data: `publish_${chatId}` }]);
  }
  return { inline_keyboard: kb };
}

const DEFAULT_COMPETITORS = [
  { name: "Горбачев",           username: "avitolog_gorbachev" },
  { name: "Ларцев",             username: "ivan_lartsev" },
  { name: "Avito for Agency",   username: "avitoforagency" },
  { name: "АвиГрупп66",         username: "avitologi_avigroup66" },
  { name: "Екимов",             username: "ekimov_calculator" },
  { name: "Авито без секретов", username: "avito_bez_secretov" },
  { name: "Авито блог",         username: "avitoblog" },
];

// ─── Telegram helpers ─────────────────────────────────────────────────────────
async function send(chatId, text, extra = {}) {
  const chunks = String(text).match(/[\s\S]{1,4000}/g) || [text];
  for (let i = 0; i < chunks.length; i++) {
    const opts = i === chunks.length - 1 ? { reply_markup: MAIN_KB, ...extra } : {};
    await bot.sendMessage(chatId, chunks[i], opts).catch(() => {});
  }
}

async function sendResult(chatId, text) {
  const chunks = String(text).match(/[\s\S]{1,4000}/g) || [text];
  for (let i = 0; i < chunks.length - 1; i++) {
    // Пробуем с Markdown, если сломается — шлём plain
    await bot.sendMessage(chatId, chunks[i], { parse_mode: "Markdown" })
      .catch(() => bot.sendMessage(chatId, chunks[i]).catch(() => {}));
  }
  // Последний чанк — с inline кнопками действий
  await bot.sendMessage(chatId, chunks[chunks.length - 1], {
    parse_mode: "Markdown",
    reply_markup: postActionsKb(chatId),
  }).catch(() =>
    // Fallback без Markdown если есть незакрытые символы
    bot.sendMessage(chatId, chunks[chunks.length - 1], {
      reply_markup: postActionsKb(chatId),
    }).catch(() => {})
  );
}

async function sendWithStop(chatId, text) {
  const r = await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "🛑 Стоп", callback_data: `stop_${chatId}` }]] }
  }).catch(() => null);
  return r?.message_id;
}

async function editMsg(chatId, msgId, text, done = false) {
  await bot.editMessageText(text, {
    chat_id: chatId, message_id: msgId,
    reply_markup: done ? { inline_keyboard: [] }
      : { inline_keyboard: [[{ text: "🛑 Стоп", callback_data: `stop_${chatId}` }]] },
  }).catch(() => {});
}

// ─── Конвертация Markdown → Telegram формат ───────────────────────────────────
function toTgMarkdown(text) {
  return String(text)
    // **жирный** → *жирный*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // ### Заголовок → *Заголовок*
    .replace(/^#{1,4}\s+(.+)$/gm, "*$1*")
    // --- разделители → пустая строка
    .replace(/^---+$/gm, "")
    // __ курсив __ → _курсив_
    .replace(/__(.+?)__/g, "_$1_")
    // убираем лишние пустые строки (3+ → 2)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Claude ───────────────────────────────────────────────────────────────────
async function claude(system, content, history = []) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6", max_tokens: 2000, system,
    messages: [...history, { role: "user", content }],
  });
  return msg.content[0].text;
}

const PLAT_SYSTEM = "Ты — SMM-редактор. Адаптируй пост под три платформы. Без вступлений.";
const platPrompt  = post =>
  `ПОСТ:\n${post}\n\nВерни три блока:\n\nTELEGRAM\n[хук 2 строки, эмодзи ➡️📌⚡️💜, #авито #авитолог, подпись: 💜 AI Авитолог | Валерия]\n\nВКОНТАКТЕ\n[10-20 строк, #авито #авитопродвижение]\n\nТЕНЧАТ\n[деловой тон, без хэштегов, 15-25 строк]`;

// ─── История ──────────────────────────────────────────────────────────────────
const getHistory   = id => histories.get(String(id)) || [];
const clearHistory = id => histories.delete(String(id));
function appendHistory(id, u, a) {
  const h = getHistory(id);
  h.push({ role: "user", content: String(u).slice(0, 2000) });
  h.push({ role: "assistant", content: String(a).slice(0, 4000) });
  if (h.length > 20) h.splice(0, h.length - 20);
  histories.set(String(id), h);
}

// ─── Генератор баннеров (sharp) ───────────────────────────────────────────────
const sharp = require("sharp");

function wrapLines(text, maxChars = 24) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length > maxChars && line) { lines.push(line.trim()); line = w + " "; }
    else line += w + " ";
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function escapeXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function createBanner(headline, subtitle = "", width = 1280, height = 720) {
  const headLines = wrapLines(headline, Math.floor(width / 52));
  const lineH = Math.min(96, Math.floor((height * 0.55) / Math.max(headLines.length, 1)));
  const startY = Math.floor((height - headLines.length * lineH - (subtitle ? 60 : 0)) / 2);
  const fontSize = Math.max(44, Math.min(88, lineH - 8));

  const headSvg = headLines.map((l, i) =>
    `<text x="${width/2}" y="${startY + i * lineH}"
      text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold"
      font-size="${fontSize}" fill="white">${escapeXml(l)}</text>`
  ).join("\n");

  const subSvg = subtitle
    ? `<text x="${width/2}" y="${startY + headLines.length * lineH + 10}"
        text-anchor="middle" font-family="Arial,sans-serif" font-size="34"
        fill="rgba(255,255,255,0.82)">${escapeXml(subtitle)}</text>`
    : "";

  // Декоративные волны
  const wave1 = `<ellipse cx="${width*0.1}" cy="${height*0.15}" rx="${width*0.35}" ry="${height*0.22}"
    fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>`;
  const wave2 = `<ellipse cx="${width*0.9}" cy="${height*0.85}" rx="${width*0.3}" ry="${height*0.2}"
    fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>`;

  const signSvg = `<text x="${width - 50}" y="${height - 35}"
    text-anchor="end" font-family="Arial,sans-serif" font-style="italic"
    font-size="26" fill="rgba(255,255,255,0.70)">AI Авитолог | Валерия Салтыкова</text>`;

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${wave1}${wave2}
    ${headSvg}
    ${subSvg}
    ${signSvg}
  </svg>`;

  return await sharp({
    create: { width, height, channels: 4, background: { r: 139, g: 92, b: 246, alpha: 1 } }
  })
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png()
  .toBuffer();
}

async function sendBanner(chatId, headline, subtitle = "") {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const buf = await createBanner(headline, subtitle);
    await bot.sendPhoto(chatId, buf, {
      caption: `🖼 Баннер готов\n\n*${escapeXml(headline)}*${subtitle ? "\n" + subtitle : ""}`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "📐 Квадрат 1080×1080", callback_data: `bsq_${chatId}` },
          { text: "↻ С другим текстом",  callback_data: `bnew_${chatId}` },
        ]]
      }
    });
    lastResults.set(`banner_${chatId}`, { headline, subtitle });
  } catch (e) {
    console.error("Banner error:", e.message);
    await send(chatId, "⚠️ Не удалось создать баннер.");
  }
}

// ─── Идеи ─────────────────────────────────────────────────────────────────────
const getIdeas = id => ideasStore.get(String(id)) || [];
const MINI_APP_SYNC = "https://marketing-coach-avito.netlify.app/.netlify/functions/sync";

async function syncToMiniApp(userId, ideas) {
  await fetch(MINI_APP_SYNC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(userId), key: "ideas", data: ideas }),
  });
}

function saveIdea(id, text) {
  const list = getIdeas(id);
  list.unshift({ text, date: new Date().toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) });
  if (list.length > 100) list.splice(100);
  ideasStore.set(String(id), list);
}

// ─── Генерация изображений (Pollinations.ai — бесплатно) ─────────────────────

const IMAGE_SYSTEM = `Ты — генератор промптов для изображений бренда AI Авитолог PRO.
Бренд: фиолетовый #8B5CF6, тёмный фон #1A1A2E, белый текст, Inter/Montserrat шрифт, минимализм, технологично.
По теме поста напиши ОДИН короткий промпт на английском для баннера БЕЗ ТЕКСТА на картинке.
Только сам промпт, без пояснений. Максимум 180 символов.
Обязательно включи: purple #8B5CF6, dark background #1A1A2E, minimalist tech aesthetic, no text, professional.`;

async function generateImage(prompt, width = 1280, height = 720) {
  const brand = "purple #8B5CF6 accent, dark background #1A1A2E, minimalist tech, professional, no text, no watermark";
  const encoded = encodeURIComponent(prompt + ", " + brand);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&model=flux&nologo=true&seed=${Date.now()}`;
}

async function sendImageForPost(chatId, postText) {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const prompt = await claude(IMAGE_SYSTEM, `Тема поста:\n${postText.slice(0, 500)}`);
    const url = await generateImage(prompt.trim());
    await bot.sendPhoto(chatId, url, {
      caption: `🎨 Баннер к посту\n\nПромпт: ${prompt.trim()}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "↻ Другой вариант", callback_data: `newimg_${chatId}` },
          { text: "📐 Квадрат 1:1",   callback_data: `imgsq_${chatId}` },
        ]]
      }
    }).catch(async () => {
      // Если Telegram не смог загрузить — шлём ссылку
      await send(chatId, `🎨 Баннер: ${url}\n\nПромпт: ${prompt.trim()}`);
    });
    // Сохраняем промпт для повторной генерации
    lastResults.set(`img_${chatId}`, { prompt: prompt.trim() });
  } catch (e) {
    await send(chatId, "⚠️ Не удалось сгенерировать. Попробуй ещё раз.");
  }
}

// ─── Конкуренты ───────────────────────────────────────────────────────────────
const getCompetitors = id => competStore.get(String(id)) || [...DEFAULT_COMPETITORS];
function addCompetitor(id, username) {
  const list = getCompetitors(id), clean = username.replace(/^@/, "");
  if (list.find(c => c.username === clean)) return false;
  list.push({ name: clean, username: clean });
  competStore.set(String(id), list); return true;
}
function removeCompetitor(id, username) {
  const clean = username.replace(/^@/, "");
  const list  = getCompetitors(id).filter(c => c.username !== clean);
  competStore.set(String(id), list);
}
async function scrapeChannel(username) {
  try {
    const res  = await fetch(`https://t.me/s/${username}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    const posts= []; const re = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(html)) !== null && posts.length < 5) {
      const t = m[1].replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"")
        .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
      if (t.length > 30) posts.push(t.slice(0, 500));
    }
    return posts;
  } catch { return []; }
}

// ─── Мониторинг новостей — реальные источники ────────────────────────────────

function parseRSS(xml, sourceName, limit = 4) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const raw     = m[1];
    const titleM  = raw.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const dateM   = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const title   = (titleM?.[1] || "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
    if (!title || title.length < 5) continue;
    let date = "";
    try { date = dateM?.[1] ? new Date(dateM[1]).toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit" }) : ""; } catch {}
    items.push(`[${sourceName}${date ? " " + date : ""}] ${title}`);
  }
  return items;
}

async function fetchSource(url, name, limit = 4) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    return parseRSS(await res.text(), name, limit);
  } catch { return []; }
}

async function getAvitoNews() {
  const SOURCES = [
    {
      url:  "https://news.google.com/rss/search?q=%D0%90%D0%B2%D0%B8%D1%82%D0%BE+%D0%B0%D0%BB%D0%B3%D0%BE%D1%80%D0%B8%D1%82%D0%BC&hl=ru&gl=RU&ceid=RU:ru",
      name: "Google News",
    },
    {
      url:  "https://news.yandex.ru/search.rss?text=%D0%90%D0%B2%D0%B8%D1%82%D0%BE&lr=213&rss=1",
      name: "Яндекс",
    },
    {
      url:  "https://habr.com/ru/rss/search/posts/?q=%D0%B0%D0%B2%D0%B8%D1%82%D0%BE&target_type=posts&order=date",
      name: "Хабр",
    },
    {
      url:  "https://vc.ru/rss",
      name: "VC.ru",
      filter: "авито",
    },
  ];

  const results = await Promise.all(
    SOURCES.map(s => fetchSource(s.url, s.name))
  );

  // Для VC.ru фильтруем по ключевому слову
  const vcItems = results[3].filter(t => /авито/i.test(t));
  results[3] = vcItems.slice(0, 3);

  const all = results.flat().filter(Boolean);
  return all.length > 0 ? all.join("\n") : null;
}

// ─── Голос (Groq) ─────────────────────────────────────────────────────────────
async function transcribeVoice(fileId) {
  const file = await bot.getFile(fileId);
  const buf  = await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)).arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "ru");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions",
    { method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form });
  return (await r.json()).text || "";
}

// ─── Тексты ───────────────────────────────────────────────────────────────────
const START = `Привет! Я — твоя AI-команда маркетинга 👋

Напиши что нужно:
— «напиши пост про кейс с юристами»
— «сценарий reels про CTR»
— «проверь текст: [вставь]»
— «статья для Дзен про алгоритм Авито»
— «запомни: [идея]»
— «сделай круче: [текст]»   ← Chesky
— «сломай: [текст]»         ← QA-разбор
— «хочу запустить идею»     ← Office Hours

🎙 Голосовые тоже понимаю!

/ideas /monitor /competitors /team /new /stop`;

const TEAM = `Команда (18 специалистов):
✍️ SMM · 📝 Редактор · 🎬 Сценарист · 📊 Аналитик
💰 Продажник · 🔍 SEO · 💡 Заметки · 🕵️ Разведчик
🗓 Контент-директор · 🚀 Продукт · 💬 Комьюнити
🎯 Онбординг · 🧲 Лид-магниты · 🎨 Визуал
🎓 Office Hours · ⭐️ Chesky · 🔨 Adversarial · 🔎 Paranoid

Просто напиши задачу — сам выберу нужного.`;

// ─── Главный обработчик ───────────────────────────────────────────────────────
async function handle(msg) {
  const chatId = msg.chat.id;
  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(chatId)) return;

  let text = msg.text?.trim() || "";

  // Кнопки клавиатуры → маппинг в реальные команды
  if (BUTTON_MAP[text]) text = BUTTON_MAP[text];

  if (msg.voice) {
    if (!process.env.GROQ_API_KEY) { await send(chatId, "🎙 Голосовые не подключены. Напиши текстом."); return; }
    await bot.sendChatAction(chatId, "typing");
    const mid = await sendWithStop(chatId, "🎙 Распознаю...");
    text = await transcribeVoice(msg.voice.file_id).catch(() => "");
    if (!text) { await editMsg(chatId, mid, "❌ Не удалось. Попробуй текстом.", true); return; }
    await editMsg(chatId, mid, `📝 Распознано:\n${text}`, true);
  }

  if (!text) return;

  if (text === "/start")  {
    clearHistory(chatId);
    await bot.sendMessage(chatId, START, { reply_markup: MAIN_KB }).catch(() => {});
    return;
  }
  if (text === "/team")   { await send(chatId, TEAM); return; }
  if (text === "/new")    { clearHistory(chatId); await send(chatId, "🆕 История очищена."); return; }
  if (text === "/myid")   { await send(chatId, `Твой ID: ${chatId}`); return; }
  if (text === "/stop" || /^стоп$/i.test(text)) { stopFlags.add(chatId); await send(chatId, "🛑 Остановлю после шага."); return; }

  if (text === "/ideas" || /мои идеи|мои заметки|покажи идеи/i.test(text)) {
    const list = getIdeas(chatId);
    if (!list.length) { await send(chatId, "📭 Нет идей. Напиши: запомни: [идея]"); return; }
    await send(chatId, `💡 Твои идеи:\n\n${list.slice(0,15).map((x,n)=>`${n+1}. ${x.text}  (${x.date})`).join("\n\n")}\n\n«сделай пост из идей»`);
    return;
  }

  if (text === "/monitor") {
    const mid  = await sendWithStop(chatId, "🔍 Мониторю Google News, Яндекс, Хабр, VC.ru...");
    const news = await getAvitoNews();
    const newsText = news
      ? `Свежие новости про Авито:\n\n${news}`
      : "Новости из внешних источников недоступны.";
    const prompt = news
      ? `Вот свежие новости про Авито из СМИ и блогов:\n${news}\n\nТы авитолог-практик. Предложи 3 конкретных хука для постов на основе этих новостей. Каждый хук — конкретная ситуация или цифра, не тезис.`
      : "Предложи 3 актуальные темы для постов авитолога исходя из трендов рынка 2026 года.";
    const result = await claude(AGENTS.analyst.systemPrompt, prompt);
    await editMsg(chatId, mid, newsText, true);
    await send(chatId, `📊 Идеи для постов:\n\n${result}`);
    return;
  }

  if (text === "/competitors") {
    const list = getCompetitors(chatId);
    const mid  = await sendWithStop(chatId, `🕵️ Мониторю ${list.length} каналов...`);
    const posts= [];
    for (const c of list) {
      await editMsg(chatId, mid, `🕵️ Читаю @${c.username}...`);
      const p = await scrapeChannel(c.username);
      posts.push(`=== ${c.name} ===\n${p.length ? p.join("\n---\n") : "[недоступен]"}`);
    }
    await editMsg(chatId, mid, "🕵️ Анализирую...");
    const analysis = await claude(AGENTS.competitor.systemPrompt,
      `Посты конкурентов:\n\n${posts.join("\n\n")}\n\nДай контентный ответ для Валерии.`);
    await editMsg(chatId, mid, "✅ Готово", true);
    await send(chatId, `🕵️ Анализ:\n\n${analysis}`);
    await send(chatId, `Каналы: ${list.map(c=>"@"+c.username).join(", ")}\nДобавить: добавь конкурента @канал`);
    return;
  }

  if (text === "/список" || /мои конкуренты/i.test(text)) {
    const list = getCompetitors(chatId);
    await send(chatId, `🕵️ Отслеживаю:\n${list.map((c,i)=>`${i+1}. @${c.username}`).join("\n")}\n\nДобавить: добавь конкурента @канал`);
    return;
  }

  const addM = text.match(/^добавь конкурента\s+@?(\S+)/i);
  if (addM) { const ok = addCompetitor(chatId, addM[1]); await send(chatId, ok ? `✅ @${addM[1]} добавлен.` : "Уже есть."); return; }
  const delM = text.match(/^удали конкурента\s+@?(\S+)/i);
  if (delM) { removeCompetitor(chatId, delM[1]); await send(chatId, `🗑 @${delM[1]} удалён.`); return; }

  // 🖼 Баннер: "баннер: Заголовок / Подзаголовок"
  if (/^баннер[\s:]/i.test(text)) {
    const body = text.replace(/^баннер[\s:]*/i, "").trim();
    const [headline, subtitle = ""] = body.split(/\s*\/\s*/);
    if (!headline) { await send(chatId, "Напиши: баннер: Заголовок / Подзаголовок (необязательно)"); return; }
    await sendBanner(chatId, headline.trim(), subtitle.trim());
    return;
  }

  if (/^(запомни|сохрани|заметка|идея)[\s:]/i.test(text)) {
    const idea = text.replace(/^(запомни|сохрани|заметка|идея)[\s:]*/i, "").trim();
    if (!idea) { await send(chatId, "Напиши: запомни: [идея]"); return; }
    saveIdea(chatId, idea);
    // Синхронизируем с Mini App
    const allIdeas = getIdeas(chatId);
    syncToMiniApp(chatId, allIdeas).catch(() => {});
    await send(chatId, `💡 Сохранила: ${idea}\n\nПоявится в Mini App в разделе выбора темы.`);
    return;
  }

  // ── Агентная цепочка ────────────────────────────────────────────────────────
  stopFlags.delete(chatId);
  const route   = detectRoute(text);
  const first   = AGENTS[route.agents[0]];
  const history = getHistory(chatId);
  const mid     = await sendWithStop(chatId, `${first.emoji} ${first.name} — ${route.label}...`);

  let result = text;
  try {
    for (let i = 0; i < route.agents.length; i++) {
      if (stopFlags.has(chatId)) { await editMsg(chatId, mid, "🛑 Остановлено", true); return; }
      const agent = AGENTS[route.agents[i]];
      if (i > 0) await editMsg(chatId, mid, `✅ → ${agent.emoji} ${agent.name}...`);
      let userMsg = i === 0 ? text : result;
      if (route.agents[i] === "ideas") {
        const saved = getIdeas(chatId).slice(0,10).map((x,n)=>`${n+1}. ${x.text}`).join("\n");
        userMsg = `Мои идеи:\n${saved||"Нет."}\n\nЗапрос: ${text}`;
      }
      // Для контентных агентов — добавляем реальные кейсы
      const CASES_AGENTS = ["smm", "editor", "sales", "analyst", "content-director"];
      let sysPrompt = agent.systemPrompt;
      if (CASES_AGENTS.includes(route.agents[i])) {
        sysPrompt += `\n\nРЕАЛЬНЫЕ КЕЙСЫ АГЕНТСТВА FORMULA — используй эти цифры:\n${getContextCases(3)}`;
        // Если просят написать кейс — добавляем шаблон 10 шагов
        if (/кейс|case/i.test(text)) {
          sysPrompt += `\n\nШАБЛОН ДЛЯ КЕЙСА — обязательно используй структуру 10 шагов:\n${getCaseTemplate()}\n\nМЕТОДОЛОГИЯ (10 шагов системы FORMULA):\n${getTenSteps()}`;
        }
      }
      result = await claude(sysPrompt, userMsg, i === 0 ? history : []);
    }
    if (stopFlags.has(chatId)) { await editMsg(chatId, mid, "🛑 Остановлено", true); return; }
    if (route.platforms) {
      await editMsg(chatId, mid, "✅ → 📱 Адаптирую под платформы...");
      result = await claude(PLAT_SYSTEM, platPrompt(result));
    }
    appendHistory(chatId, text, result);
    lastResults.set(String(chatId), { text: result, request: text });
    await bot.deleteMessage(chatId, mid).catch(() => {});
    await sendResult(chatId, toTgMarkdown(result));
  } catch (e) {
    console.error(e.message);
    await editMsg(chatId, mid, "⚠️ Ошибка. Попробуй ещё раз.", true);
  }
}

// ─── Callback кнопки ─────────────────────────────────────────────────────────
bot.on("callback_query", async cb => {
  const chatId = cb.message.chat.id;
  const data   = cb.data || "";

  await bot.answerCallbackQuery(cb.id).catch(() => {});

  // 🛑 Стоп
  if (data.startsWith("stop_")) {
    stopFlags.add(Number(data.split("_")[1]));
    await bot.answerCallbackQuery(cb.id, { text: "🛑 Остановлено" }).catch(() => {});
    await bot.editMessageText("🛑 Остановлено", {
      chat_id: chatId, message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    return;
  }

  const last = lastResults.get(String(chatId));

  // ↻ Другой вариант
  if (data.startsWith("regen_") && last) {
    const mid = await sendWithStop(chatId, "↻ Генерирую другой вариант...");
    try {
      const route = detectRoute(last.request);
      const agent = AGENTS[route.agents[0]];
      const result = await claude(agent.systemPrompt, last.request, getHistory(chatId));
      lastResults.set(String(chatId), { text: result, request: last.request });
      await bot.deleteMessage(chatId, mid).catch(() => {});
      await sendResult(chatId, result);
    } catch { await editMsg(chatId, mid, "⚠️ Ошибка. Попробуй ещё раз.", true); }
    return;
  }

  // 🔨 QA-разбор
  if (data.startsWith("qa_") && last) {
    const mid = await sendWithStop(chatId, "🔨 Adversarial ломает текст...");
    try {
      const result = await claude(AGENTS.adversarial.systemPrompt, last.text);
      await bot.deleteMessage(chatId, mid).catch(() => {});
      await sendResult(chatId, result);
    } catch { await editMsg(chatId, mid, "⚠️ Ошибка.", true); }
    return;
  }

  // ⭐️ Сделай круче
  if (data.startsWith("chesky_") && last) {
    const mid = await sendWithStop(chatId, "⭐️ Chesky ищет 10-звёздную версию...");
    try {
      const result = await claude(AGENTS.chesky.systemPrompt, last.text);
      await bot.deleteMessage(chatId, mid).catch(() => {});
      await sendResult(chatId, result);
    } catch { await editMsg(chatId, mid, "⚠️ Ошибка.", true); }
    return;
  }

  // 📢 Опубликовать в канал
  if (data.startsWith("publish_") && last) {
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) { await send(chatId, "CHANNEL_ID не задан в переменных."); return; }
    try {
      // Берём только TG-версию если есть блоки платформ, иначе весь текст
      const tgMatch = last.text.match(/TELEGRAM[\s\S]*?(?=ВКОНТАКТЕ|ТЕНЧАТ|$)/i);
      const postText = tgMatch ? tgMatch[0].replace(/^TELEGRAM\s*/i, "").trim() : last.text;
      await bot.sendMessage(channelId, postText);
      await bot.sendMessage(chatId, "✅ Пост опубликован в канале!", { reply_markup: MAIN_KB });
    } catch (e) {
      await send(chatId, `❌ Не удалось опубликовать: ${e.message}\n\nПроверь что бот — администратор канала.`);
    }
    return;
  }

  // 🖼 Текст-баннер из поста
  if (data.startsWith("banner_") && last) {
    const bannerData = lastResults.get(`banner_${chatId}`);
    if (bannerData) {
      // Повторяем предыдущий баннер
      await sendBanner(chatId, bannerData.headline, bannerData.subtitle);
    } else {
      // Берём заголовок из последнего поста (первая строка)
      const firstLine = last.text.split("\n").find(l => l.trim().length > 10) || last.request;
      const clean = firstLine.replace(/[*_#]/g, "").trim().slice(0, 80);
      await sendBanner(chatId, clean);
    }
    return;
  }

  // 📐 Квадрат баннера
  if (data.startsWith("bsq_")) {
    const bannerData = lastResults.get(`banner_${chatId}`);
    if (bannerData) {
      await bot.sendChatAction(chatId, "upload_photo");
      const buf = await createBanner(bannerData.headline, bannerData.subtitle, 1080, 1080);
      await bot.sendPhoto(chatId, buf, { caption: "📐 1080×1080" });
    }
    return;
  }

  // 🎨 Картинка к посту
  if (data.startsWith("image_") && last) {
    await sendImageForPost(chatId, last.text);
    return;
  }

  // ↻ Другой вариант картинки
  if (data.startsWith("newimg_")) {
    const imgData = lastResults.get(`img_${chatId}`);
    if (imgData?.prompt) {
      await bot.sendChatAction(chatId, "upload_photo");
      const url = await generateImage(imgData.prompt + " variation " + Date.now());
      await bot.sendPhoto(chatId, url, { caption: "🎨 Другой вариант" }).catch(() => send(chatId, url));
    }
    return;
  }

  // 📐 Квадрат 1:1
  if (data.startsWith("imgsq_")) {
    const imgData = lastResults.get(`img_${chatId}`);
    if (imgData?.prompt) {
      await bot.sendChatAction(chatId, "upload_photo");
      const url = await generateImage(imgData.prompt, 1080, 1080);
      await bot.sendPhoto(chatId, url, { caption: "🎨 Квадрат 1080×1080" }).catch(() => send(chatId, url));
    }
    return;
  }

  // 💾 Сохранить идею
  if (data.startsWith("saveidea_") && last) {
    const snippet = last.request.slice(0, 120);
    saveIdea(chatId, snippet);
    await bot.sendMessage(chatId, `💾 Сохранила: ${snippet}\n\n/ideas — все заметки`, { reply_markup: MAIN_KB }).catch(() => {});
    return;
  }
});

bot.on("message", msg => handle(msg).catch(console.error));
bot.on("polling_error", err => console.error("Polling:", err.message));
console.log("✅ Polling...");

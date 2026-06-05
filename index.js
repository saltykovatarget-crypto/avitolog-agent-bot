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
  "reels-pro":        require("./agents/reels-pro"),
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

// Меню команд / в Telegram — короткое, основная работа через Mini App
bot.setMyCommands([
  { command: "start",  description: "🏠 Начать" },
  { command: "agents", description: "🤖 Выбрать агента (Mini App)" },
  { command: "unpin",  description: "🔓 Отключить агента" },
  { command: "ideas",  description: "💡 Мои идеи" },
  { command: "new",    description: "🆕 Новый чат" },
  { command: "stop",   description: "🛑 Остановить" },
]).catch(() => {});

// ─── Redis (Upstash) — постоянное хранилище ───────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);

async function redisCmd(...args) {
  if (!USE_REDIS) return null;
  try {
    const res = await fetch(`${REDIS_URL}/${args.map(a => encodeURIComponent(a)).join("/")}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const { result } = await res.json();
    return result;
  } catch { return null; }
}

async function rGet(key)        { const v = await redisCmd("GET", key); return v ? JSON.parse(v) : null; }
async function rSet(key, value, ttl) {
  const v = JSON.stringify(value);
  if (ttl) await redisCmd("SET", key, v, "EX", ttl);
  else     await redisCmd("SET", key, v);
}
async function rDel(key)        { await redisCmd("DEL", key); }

// ─── In-memory fallback (если Redis не подключён) ────────────────────────────
const _histories  = new Map();
const _ideas      = new Map();
const _compets    = new Map();
const stopFlags   = new Set();
const lastResults = new Map();

// ─── Клавиатуры ───────────────────────────────────────────────────────────────
// Минимум — основная навигация теперь в Mini App, бот = рабочая зона.
const MAIN_KB = {
  keyboard: [
    [{ text: "🤖 Сменить агента" }, { text: "🔓 Отключить" }],
    [{ text: "💡 Идеи" },           { text: "🆕 Новый чат" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

const BUTTON_MAP = {
  "🤖 Сменить агента": "/agents",
  "🔓 Отключить":      "/unpin",
  "💡 Идеи":           "/ideas",
  "🆕 Новый чат":     "/new",
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
  { name: "Авито B2B",          username: "avito_b2b" },
  { name: "Авито Услуги",       username: "avito_uslugi" },
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
    // Убираем таблицы Markdown — строки с |
    .replace(/^\|.*\|$/gm, (row) => {
      // Строки с разделителями |---|--- убираем
      if (/^[\s|:-]+$/.test(row)) return "";
      // Строки с данными — берём ячейки
      return row.split("|").map(c => c.trim()).filter(c => c && !/^[-:]+$/.test(c)).join("  ·  ");
    })
    // Код-блоки (```...```) — оставляем как моноширинные (TG их понимает)
    // **жирный** → *жирный*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // ### Заголовок → пустая строка + ЗАГОЛОВОК КАПСОМ
    .replace(/^#{1,2}\s+(.+)$/gm, "\n*$1*")
    .replace(/^#{3,6}\s+(.+)$/gm, "$1")
    // --- разделители → пустая строка
    .replace(/^---+$/gm, "")
    // __ курсив __ → _курсив_
    .replace(/__(.+?)__/g, "_$1_")
    // Убираем лишние пустые строки (3+ → 2)
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

// Multi-platform адаптация отключена — пишем только под Telegram (один сильный пост > трёх средних)

// ─── История (с Redis) ────────────────────────────────────────────────────────
async function getHistory(id) {
  if (USE_REDIS) return (await rGet(`hist:${id}`)) || [];
  return _histories.get(String(id)) || [];
}
async function clearHistory(id) {
  if (USE_REDIS) await rDel(`hist:${id}`);
  else _histories.delete(String(id));
}
async function appendHistory(id, u, a) {
  const h = await getHistory(id);
  h.push({ role: "user",      content: String(u).slice(0, 2000) });
  h.push({ role: "assistant", content: String(a).slice(0, 4000) });
  if (h.length > 20) h.splice(0, h.length - 20);
  if (USE_REDIS) await rSet(`hist:${id}`, h, 86400); // 24ч TTL
  else _histories.set(String(id), h);
}

// ─── Генератор баннеров (sharp) ───────────────────────────────────────────────


// ─── Идеи// ─── Идеи (с Redis) ───────────────────────────────────────────────────────────
async function getIdeas(id) {
  if (USE_REDIS) return (await rGet(`ideas:${id}`)) || [];
  return _ideas.get(String(id)) || [];
}
const MINI_APP_SYNC = "https://marketing-coach-avito.netlify.app/.netlify/functions/sync";

async function syncToMiniApp(userId, ideas) {
  await fetch(MINI_APP_SYNC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(userId), key: "ideas", data: ideas }),
  });
}

async function saveIdea(id, text) {
  const list = await getIdeas(id);
  list.unshift({ text, date: new Date().toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) });
  if (list.length > 100) list.splice(100);
  if (USE_REDIS) await rSet(`ideas:${id}`, list);
  else _ideas.set(String(id), list);
}

// ─── Конкуренты// ─── Конкуренты (с Redis) ─────────────────────────────────────────────────────
async function getCompetitors(id) {
  if (USE_REDIS) return (await rGet(`compet:${id}`)) || [...DEFAULT_COMPETITORS];
  return _compets.get(String(id)) || [...DEFAULT_COMPETITORS];
}
async function addCompetitor(id, username) {
  const list  = await getCompetitors(id);
  const clean = username.replace(/^@/, "");
  if (list.find(c => c.username === clean)) return false;
  list.push({ name: clean, username: clean });
  if (USE_REDIS) await rSet(`compet:${id}`, list);
  else _compets.set(String(id), list);
  return true;
}
async function removeCompetitor(id, username) {
  const clean    = username.replace(/^@/, "");
  const filtered = (await getCompetitors(id)).filter(c => c.username !== clean);
  if (USE_REDIS) await rSet(`compet:${id}`, filtered);
  else _compets.set(String(id), filtered);
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

*Как со мной работать:*
1️⃣ Жми кнопку «Открыть» сверху → Mini App
2️⃣ Во вкладке «Агенты» — тыкаешь нужного (SMM, Reels Pro, SEO и т.д.)
3️⃣ Возвращаешься в этот чат — агент уже подключён
4️⃣ Пиши задачу — он отвечает в своей роли

Без выбора агента — отвечу как чат-маркетолог (определю роль по запросу).

🎙 Голосовые понимаю.

/agents — выбор агента · /unpin — отключить · /new — новый чат`;

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

  // Deep-link из Mini App: /start agent_<id> — закрепляет агента за чатом
  const startAgentMatch = text.match(/^\/start\s+agent_([\w-]+)/);
  if (startAgentMatch) {
    const agentId = startAgentMatch[1];
    const agent = AGENTS[agentId];
    if (!agent) {
      await send(chatId, `⚠️ Агент "${agentId}" не найден. Открой /agents.`);
      return;
    }
    await rSet(`pinned:${chatId}`, agentId, 86400 * 7);
    await clearHistory(chatId);
    await send(chatId,
      `${agent.emoji} *${agent.name}* подключён\n\n` +
      `Пиши задачу — отвечаю как ${agent.name}.\n` +
      `Сменить агента — открой Mini App кнопкой «Открыть».\n` +
      `Отключить — /unpin или /new.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/start")  {
    await rDel(`pinned:${chatId}`);
    await clearHistory(chatId);
    await bot.sendMessage(chatId, START, { reply_markup: MAIN_KB }).catch(() => {});
    return;
  }
  if (text === "/team")   { await send(chatId, TEAM); return; }
  if (text === "/new")    {
    await rDel(`pinned:${chatId}`);
    await clearHistory(chatId);
    await send(chatId, "🆕 История очищена, агент сброшен.");
    return;
  }
  if (text === "/unpin" || text === "/отключить") {
    const wasPinned = await rGet(`pinned:${chatId}`);
    await rDel(`pinned:${chatId}`);
    if (wasPinned) await send(chatId, `🔓 Агент отключён. Теперь я сам выбираю кто отвечает по смыслу запроса.`);
    else           await send(chatId, `Агент не был закреплён.`);
    return;
  }
  if (text === "/agents" || text === "/агенты") {
    await send(chatId, `🤖 *Выбор агента — в Mini App*\n\nЖми кнопку «Открыть» сверху → вкладка «Агенты» → тыкаешь нужного → возвращаешься сюда уже с подключённым специалистом.`, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/dzen" || text === "/дзен") {
    const mid = await sendWithStop(chatId, "🔍 Подбираю темы для Дзен...");
    const ideas = await claude(
      AGENTS.seo.systemPrompt,
      `Предложи 7 тем для статей на Дзен для авитолога и предпринимателей.
Темы должны:
- Отвечать на реальные запросы которые люди задают в поиске и AI-чатах про Авито
- Содержать цифры или конкретный результат в заголовке
- Позволять упомянуть AI Авитолог PRO как решение
- Быть актуальны для бизнеса на Авито в 2026

Формат: только список тем с H1-заголовком, одна строка каждая. Без вступлений.`
    );
    await editMsg(chatId, mid, "✅ Готово", true);
    await sendResult(chatId, toTgMarkdown("🔍 Темы для Дзен-статей:\n\n" + ideas + "\n\nВыбери тему → напиши «статья дзен: [название]» → получишь полную статью"));
    return;
  }

  if (text === "/план" || text === "/plan") {
    const saved = await rGet(`${chatId}:weekPlan`);
    if (!saved || typeof saved !== "object") {
      await send(chatId, "📅 Сохранённого плана нет.\n\nСоздай в Mini App (кнопка «Открыть») → вкладка «📅 План» → «🤖 AI-план» или введи темы вручную и нажми «Сохранить план».\n\nПосле сохранения план появится здесь.");
      return;
    }
    const DAY_MAP = {monday:"ПН",tuesday:"ВТ",wednesday:"СР",thursday:"ЧТ",friday:"ПТ"};
    const lines = Object.entries(DAY_MAP)
      .filter(([k]) => saved[k])
      .map(([k,v]) => `*${v}* — ${saved[k]}`).join("\n\n");
    await send(chatId, toTgMarkdown(`📅 *План на неделю*\n\n${lines}\n\nИзменить: открой Mini App → «📅 План»`));
    return;
  }

  if (text === "/stats" || text === "/статистика") {
    const mid = await sendWithStop(chatId, "📊 Анализирую посты канала...");
    const posts = await getPostsForStats();
    if (!posts.length) {
      await editMsg(chatId, mid, "📭 Постов пока нет — бот начнёт собирать статистику с сегодняшнего дня. Как только опубликуешь пост в канале — он попадёт в базу.", true);
      return;
    }
    const sorted = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0));
    const top = sorted.slice(0, 10);
    const avgViews = Math.round(posts.reduce((s, p) => s + (p.views || 0), 0) / posts.length);
    const statsText = top.map((p, i) => {
      const d = new Date(p.date * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
      const m = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
      return `${m} ${p.preview.slice(0, 55)} — *${p.views || 0}* просм (${d})`;
    }).join("\n");

    await editMsg(chatId, mid, "📊 Готово → 🤖 Анализирую тренды...");
    const analysis = await claude(
      AGENTS.analyst.systemPrompt,
      `Статистика последних постов Telegram-канала @traffic_agency_formula.
Средние просмотры: ${avgViews}. Постов в базе: ${posts.length}.

Топ по просмотрам:
${top.map(p => `- "${p.preview.slice(0,60)}" — ${p.views||0} просм`).join("\n")}

Проанализируй: какие форматы и темы работают лучше? Что повторить? 3 конкретные рекомендации.`
    );
    await editMsg(chatId, mid, "✅ Готово", true);
    await send(chatId, `📊 Статистика канала — ${posts.length} постов\nСредние просмотры: ${avgViews}\n\nТоп:\n${statsText}`);
    await sendResult(chatId, toTgMarkdown(`📈 Анализ:\n\n${analysis}`));
    return;
  }
  if (text === "/myid")   { await send(chatId, `Твой ID: ${chatId}`); return; }
  if (text === "/stop" || /^стоп$/i.test(text)) { stopFlags.add(chatId); await send(chatId, "🛑 Остановлю после шага."); return; }

  if (text === "/ideas" || /мои идеи|мои заметки|покажи идеи/i.test(text)) {
    const list = await getIdeas(chatId);
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
    const list = await getCompetitors(chatId);
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
    const list = await getCompetitors(chatId);
    await send(chatId, `🕵️ Отслеживаю:\n${list.map((c,i)=>`${i+1}. @${c.username}`).join("\n")}\n\nДобавить: добавь конкурента @канал`);
    return;
  }

  const addM = text.match(/^добавь конкурента\s+@?(\S+)/i);
  if (addM) { const ok = await addCompetitor(chatId, addM[1]); await send(chatId, ok ? `✅ @${addM[1]} добавлен.` : "Уже есть."); return; }
  const delM = text.match(/^удали конкурента\s+@?(\S+)/i);
  if (delM) { await removeCompetitor(chatId, delM[1]); await send(chatId, `🗑 @${delM[1]} удалён.`); return; }

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
    await saveIdea(chatId, idea);
    // Синхронизируем с Mini App
    const allIdeas = await getIdeas(chatId);
    syncToMiniApp(chatId, allIdeas).catch(() => {});
    await send(chatId, `💡 Сохранила: ${idea}\n\nПоявится в Mini App в разделе выбора темы.`);
    return;
  }

  // ── Агентная цепочка ────────────────────────────────────────────────────────
  stopFlags.delete(chatId);
  // Если есть закреплённый агент — обходим router, идём сразу к нему
  const pinnedId = await rGet(`pinned:${chatId}`);
  const route   = (pinnedId && AGENTS[pinnedId])
    ? { agents: [pinnedId], platforms: false, label: `${AGENTS[pinnedId].name} (закреплён)` }
    : detectRoute(text);
  const first   = AGENTS[route.agents[0]];
  const history = await getHistory(chatId);
  const mid     = await sendWithStop(chatId, `${first.emoji} ${first.name} — ${route.label}...`);

  let result = text;
  try {
    for (let i = 0; i < route.agents.length; i++) {
      if (stopFlags.has(chatId)) { await editMsg(chatId, mid, "🛑 Остановлено", true); return; }
      const agent = AGENTS[route.agents[i]];
      if (i > 0) await editMsg(chatId, mid, `✅ → ${agent.emoji} ${agent.name}...`);
      let userMsg = i === 0 ? text : result;
      if (route.agents[i] === "ideas") {
        const saved = (await getIdeas(chatId)).slice(0,10).map((x,n)=>`${n+1}. ${x.text}`).join("\n");
        userMsg = `Мои идеи:\n${saved||"Нет."}\n\nЗапрос: ${text}`;
      }
      // Кейсы инжектируем ТОЛЬКО когда явно просят кейс
      let sysPrompt = agent.systemPrompt;
      if (/кейс|case/i.test(text) && ["smm", "case-writer"].includes(route.agents[i])) {
        sysPrompt += `\n\nШАБЛОН КЕЙСА — структура 10 шагов:\n${getCaseTemplate()}\n\nМЕТОДОЛОГИЯ:\n${getTenSteps()}`;
      }
      // Для продажника — контекст сервиса
      if (route.agents[i] === "sales") {
        sysPrompt += `\n\nКОНТЕКСТ: AI Авитолог PRO работает, можно приглашать тестировать. загрузи объявление — 3 запроса бесплатно на aiavitologpro.ru`;
      }
      result = await claude(sysPrompt, userMsg, i === 0 ? history : []);
    }
    if (stopFlags.has(chatId)) { await editMsg(chatId, mid, "🛑 Остановлено", true); return; }
    // Multi-platform адаптация удалена — всегда отдаём один Telegram-пост.
    await appendHistory(chatId, text, result);
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
      const result = await claude(agent.systemPrompt, last.request, await getHistory(chatId));
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
    await saveIdea(chatId, snippet);
    await bot.sendMessage(chatId, `💾 Сохранила: ${snippet}\n\n/ideas — все заметки`, { reply_markup: MAIN_KB }).catch(() => {});
    return;
  }
});

// ─── Трекинг постов канала ────────────────────────────────────────────────────

async function savePost(msg) {
  try {
    const store = USE_REDIS ? null : null; // используем Redis напрямую
    const key = "channel_posts";
    const existing = await rGet(key) || [];
    const text = msg.text || msg.caption || "";
    const firstLine = text.split("\n").find(l => l.trim().length > 5) || text.slice(0, 80);
    const entry = {
      id:      msg.message_id,
      date:    msg.date,
      preview: firstLine.slice(0, 100),
      views:   msg.views || 0,
      reactions: msg.reactions?.results?.reduce((s, r) => s + (r.count || 0), 0) || 0,
    };
    // Добавляем в начало, храним последние 30
    existing.unshift(entry);
    if (existing.length > 30) existing.splice(30);
    await rSet(key, existing);
  } catch (e) { console.error("savePost:", e.message); }
}

async function getPostsForStats() {
  return (await rGet("channel_posts")) || [];
}

// Слушаем посты из канала
bot.on("channel_post", async msg => {
  if (!process.env.CHANNEL_ID) return;
  await savePost(msg);
});

// Обновляем просмотры при редактировании
bot.on("edited_channel_post", async msg => {
  try {
    const posts = await getPostsForStats();
    const idx = posts.findIndex(p => p.id === msg.message_id);
    if (idx !== -1) {
      posts[idx].views = msg.views || posts[idx].views;
      await rSet("channel_posts", posts);
    }
  } catch {}
});

bot.on("message", msg => handle(msg).catch(console.error));
bot.on("polling_error", err => console.error("Polling:", err.message));
console.log("✅ Polling...");

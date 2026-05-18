require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic   = require("@anthropic-ai/sdk");
const { detectRoute } = require("./router");

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
const histories  = new Map();
const ideasStore = new Map();
const competStore= new Map();
const stopFlags  = new Set();

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
async function send(chatId, text) {
  const chunks = String(text).match(/[\s\S]{1,4000}/g) || [text];
  for (const c of chunks) await bot.sendMessage(chatId, c).catch(() => {});
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

// ─── Идеи ─────────────────────────────────────────────────────────────────────
const getIdeas = id => ideasStore.get(String(id)) || [];
function saveIdea(id, text) {
  const list = getIdeas(id);
  list.unshift({ text, date: new Date().toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) });
  if (list.length > 100) list.splice(100);
  ideasStore.set(String(id), list);
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

// ─── Авито новости ────────────────────────────────────────────────────────────
async function getAvitoNews() {
  const r = await fetch("https://www.avito.ru/web/1/blog/posts?perPage=5",
    { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.items?.slice(0,5).map(i => `— ${i.title}`).join("\n") || null;
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

  if (msg.voice) {
    if (!process.env.GROQ_API_KEY) { await send(chatId, "🎙 Голосовые не подключены. Напиши текстом."); return; }
    await bot.sendChatAction(chatId, "typing");
    const mid = await sendWithStop(chatId, "🎙 Распознаю...");
    text = await transcribeVoice(msg.voice.file_id).catch(() => "");
    if (!text) { await editMsg(chatId, mid, "❌ Не удалось. Попробуй текстом.", true); return; }
    await editMsg(chatId, mid, `📝 Распознано:\n${text}`, true);
  }

  if (!text) return;

  if (text === "/start")  { clearHistory(chatId); await send(chatId, START); return; }
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
    const mid  = await sendWithStop(chatId, "🔍 Ищу новости Авито...");
    const news = await getAvitoNews();
    const result = await claude(AGENTS.analyst.systemPrompt,
      news ? `Новости Авито:\n${news}\n\nПредложи 3 хука для постов.`
           : "Предложи 3 актуальные темы для постов авитолога в 2025.");
    await editMsg(chatId, mid, news ? `Новости Авито:\n${news}` : "Новости недоступны.", true);
    await send(chatId, `📊 Идеи:\n\n${result}`);
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

  if (/^(запомни|сохрани|заметка|идея)[\s:]/i.test(text)) {
    const idea = text.replace(/^(запомни|сохрани|заметка|идея)[\s:]*/i, "").trim();
    if (!idea) { await send(chatId, "Напиши: запомни: [идея]"); return; }
    saveIdea(chatId, idea);
    await send(chatId, `💡 Сохранила: ${idea}`);
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
      result = await claude(agent.systemPrompt, userMsg, i === 0 ? history : []);
    }
    if (stopFlags.has(chatId)) { await editMsg(chatId, mid, "🛑 Остановлено", true); return; }
    if (route.platforms) {
      await editMsg(chatId, mid, "✅ → 📱 Адаптирую под платформы...");
      result = await claude(PLAT_SYSTEM, platPrompt(result));
    }
    appendHistory(chatId, text, result);
    await bot.deleteMessage(chatId, mid).catch(() => {});
    await send(chatId, result);
  } catch (e) {
    console.error(e.message);
    await editMsg(chatId, mid, "⚠️ Ошибка. Попробуй ещё раз.", true);
  }
}

// ─── Кнопка стоп ─────────────────────────────────────────────────────────────
bot.on("callback_query", async cb => {
  if (cb.data?.startsWith("stop_")) {
    stopFlags.add(Number(cb.data.split("_")[1]));
    await bot.answerCallbackQuery(cb.id, { text: "🛑 Остановлено" }).catch(() => {});
    await bot.editMessageText("🛑 Остановлено", {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
});

bot.on("message", msg => handle(msg).catch(console.error));
bot.on("polling_error", err => console.error("Polling:", err.message));
console.log("✅ Polling...");

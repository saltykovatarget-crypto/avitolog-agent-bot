const ROUTES = [
  { pattern: /office.hours|питч|хочу запустить|думаю сделать|стоит ли|валидируй/i, agents: ["office-hours"], platforms: false, label: "включаю Office Hours" },
  { pattern: /сделай круче|10.звёзд|улучши до|chesky|чески/i, agents: ["chesky"], platforms: false, label: "ищу 10-звёздную версию" },
  { pattern: /сломай|найди ошибки|проверь жёстко|adversarial/i, agents: ["adversarial"], platforms: false, label: "ломаю как QA" },
  { pattern: /проверь логику|я думаю что|правильно ли|paranoid|параноид/i, agents: ["paranoid"], platforms: false, label: "проверяю логику" },
  { pattern: /план.на.недел|контент.план|недельный.план|оцени.пост|разбор.поста/i, agents: ["content-director"], platforms: false, label: "работаю как контент-директор" },
  { pattern: /напиши кейс|пишем кейс|оформи кейс|хочу кейс|кейс по|записать кейс/i, agents: ["case-writer"], platforms: false, label: "начинаю интервью по кейсу" },
  { pattern: /сценари|reels|рилс|видео|shorts/i, agents: ["scriptwriter"], platforms: false, label: "пишу сценарий" },
  { pattern: /обложк|баннер|b.roll|промпт.для.изображ|визуал/i, agents: ["visual"], platforms: false, label: "создаю визуал" },
  { pattern: /сайт|тариф|описание.продукт|лендинг|онбординг.текст/i, agents: ["product-marketer"], platforms: false, label: "пишу текст для продукта" },
  { pattern: /продай|оффер|скрипт.продаж|возражени/i, agents: ["sales"], platforms: false, label: "пишу продающий текст" },
  { pattern: /онбординг|новый.пользователь|день.0|день.1|день.3|триал/i, agents: ["onboarding"], platforms: false, label: "пишу онбординг" },
  { pattern: /лид.магнит|гайд|чек.лист|шаблон.для.скачивания/i, agents: ["lead-magnet"], platforms: false, label: "создаю лид-магнит" },
  { pattern: /ответь.на.коммент|в.личку.написали|как.ответить/i, agents: ["community"], platforms: false, label: "отвечаю на сообщение" },
  { pattern: /стать[юя]|дзен|seo|сео|статья|яндекс/i, agents: ["seo", "editor"], platforms: false, label: "пишу статью" },
  { pattern: /из идей|по идеям|возьми из заметок|используй идеи/i, agents: ["ideas", "smm", "editor"], platforms: true, label: "беру идею из заметок" },
  { pattern: /тем[аую]|о чём|что написать|предложи.тему/i, agents: ["analyst", "smm"], platforms: true, label: "ищу тему" },
  { pattern: /проверь|редактур|улучши|исправь/i, agents: ["editor"], platforms: false, label: "проверяю текст" },
  { pattern: /напиши|пост|кейс|лайфхак|история/i, agents: ["smm", "editor"], platforms: true, label: "пишу пост" },
];

function detectRoute(text) {
  return ROUTES.find(r => r.pattern.test(text)) || { agents: ["smm", "editor"], platforms: true, label: "пишу пост" };
}

module.exports = { detectRoute };

// Реальные кейсы агентства FORMULA / AI Авитолог PRO
// Источник: @traffic_agency_formula
module.exports = [
  { niche: "производство морозостойких бассейнов", brand: "Larimar", leads: 158, price: 97 },
  { niche: "продажа автоматических ворот", region: "Красноярский край", leads: 1901, price: 71 },
  { niche: "инженерная компания (отопление, бассейны)", city: "Москва", leads: 293, price: 450 },
  { niche: "поставка товаров из Китая", leads: 30, price: 133 },
  { niche: "автоматические ворота и жалюзи", brand: "ТЭКС", city: "Таганрог", leads: 498, price: 138 },
  { niche: "продажа новых авто из Китая", leads: 124, price: 89 },
  { niche: "строительство каркасных домов", leads: 70, price: 289 },
  { niche: "контурная подсветка домов и бизнеса", leads: 28, price: 203 },
  { niche: "производство теплиц и парников", region: "Красноярск", leads: 613, price: 118 },
  { niche: "монтаж отопления под ключ", city: "Москва", leads: 72, price: 403 },
  { niche: "бизнес-план для социального контракта", leads: 181, price: 19 },
  { niche: "остекление и пластиковые окна", region: "Нижегородская область", leads: 138, price: 235 },
  { niche: "ремонт и отделка квартир", leads: 134, price: 107 },
  { niche: "строительство домов и бань из кедра", leads: 43, price: 525 },
  { niche: "остекление и отделка балконов", leads: 356, price: 164 },
  { niche: "монтаж отопления и бетонные работы", leads: 151, price: 174 },
  { niche: "ремонт квартир", city: "Челябинск", leads: 62, price: 183, days: 15 },
  { niche: "бухгалтерские услуги", leads: null, price: null },
  { niche: "строительство домов из газобетона", leads: 289, price: 298 },
  { niche: "клининг для бизнеса (B2B)", leads: 56, price: 376 },
  { niche: "сборно-разборные металлоконструкции", leads: 228, price: 150 },
];

// Форматирует 3 случайных кейса для вставки в промпт
function getContextCases(count = 3) {
  const shuffled = [...module.exports].filter(c => c.leads).sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(c => {
    const parts = [`${c.niche}`];
    if (c.city) parts.push(c.city);
    if (c.region) parts.push(c.region);
    if (c.brand) parts.push(`(${c.brand})`);
    const loc = parts.join(", ");
    let result = `${c.leads} заявок по ${c.price} ₽`;
    if (c.days) result += ` за ${c.days} дней`;
    return `— ${loc}: ${result}`;
  }).join("\n");
}

module.exports.getContextCases = getContextCases;

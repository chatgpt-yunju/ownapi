const TIER_BASE = { '985': 8, '211': 6, '双一流': 4, '普通': 2 };

function calcSinglePrice(tier, year, isHot) {
  const base = TIER_BASE[tier] || 2;
  const yearBonus = Math.max(0, (year - 2015) * 0.5);
  const hotBonus = isHot ? 2 : 0;
  return Math.min(15, Math.max(1, Math.round((base + yearBonus + hotBonus) * 100) / 100));
}

function getDiscount(count) {
  if (count >= 10) return 0.55;
  if (count >= 6) return 0.65;
  if (count >= 3) return 0.75;
  if (count >= 2) return 0.85;
  return 1;
}

function calcPackagePrice(papers) {
  const total = papers.reduce((s, p) => s + Number(p.price), 0);
  const discount = getDiscount(papers.length);
  return {
    total: Math.round(total * 100) / 100,
    discount,
    amount: Math.round(total * discount * 100) / 100,
  };
}

module.exports = { calcSinglePrice, calcPackagePrice, getDiscount, TIER_BASE };

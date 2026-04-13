const RECHARGE_TIERS = [
  { min: 1999, rate: 1.55, label: '加赠55%' },
  { min: 999, rate: 1.38, label: '加赠38%' },
  { min: 499, rate: 1.25, label: '加赠25%' },
  { min: 199, rate: 1.15, label: '加赠15%' },
  { min: 99, rate: 1.18, label: '加赠18%' },
  { min: 50, rate: 1.14, label: '加赠14%' },
  { min: 10, rate: 1.10, label: '加赠10%' },
  { min: 1, rate: 1.20, label: '加赠20%' },
];

function getRechargePricing(payAmount) {
  const tier = RECHARGE_TIERS.find(t => payAmount >= t.min) || { rate: 1, label: '无赠送', min: 0 };
  const creditAmount = Math.round(payAmount * tier.rate * 100) / 100;
  return {
    creditAmount,
    bonusAmount: Math.max(0, Math.round((creditAmount - payAmount) * 100) / 100),
    tier,
  };
}

module.exports = {
  RECHARGE_TIERS,
  getRechargePricing,
};

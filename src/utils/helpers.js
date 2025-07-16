export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatNumber(num, decimals = 2) {
  return Number(num).toFixed(decimals);
}

export function formatPercent(value) {
  return `${formatNumber(value, 2)}%`;
}

export function formatUSDT(value) {
  return `$${formatNumber(value, 2)}`;
}

export function calculatePercent(value, total) {
  if (total === 0) return 0;
  return (value / total) * 100;
}

export function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

export function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function parseTimeframe(timeframe) {
  const units = {
    's': 1000,
    'm': 60 * 1000,
    'h': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000
  };
  
  const match = timeframe.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid timeframe: ${timeframe}`);
  
  const [, value, unit] = match;
  return parseInt(value) * units[unit];
}
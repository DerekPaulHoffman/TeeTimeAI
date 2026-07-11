export function formatDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function getNextSaturdayDateInputValue(from = new Date()) {
  const daysUntilSaturday = (6 - from.getDay() + 7) % 7 || 7;
  return formatDateInputValue(addLocalDays(from, daysUntilSaturday));
}

const birthdayPattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function normalizeBirthday(type, date) {
  const birthdayType = String(type || '').trim();
  const birthdayDate = String(date || '').trim();
  if (!birthdayType && !birthdayDate) return { type: '', date: '' };
  if (!['solar', 'lunar'].includes(birthdayType) || !birthdayPattern.test(birthdayDate)) return null;
  const day = Number(birthdayDate.slice(3));
  if (birthdayType === 'lunar' && day > 30) return null;
  if (birthdayType === 'solar' && new Date(`2000-${birthdayDate}T12:00:00Z`).toISOString().slice(5, 10) !== birthdayDate) return null;
  return { type: birthdayType, date: birthdayDate };
}

function localParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function lunarParts(date) {
  const parts = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => {
    // Some runtimes expose an intercalary lunar month as text such as "闰8".
    const numeric = String(part.value).match(/\d+/)?.[0];
    return [part.type, numeric ? Number(numeric) : NaN];
  }));
}

export function getBirthdayMatchInfo(type, birthdayDate, now = new Date()) {
  const normalized = normalizeBirthday(type, birthdayDate);
  if (!normalized?.type) return { isToday: false, daysUntil: null, label: '' };
  const [month, day] = normalized.date.split('-').map(Number);
  const today = localParts(now);
  const base = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), 12);
  for (let offset = 0; offset <= 3; offset += 1) {
    const candidate = new Date(base + offset * 86400000);
    const parts = normalized.type === 'lunar' ? lunarParts(candidate) : localParts(candidate);
    const matched = Number(parts.month) === month && Number(parts.day) === day;
    if (matched) return { isToday: offset === 0, daysUntil: offset, label: offset === 0 ? '今天生日' : `${offset} 天后生日` };
  }
  return { isToday: false, daysUntil: null, label: '' };
}

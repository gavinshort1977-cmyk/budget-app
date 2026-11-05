// The budget document is a flat map of "registers":
//     key -> { v: value, t: timestamp, d: deviceId }
// Every single value (a name, an order, one month's amount, a deletion marker)
// is its own register. Two copies are merged key by key: the register with the
// newer timestamp wins (device id breaks exact ties). Deleting something writes
// a "del" register instead of removing data, so deletions also merge safely.
//
// Key layout (ids never contain ':'):
//   s:start                 start month "YYYY-MM"
//   s:encrypt               true/false — Drive file encryption on/off
//   g:<id>:name|kind|order|savings|del      groups  (kind 'in' | 'out')
//   l:<id>:group|name|order|acct|del        lines   (acct = linked account id)
//   v:<lineId>:<m>          amount in fils (integer) for month index m (0-11)
//   a:<id>:name|start|daily|order|del       accounts (start in fils)
//   b:<accountId>:<m>       month-end actual balance in fils

export const SEED_DEVICE = '0seed';

export function newId(prefix = 'x') {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + Date.now().toString(36) + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

/** a is newer than b? */
export function isNewer(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.t !== b.t) return a.t > b.t;
  return String(a.d) > String(b.d);
}

/**
 * Merge two register maps. Returns the merged map and whether each side
 * was missing something that the other had.
 */
export function mergeRegs(local, remote) {
  const merged = { ...local };
  let localChanged = false;
  let remoteChanged = false;
  for (const k of Object.keys(remote || {})) {
    const r = remote[k];
    const l = local[k];
    if (!validReg(r)) continue;
    if (isNewer(r, l)) {
      merged[k] = r;
      if (!l || l.t !== r.t || l.d !== r.d) localChanged = true;
    }
  }
  for (const k of Object.keys(local)) {
    const r = remote ? remote[k] : undefined;
    if (!r || isNewer(local[k], r)) remoteChanged = true;
  }
  return { merged, localChanged, remoteChanged };
}

function validReg(r) {
  return r && typeof r === 'object' && typeof r.t === 'number' && 'v' in r;
}

export function maxTime(regs) {
  let m = 0;
  for (const k in regs) if (regs[k].t > m) m = regs[k].t;
  return m;
}

/** Hybrid clock: monotonically increasing, never behind anything we've seen. */
export class Clock {
  constructor(deviceId, last = 0) {
    this.deviceId = deviceId;
    this.last = last;
  }
  now() {
    const t = Math.max(Date.now(), this.last + 1);
    this.last = t;
    return t;
  }
  observe(t) {
    if (t > this.last) this.last = t;
  }
}

export function hasUserData(regs) {
  return Object.values(regs).some((r) => r.d !== SEED_DEVICE);
}

// ---------------------------------------------------------------------------
// Model: turn registers into groups / lines / accounts for the UI & maths.
// ---------------------------------------------------------------------------

export function val(regs, key, dflt = undefined) {
  const r = regs[key];
  return r && r.v !== null && r.v !== undefined ? r.v : dflt;
}

export function buildModel(regs) {
  const groups = new Map();
  const lines = new Map();
  const accounts = new Map();
  const ensure = (map, id) => {
    if (!map.has(id)) map.set(id, { id });
    return map.get(id);
  };
  for (const key of Object.keys(regs)) {
    const parts = key.split(':');
    const v = regs[key].v;
    if (parts[0] === 'g' && parts.length === 3) ensure(groups, parts[1])[parts[2]] = v;
    else if (parts[0] === 'l' && parts.length === 3) ensure(lines, parts[1])[parts[2]] = v;
    else if (parts[0] === 'a' && parts.length === 3) ensure(accounts, parts[1])[parts[2]] = v;
  }
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : 1);

  const liveGroups = [...groups.values()]
    .filter((g) => !g.del && g.name !== undefined)
    .map((g) => ({ id: g.id, name: g.name ?? '', kind: g.kind === 'in' ? 'in' : 'out', order: g.order ?? 0, savings: !!g.savings, lines: [] }))
    .sort(byOrder);
  const gIndex = new Map(liveGroups.map((g) => [g.id, g]));
  for (const l of lines.values()) {
    if (l.del || l.name === undefined) continue;
    const g = gIndex.get(l.group);
    if (!g) continue;
    g.lines.push({ id: l.id, name: l.name ?? '', order: l.order ?? 0, acct: l.acct || null, groupId: g.id });
  }
  for (const g of liveGroups) g.lines.sort(byOrder);

  const liveAccounts = [...accounts.values()]
    .filter((a) => !a.del && a.name !== undefined)
    .map((a) => ({ id: a.id, name: a.name ?? '', start: Number(a.start) || 0, daily: !!a.daily, order: a.order ?? 0 }))
    .sort(byOrder);

  return {
    start: val(regs, 's:start', '2026-10'),
    encrypt: !!val(regs, 's:encrypt', false),
    groups: liveGroups,
    inflowGroups: liveGroups.filter((g) => g.kind === 'in'),
    outflowGroups: liveGroups.filter((g) => g.kind === 'out'),
    accounts: liveAccounts,
    amount: (lineId, m) => {
      const x = val(regs, `v:${lineId}:${m}`, null);
      return typeof x === 'number' ? x : null;
    },
    actual: (accId, m) => {
      const x = val(regs, `b:${accId}:${m}`, null);
      return typeof x === 'number' ? x : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults. Fixed ids + a fixed seed timestamp, so two fresh devices produce
// identical defaults and syncing them never creates duplicates. Any real edit
// has a newer timestamp and wins. No amounts are included.
// ---------------------------------------------------------------------------

const DEFAULT_GROUPS = [
  ['income', 'Income', 'in', false, [
    ['salary', "Salary or owner's draw"], ['bonus', 'Bonus'], ['freelance', 'Freelance income'],
    ['rental', 'Rental income'], ['investinc', 'Investment income'], ['otherinc', 'Other income'],
  ]],
  ['housing', 'Housing', 'out', false, [
    ['rent', 'Rent or mortgage'], ['dewa', 'DEWA (electricity & water)'], ['chiller', 'Chiller / district cooling'],
    ['internet', 'Internet & TV'], ['mobile', 'Mobile phones'], ['maint', 'Maintenance & repairs'],
  ]],
  ['transport', 'Transport', 'out', false, [
    ['carpay', 'Car loan or lease'], ['fuel', 'Fuel'], ['salik', 'Salik (tolls)'], ['parking', 'Parking'],
    ['carins', 'Car insurance & registration'], ['service', 'Car servicing'], ['taxi', 'Taxis & public transport'],
  ]],
  ['daily', 'Daily living', 'out', false, [
    ['groceries', 'Groceries'], ['dining', 'Dining out & delivery'], ['household', 'Household supplies'],
    ['personal', 'Personal care'], ['laundry', 'Laundry & dry cleaning'],
  ]],
  ['family', 'Family', 'out', false, [
    ['school', 'School fees'], ['childcare', 'Childcare'], ['kidsact', "Kids' activities"],
    ['helper', 'Domestic help'], ['support', 'Family support'], ['gifts', 'Gifts & occasions'],
  ]],
  ['health', 'Health and insurance', 'out', false, [
    ['healthins', 'Health insurance'], ['medical', 'Medical & pharmacy'], ['dental', 'Dental & optical'], ['lifeins', 'Life insurance'],
  ]],
  ['lifestyle', 'Lifestyle', 'out', false, [
    ['subs', 'Subscriptions'], ['entertain', 'Entertainment'], ['fitness', 'Fitness'],
    ['shopping', 'Shopping & clothing'], ['travel', 'Travel & holidays'], ['hobbies', 'Hobbies'],
  ]],
  ['debt', 'Debt', 'out', false, [
    ['cc', 'Credit card payments'], ['ploan', 'Personal loan'], ['otherdebt', 'Other debt'],
  ]],
  ['savings', 'Savings and investing', 'out', true, [
    ['sv-ret', 'Sarwa Invest - Retirement', 'sarwa-ret'], ['sv-kids', 'Sarwa Invest - Kids Fund', 'sarwa-kids'],
    ['sv-sav', 'Sarwa Savings', 'sarwa-sav'], ['sv-other', 'Other savings'],
  ]],
  ['other', 'Other', 'out', false, [
    ['charity', 'Charity'], ['misc', 'Miscellaneous'],
  ]],
];

const DEFAULT_ACCOUNTS = [
  ['hsbc', 'HSBC', true], ['enbd', 'ENBD', true],
  ['sarwa-ret', 'Sarwa Invest - Retirement', false],
  ['sarwa-kids', 'Sarwa Invest - Kids Fund', false],
  ['sarwa-sav', 'Sarwa Savings', false],
];

export function defaultRegs(start = '2026-10') {
  const regs = {};
  const put = (k, v) => { regs[k] = { v, t: 1, d: SEED_DEVICE }; };
  put('s:start', start);
  put('s:encrypt', false);
  DEFAULT_GROUPS.forEach(([gid, name, kind, savings, lines], gi) => {
    const id = 'g-' + gid;
    put(`g:${id}:name`, name);
    put(`g:${id}:kind`, kind);
    put(`g:${id}:order`, (gi + 1) * 10);
    put(`g:${id}:savings`, savings);
    lines.forEach(([lid, lname, acct], li) => {
      const L = 'l-' + lid;
      put(`l:${L}:group`, id);
      put(`l:${L}:name`, lname);
      put(`l:${L}:order`, (li + 1) * 10);
      if (acct) put(`l:${L}:acct`, 'a-' + acct);
    });
  });
  DEFAULT_ACCOUNTS.forEach(([aid, name, daily], i) => {
    const id = 'a-' + aid;
    put(`a:${id}:name`, name);
    put(`a:${id}:start`, 0);
    put(`a:${id}:daily`, daily);
    put(`a:${id}:order`, (i + 1) * 10);
  });
  return regs;
}

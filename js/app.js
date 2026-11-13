import {
  ApiError,
  LAST_PROFILE_KEY,
  asArray,
  call,
  friendlyMessage,
  rpc,
  setTokenGetter,
  tokenKey,
} from './api.js';
import {
  WEEKDAYS,
  addDays,
  esc,
  formatDate,
  formatStamp,
  inkFor,
  lockClock,
  money,
  pointsWord,
  repeatLabel,
  safeColor,
  safeUrl,
} from './format.js';
import { fileToJpegBase64 } from './photo.js';

const FORM_CODES = new Set([
  'invalid_title', 'invalid_points', 'invalid_repeat', 'invalid_assignees', 'invalid_weekdays',
  'invalid_due_date', 'repeat_change_not_allowed', 'note_required', 'invalid_rate', 'invalid_link',
  'invalid_cost', 'invalid_pin_format', 'wrong_pin', 'insufficient_points', 'request_pending',
  'photo_too_large', 'invalid_photo', 'invalid_kid', 'invalid_decision',
]);

const KIND_ICON = {
  chore_submitted: '✅',
  chore_assigned: '📋',
  chore_approved: '🌟',
  chore_rejected: '↩️',
  redeem_requested: '🎁',
  redeem_approved: '🎉',
  redeem_declined: '🙅',
  points_bonus: '🌟',
  points_adjusted: '✏️',
  wish_added: '💝',
  pin_reset: '🔐',
  pin_locked: '🔒',
};

const state = {
  screen: 'boot',
  fatal: '',
  profiles: [],
  selectedId: '',
  me: null,
  settings: null,
  token: '',
  unread: 0,
  tab: 'today',
  simple: false,
  loading: false,
  busy: false,
  toast: null,
  pin: emptyPin(),
  approvals: [],
  chores: [],
  balances: [],
  ledger: [],
  ledgerKid: '',
  wishes: [],
  redeems: [],
  instances: [],
  notifications: [],
  notifOpen: false,
  loadingNotifs: false,
  showArchived: false,
  showClosed: false,
  showEarlier: false,
  panel: null,
  draft: {},
  photo: null,
};

let pinGen = 0;
let pinTimer = 0;
let toastTimer = 0;
let pollTimer = 0;
let lockTimer = 0;
let visBound = false;

setTokenGetter(() => state.token);

function emptyPin(mode = 'enter') {
  return { mode, digits: '', first: '', error: '', lockedUntil: null, shake: false };
}

function selected() {
  return state.profiles.find((p) => p.id === state.selectedId) || null;
}

function isParent() {
  return state.me?.role === 'parent';
}

function today() {
  return state.settings?.today || '';
}

function kidProfiles() {
  return state.profiles.filter((p) => p.role === 'kid');
}

function isSimple(profile) {
  return profile?.slug === 'niko' || profile?.age === 6;
}

function myBalance() {
  return state.balances[0] || null;
}

function clearToast() {
  clearTimeout(toastTimer);
  state.toast = null;
}

function armToast() {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    document.querySelector('.toast')?.remove();
  }, 4200);
}

function showToast(text, kind = 'good') {
  state.toast = { text, kind };
  armToast();
}

function clearShake() {
  setTimeout(() => {
    state.pin.shake = false;
    document.querySelector('.dots')?.classList.remove('shake');
  }, 450);
}

function noteError(err) {
  if (err instanceof ApiError && err.code === 'invalid_session') {
    const id = state.me?.id || state.selectedId;
    if (id) localStorage.removeItem(tokenKey(id));
    stopPoll();
    state.token = '';
    state.screen = 'pin';
    state.busy = false;
    state.loading = false;
    state.panel = null;
    state.notifOpen = false;
    const profile = state.profiles.find((p) => p.id === id);
    state.simple = isSimple(profile);
    state.pin = emptyPin(profile && profile.has_pin === false ? 'create' : 'enter');
    state.pin.error = friendlyMessage('invalid_session');
    return;
  }
  const code = err instanceof ApiError ? err.code : 'network';
  const detail = err instanceof ApiError ? err.detail : '';
  state.toast = { kind: 'bad', text: friendlyMessage(code, detail, state.me?.role || '') };
  armToast();
}

function failForm(err) {
  state.busy = false;
  const code = err instanceof ApiError ? err.code : 'network';
  if (err instanceof ApiError && FORM_CODES.has(code)) {
    state.draft.error = friendlyMessage(code, err.detail, state.me?.role || '');
    render();
    return;
  }
  noteError(err instanceof ApiError ? err : new ApiError('network'));
  render();
}

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = 0;
}

function startPoll() {
  stopPoll();
  const tick = async () => {
    if (document.visibilityState !== 'visible') return;
    if (state.screen !== 'app' || !state.token || state.busy) return;
    try {
      const count = Number(await call('unread_count')) || 0;
      if (count === state.unread) return;
      const increased = count > state.unread;
      state.unread = count;
      const typing = document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName);
      if (increased && !typing && !state.panel && !state.notifOpen) {
        await loadCurrent();
        render();
      } else if (state.notifOpen && !typing) {
        state.notifications = asArray(await call('list_notifications', { p_limit: 50 }));
        render();
      } else {
        paintBadge();
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_session') {
        noteError(err);
        render();
      }
    }
  };
  pollTimer = setInterval(tick, 30000);
  if (!visBound) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
    visBound = true;
  }
}

function paintBadge() {
  const el = document.querySelector('[data-badge]');
  if (!el) return;
  if (state.unread > 0) {
    el.hidden = false;
    el.textContent = state.unread > 9 ? '9+' : String(state.unread);
  } else {
    el.hidden = true;
  }
}

function startLockTicker() {
  clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (state.screen !== 'pin' || !state.pin.lockedUntil) return;
    const label = lockClock(state.pin.lockedUntil);
    if (!label) {
      state.pin.lockedUntil = null;
      state.pin.error = state.simple ? 'You can try again.' : 'You can try your code again.';
      render();
      return;
    }
    const el = document.querySelector('[data-lock-clock]');
    if (el) el.textContent = label;
  }, 1000);
}

async function boot() {
  state.screen = 'boot';
  render();
  try {
    state.profiles = asArray(await rpc('list_profiles'));
  } catch (err) {
    state.screen = 'fatal';
    state.fatal = friendlyMessage(err instanceof ApiError ? err.code : 'network', err?.detail || '');
    render();
    return;
  }
  const last = localStorage.getItem(LAST_PROFILE_KEY);
  const saved = last && localStorage.getItem(tokenKey(last));
  if (saved) {
    state.token = saved;
    state.selectedId = last;
    try {
      const who = await call('whoami');
      applyWho(who);
      state.screen = 'app';
      state.tab = state.me.role === 'parent' ? 'approvals' : 'today';
      startPoll();
      await refresh();
      return;
    } catch (err) {
      localStorage.removeItem(tokenKey(last));
      state.token = '';
      if (err instanceof ApiError && err.code === 'invalid_session') {
        const profile = state.profiles.find((p) => p.id === last);
        if (profile) {
          openPin(profile);
          return;
        }
      }
    }
  }
  state.screen = 'picker';
  render();
}

function applyWho(who) {
  state.me = who.profile;
  state.settings = who.settings;
  state.unread = Number(who.unread_count) || 0;
  state.simple = isSimple(state.me);
  state.selectedId = state.me.id;
}

function openPin(profile) {
  clearToast();
  state.selectedId = profile.id;
  state.simple = isSimple(profile);
  const locked = profile.locked_until && new Date(profile.locked_until).getTime() > Date.now();
  state.pin = emptyPin(profile.has_pin ? 'enter' : 'create');
  if (locked) {
    state.pin.lockedUntil = profile.locked_until;
    state.pin.error = state.simple
      ? 'Locked for a bit. Ask a parent if you need help.'
      : 'Too many tries. You can try again when the timer ends.';
  }
  state.screen = 'pin';
  state.busy = false;
  state.panel = null;
  render();
  startLockTicker();
}

async function pickProfile(id) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile || state.busy) return;
  const saved = localStorage.getItem(tokenKey(profile.id));
  if (saved) {
    state.busy = true;
    state.selectedId = profile.id;
    render();
    state.token = saved;
    try {
      const who = await call('whoami');
      localStorage.setItem(LAST_PROFILE_KEY, profile.id);
      applyWho(who);
      state.screen = 'app';
      state.tab = state.me.role === 'parent' ? 'approvals' : 'today';
      state.busy = false;
      startPoll();
      await refresh();
      return;
    } catch {
      localStorage.removeItem(tokenKey(profile.id));
      state.token = '';
      state.busy = false;
    }
  }
  openPin(profile);
}

function pressPin(key) {
  if (state.busy || (state.pin.lockedUntil && lockClock(state.pin.lockedUntil))) return;
  if (key === 'back') {
    state.pin.digits = state.pin.digits.slice(0, -1);
    state.pin.error = '';
    render();
    return;
  }
  if (!/^[0-9]$/.test(key) || state.pin.digits.length >= 4) return;
  state.pin.digits += key;
  state.pin.error = '';
  const digits = state.pin.digits;
  render();
  if (digits.length === 4) {
    clearTimeout(pinTimer);
    pinTimer = setTimeout(() => submitPin(digits), 90);
  }
}

async function submitPin(digits) {
  if (state.busy) return;
  if (state.pin.digits !== digits) return;
  const profile = selected();
  if (!profile) return;
  if (state.pin.mode === 'create') {
    state.pin.first = digits;
    state.pin.digits = '';
    state.pin.mode = 'confirm';
    state.pin.error = '';
    render();
    return;
  }
  if (state.pin.mode === 'confirm' && digits !== state.pin.first) {
    state.pin = emptyPin('create');
    state.pin.error = state.simple ? 'Not the same. Try again.' : 'Those codes don’t match. Try again.';
    state.pin.shake = true;
    render();
    clearShake();
    return;
  }
  const gen = ++pinGen;
  state.busy = true;
  render();
  try {
    const res = state.pin.mode === 'confirm'
      ? await rpc('set_initial_pin', { p_profile: profile.id, p_pin: digits })
      : await rpc('login', { p_profile: profile.id, p_pin: digits });
    if (gen !== pinGen) return;
    if (!res?.ok) {
      applyLoginFailure(res);
      return;
    }
    await enterApp(res.token, res.profile, gen);
  } catch (err) {
    if (gen !== pinGen) return;
    state.busy = false;
    state.pin.digits = '';
    state.pin.error = friendlyMessage(err instanceof ApiError ? err.code : 'network', err?.detail || '', profile.role);
    state.pin.shake = true;
    render();
    clearShake();
  }
}

function applyLoginFailure(res) {
  const error = res?.error || 'unknown';
  state.busy = false;
  state.pin.digits = '';
  state.pin.shake = true;
  if (error === 'wrong_pin') {
    const n = Number(res.attempts_left);
    const left = Number.isFinite(n) ? n : 0;
    state.pin.error = state.simple
      ? (left === 1 ? 'That’s not it. 1 try left.' : `That’s not it. ${left} tries left.`)
      : (left === 1 ? 'Wrong code. 1 try left, then it locks.' : `Wrong code. ${left} tries left.`);
  } else if (error === 'locked') {
    state.pin.lockedUntil = res.locked_until;
    state.pin.error = state.simple
      ? 'Locked for a bit. Ask a parent if you need help.'
      : 'Too many tries. You can try again when the timer ends.';
  } else if (error === 'pin_not_set') {
    state.pin = emptyPin('create');
  } else if (error === 'pin_already_set') {
    state.pin = emptyPin('enter');
    state.pin.error = friendlyMessage(error);
  } else {
    state.pin.error = friendlyMessage(error, '', selected()?.role || '');
  }
  render();
  clearShake();
}

async function enterApp(token, profile, gen) {
  clearToast();
  localStorage.setItem(tokenKey(profile.id), token);
  localStorage.setItem(LAST_PROFILE_KEY, profile.id);
  state.token = token;
  state.me = profile;
  state.simple = isSimple(profile);
  state.selectedId = profile.id;
  try {
    const who = await call('whoami');
    if (gen != null && gen !== pinGen) return;
    applyWho(who);
    state.screen = 'app';
    state.tab = state.me.role === 'parent' ? 'approvals' : 'today';
    state.panel = null;
    state.notifOpen = false;
    state.busy = false;
    startPoll();
    await refresh();
  } catch (err) {
    state.busy = false;
    if (err instanceof ApiError && err.code === 'invalid_session') {
      localStorage.removeItem(tokenKey(profile.id));
      state.token = '';
    }
    throw err;
  }
}

async function switchAccount() {
  clearToast();
  const token = state.token;
  const id = state.me?.id;
  stopPoll();
  pinGen += 1;
  state.busy = true;
  render();
  if (token) {
    try { await rpc('logout', { p_token: token }); } catch { /* session already gone */ }
  }
  if (id) localStorage.removeItem(tokenKey(id));
  if (localStorage.getItem(LAST_PROFILE_KEY) === id) localStorage.removeItem(LAST_PROFILE_KEY);
  state.token = '';
  state.me = null;
  state.panel = null;
  state.notifOpen = false;
  state.busy = false;
  state.draft = {};
  try {
    state.profiles = asArray(await rpc('list_profiles'));
  } catch { /* keep the list we have */ }
  state.screen = 'picker';
  render();
}

async function loadCurrent() {
  if (!today()) return;
  if (isParent()) {
    const from = addDays(today(), -60);
    const [approvals, redeems, balances, profiles] = await Promise.all([
      call('list_instances', { p_from: from, p_to: today(), p_statuses: ['submitted'] }),
      call('list_redeem_requests', { p_status: 'pending' }),
      call('get_balances'),
      rpc('list_profiles'),
    ]);
    state.approvals = asArray(approvals);
    state.redeems = asArray(redeems);
    state.balances = asArray(balances);
    state.profiles = asArray(profiles);
    if (state.tab === 'chores') {
      state.chores = asArray(await call('list_chores', { p_include_archived: state.showArchived }));
    }
    if (state.tab === 'kids' && state.ledgerKid) {
      state.ledger = asArray(await call('list_ledger', { p_kid: state.ledgerKid, p_limit: 40 }));
    }
    if (state.tab === 'wishes') {
      state.wishes = asArray(await call('list_wishes', { p_include_closed: state.showClosed }));
    }
    if (state.tab === 'settings') {
      state.settings = await call('get_settings');
    }
  } else {
    const from = addDays(today(), -30);
    const [instances, balances] = await Promise.all([
      call('list_instances', { p_from: from, p_to: today() }),
      call('get_balances'),
    ]);
    state.instances = asArray(instances);
    state.balances = asArray(balances);
    if (state.tab === 'wishes') {
      state.wishes = asArray(await call('list_wishes', { p_include_closed: state.showClosed }));
    }
    if (state.tab === 'points') {
      state.ledger = asArray(await call('list_ledger', { p_limit: 50 }));
    }
  }
}

async function refresh(opts = {}) {
  if (state.screen !== 'app') return;
  if (!opts.quiet) {
    state.loading = true;
    render();
  }
  try {
    await loadCurrent();
  } catch (err) {
    noteError(err);
  } finally {
    state.loading = false;
    render();
  }
}

async function setTab(tab) {
  state.tab = tab;
  state.panel = null;
  state.photo = null;
  if (tab === 'settings') state.draft = {};
  await refresh();
}

function isoDow(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

function openChoreForm(chore) {
  if (chore) {
    const recurring = chore.repeat !== 'none';
    state.draft = {
      id: chore.id,
      title: chore.title || '',
      description: chore.description || '',
      points: String(chore.points ?? ''),
      assignees: (chore.assignees || []).map((a) => a.id),
      repeat: chore.repeat || 'none',
      weekdays: (chore.weekdays || []).map(Number),
      due: chore.due_date || '',
      start: chore.start_date || today(),
      lock: recurring ? 'recurring' : 'once',
      error: '',
    };
  } else {
    state.draft = {
      id: '',
      title: '',
      description: '',
      points: '10',
      assignees: [],
      repeat: 'none',
      weekdays: [],
      due: '',
      start: today(),
      lock: '',
      error: '',
    };
  }
  state.panel = 'chore';
  render();
}

function toggleIn(list, value) {
  const has = list.includes(value);
  return has ? list.filter((x) => x !== value) : [...list, value];
}

async function saveChore() {
  const f = state.draft;
  const points = Number(f.points);
  if (!String(f.title || '').trim()) {
    f.error = 'Add a title.';
    render();
    return;
  }
  if (!Number.isInteger(points) || points < 1 || points > 100000) {
    f.error = 'Points should be a whole number from 1 to 100,000.';
    render();
    return;
  }
  if (!f.assignees?.length) {
    f.error = friendlyMessage('invalid_assignees');
    render();
    return;
  }
  if (f.repeat === 'weekly' && !(f.weekdays || []).length) {
    f.error = friendlyMessage('invalid_weekdays');
    render();
    return;
  }
  if (f.repeat === 'none' && f.due && today() && f.due < today()) {
    f.error = 'The due date can’t be before today.';
    render();
    return;
  }
  const payload = {
    p_title: f.title.trim(),
    p_points: points,
    p_assignees: f.assignees,
    p_description: String(f.description || '').trim() || null,
    p_repeat: f.repeat,
  };
  if (f.repeat === 'weekly') payload.p_weekdays = [...f.weekdays].map(Number).sort((a, b) => a - b);
  if (f.repeat === 'none') payload.p_due_date = f.due || null;
  if (f.repeat !== 'none' && f.start) payload.p_start_date = f.start;
  const editing = Boolean(f.id);
  state.busy = true;
  f.error = '';
  render();
  try {
    if (editing) await call('update_chore', { p_chore_id: f.id, ...payload });
    else await call('create_chore', payload);
    state.panel = null;
    state.busy = false;
    showToast(editing ? 'Chore saved' : 'Chore added');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function setArchived(id, archived) {
  state.busy = true;
  render();
  try {
    await call('set_chore_archived', { p_chore_id: id, p_archived: archived });
    state.panel = null;
    state.busy = false;
    showToast(archived ? 'Chore archived' : 'Chore is active again');
    await refresh({ quiet: true });
  } catch (err) {
    state.busy = false;
    noteError(err);
    render();
  }
}

async function submitComplete() {
  const instance = state.draft.instance;
  if (!instance) return;
  state.busy = true;
  state.draft.error = '';
  render();
  try {
    const params = { p_instance_id: instance.id };
    const note = String(state.draft.note || '').trim();
    if (note) params.p_note = note;
    if (state.photo?.base64) {
      params.p_photo_base64 = state.photo.base64;
      params.p_photo_mime = 'image/jpeg';
    }
    await call('complete_instance', params);
    state.panel = null;
    state.photo = null;
    state.busy = false;
    showToast(state.simple ? 'Sent! Nice work.' : 'Sent to a parent');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function approveInstance(id) {
  state.busy = true;
  render();
  try {
    const res = await call('approve_instance', { p_instance_id: id });
    state.busy = false;
    const bal = res?.kid_balance;
    showToast(Number.isFinite(Number(bal)) ? `Approved. Balance is now ${bal} points.` : 'Approved');
    await refresh({ quiet: true });
  } catch (err) {
    state.busy = false;
    noteError(err);
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'invalid_status')) {
      await loadCurrent().catch(() => {});
    }
    render();
  }
}

async function submitReject() {
  const note = String(state.draft.note || '').trim();
  if (!note) {
    state.draft.error = friendlyMessage('note_required');
    render();
    return;
  }
  state.busy = true;
  render();
  try {
    await call('reject_instance', { p_instance_id: state.draft.instanceId, p_note: note });
    state.panel = null;
    state.busy = false;
    showToast('Sent back');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function viewPhoto(id) {
  state.busy = true;
  render();
  try {
    state.draft = { ...(state.draft || {}), photo: await call('get_instance_photo', { p_instance_id: id }) };
    state.panel = 'photo';
    state.busy = false;
    render();
  } catch (err) {
    state.busy = false;
    noteError(err);
    render();
  }
}

async function submitAdjust() {
  const f = state.draft;
  const n = Number(f.amount);
  if (!Number.isInteger(n) || n < 1 || n > 100000) {
    f.error = 'Enter a whole number of points, from 1 to 100,000.';
    render();
    return;
  }
  if (!String(f.note || '').trim()) {
    f.error = friendlyMessage('note_required');
    render();
    return;
  }
  const delta = f.mode === 'take' ? -n : n;
  state.busy = true;
  render();
  try {
    await call('adjust_points', { p_kid: f.kidId, p_delta: delta, p_note: f.note.trim() });
    state.panel = null;
    state.busy = false;
    showToast(delta > 0 ? 'Points added' : 'Points updated');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function resetCode(mode) {
  const f = state.draft;
  let pin = null;
  if (mode === 'set') {
    if (!/^[0-9]{4}$/.test(f.newPin || '')) {
      f.error = friendlyMessage('invalid_pin_format');
      render();
      return;
    }
    pin = f.newPin;
  }
  state.busy = true;
  render();
  try {
    await call('reset_pin', { p_profile: f.profileId, p_new_pin: pin });
    state.panel = null;
    state.busy = false;
    showToast(pin ? 'New code saved' : 'Code cleared. They can choose a new one.');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

function ensureSettingsDraft() {
  if (state.draft.ready) return;
  state.draft = {
    ready: true,
    ratePoints: String(state.settings?.rate_points ?? 10),
    rateDollars: String(state.settings?.rate_dollars ?? 1),
    currentPin: '',
    newPin: '',
    confirmPin: '',
    rateError: '',
    pinError: '',
  };
}

async function saveRate() {
  const points = Number(state.draft.ratePoints);
  const dollars = Number(state.draft.rateDollars);
  if (!Number.isInteger(points) || points < 1 || points > 1000000) {
    state.draft.rateError = 'Points must be a whole number from 1 to 1,000,000.';
    render();
    return;
  }
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000) {
    state.draft.rateError = 'Dollars must be more than 0 and at most 100,000.';
    render();
    return;
  }
  state.busy = true;
  state.draft.rateError = '';
  render();
  try {
    state.settings = await call('update_settings', { p_rate_points: points, p_rate_dollars: Math.round(dollars * 100) / 100 });
    state.draft.ratePoints = String(state.settings.rate_points);
    state.draft.rateDollars = String(state.settings.rate_dollars);
    state.busy = false;
    showToast(`Saved. ${points} points = ${money(state.settings.rate_dollars)}`);
    await refresh({ quiet: true });
  } catch (err) {
    state.busy = false;
    if (err instanceof ApiError && err.code === 'invalid_rate') {
      state.draft.rateError = friendlyMessage(err.code, err.detail, 'parent');
      render();
      return;
    }
    noteError(err);
    render();
  }
}

async function changeOwnPin() {
  const f = state.draft;
  if (!/^[0-9]{4}$/.test(f.currentPin || '') || !/^[0-9]{4}$/.test(f.newPin || '')) {
    f.pinError = friendlyMessage('invalid_pin_format');
    render();
    return;
  }
  if (f.newPin !== f.confirmPin) {
    f.pinError = 'Those new codes don’t match.';
    render();
    return;
  }
  state.busy = true;
  f.pinError = '';
  render();
  try {
    await call('change_pin', { p_current_pin: f.currentPin, p_new_pin: f.newPin });
    f.currentPin = '';
    f.newPin = '';
    f.confirmPin = '';
    state.busy = false;
    showToast('Code changed. Other devices will need the new one.');
    render();
  } catch (err) {
    state.busy = false;
    if (err instanceof ApiError && (err.code === 'wrong_pin' || err.code === 'invalid_pin_format')) {
      f.pinError = err.code === 'wrong_pin' ? 'That current code isn’t right.' : friendlyMessage(err.code);
      render();
      return;
    }
    noteError(err);
    render();
  }
}

function openWishForm(wish, kidId) {
  const draft = {
    id: wish?.id || '',
    kidId: wish?.kid_id || kidId || (isParent() ? '' : state.me.id),
    title: wish?.title || '',
    link: wish?.link || '',
    costMode: 'dollars',
    amount: '',
    error: '',
  };
  if (wish && wish.points_cost != null) {
    draft.costMode = 'points';
    draft.amount = String(wish.points_cost);
  } else if (wish && wish.price_dollars != null) {
    draft.costMode = 'dollars';
    draft.amount = String(wish.price_dollars);
  }
  state.draft = draft;
  state.panel = 'wish';
  render();
}

async function saveWish() {
  const f = state.draft;
  if (!String(f.title || '').trim()) {
    f.error = 'Add a name for the wish.';
    render();
    return;
  }
  const link = String(f.link || '').trim();
  if (link && !safeUrl(link)) {
    f.error = friendlyMessage('invalid_link');
    render();
    return;
  }
  if (isParent() && !f.kidId) {
    f.error = friendlyMessage('invalid_kid');
    render();
    return;
  }
  const amount = Number(f.amount);
  if (f.costMode === 'dollars') {
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      f.error = 'Enter a price in dollars, like 4.50.';
      render();
      return;
    }
  } else if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) {
    f.error = 'Enter a whole number of points.';
    render();
    return;
  }
  const payload = {
    p_title: f.title.trim(),
    p_link: link || null,
    p_price_dollars: f.costMode === 'dollars' ? Math.round(amount * 100) / 100 : null,
    p_points_cost: f.costMode === 'points' ? amount : null,
  };
  if (isParent()) payload.p_kid = f.kidId;
  const editing = Boolean(f.id);
  state.busy = true;
  render();
  try {
    if (editing) await call('update_wish', { p_wish_id: f.id, ...payload });
    else await call('add_wish', payload);
    state.panel = null;
    state.busy = false;
    showToast(state.simple ? 'Wish saved' : 'Wish saved');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function removeWish(id) {
  state.busy = true;
  render();
  try {
    await call('remove_wish', { p_wish_id: id });
    state.panel = null;
    state.busy = false;
    showToast('Wish removed');
    await refresh({ quiet: true });
  } catch (err) {
    state.busy = false;
    noteError(err);
    render();
  }
}

async function submitRedeem() {
  state.busy = true;
  render();
  try {
    const params = { p_wish_id: state.draft.wishId };
    const note = String(state.draft.note || '').trim();
    if (note) params.p_note = note;
    await call('request_redeem', params);
    state.panel = null;
    state.busy = false;
    showToast(state.simple ? 'Asked Mom or Dad' : 'Asked a parent');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function cancelRedeem(id) {
  state.busy = true;
  render();
  try {
    await call('cancel_redeem', { p_request_id: id });
    state.busy = false;
    showToast(state.simple ? 'Cancelled' : 'Request cancelled');
    await refresh({ quiet: true });
  } catch (err) {
    state.busy = false;
    noteError(err);
    render();
  }
}

async function submitDecision() {
  const f = state.draft;
  state.busy = true;
  render();
  try {
    const params = { p_request_id: f.requestId, p_approve: f.approve === true };
    const note = String(f.note || '').trim();
    if (note) params.p_note = note;
    await call('decide_redeem', params);
    state.panel = null;
    state.busy = false;
    showToast(f.approve ? 'Wish approved' : 'Request declined');
    await refresh({ quiet: true });
  } catch (err) {
    failForm(err);
  }
}

async function openNotifs() {
  state.notifOpen = true;
  state.loadingNotifs = true;
  state.notifications = [];
  render();
  try {
    state.notifications = asArray(await call('list_notifications', { p_limit: 50 }));
  } catch (err) {
    noteError(err);
  } finally {
    state.loadingNotifs = false;
    render();
  }
}

async function markAllRead() {
  try {
    await call('mark_notifications_read');
    state.notifications.forEach((n) => { n.unread = false; });
    state.unread = 0;
    render();
  } catch (err) {
    noteError(err);
    render();
  }
}

async function openNotif(id) {
  const n = state.notifications.find((item) => item.id === id);
  try {
    if (n?.unread) {
      await call('mark_notifications_read', { p_ids: [id] });
      n.unread = false;
      state.unread = Math.max(0, state.unread - 1);
    }
  } catch (err) {
    noteError(err);
  }
  state.notifOpen = false;
  if (n?.instance_id) state.tab = isParent() ? 'approvals' : 'today';
  else if (n && (n.redeem_id || n.wish_id || String(n.kind).startsWith('redeem') || n.kind === 'wish_added')) state.tab = 'wishes';
  else if (n && (n.kind === 'points_bonus' || n.kind === 'points_adjusted')) state.tab = isParent() ? 'kids' : 'points';
  else if (n && (n.kind === 'pin_locked' || n.kind === 'pin_reset')) state.tab = isParent() ? 'kids' : 'today';
  await refresh();
}

async function onPhotoPicked(file) {
  if (!file) return;
  state.busy = true;
  render();
  try {
    const base64 = await fileToJpegBase64(file);
    state.photo = { base64 };
    state.draft.error = '';
  } catch (err) {
    state.photo = null;
    state.draft.error = friendlyMessage(err?.code || 'invalid_photo', '', state.me?.role || '');
  } finally {
    state.busy = false;
    render();
  }
}

function askConfirm(opts) {
  state.panel = 'confirm';
  state.draft = { ...opts, error: '' };
  render();
}

async function onAction(act, el) {
  if (state.busy && act !== 'back-picker') return;
  const id = el.dataset.id || '';
  const value = el.dataset.value || '';
  if (act === 'retry-boot') return boot();
  if (act === 'pick') return pickProfile(id);
  if (act === 'pin') return pressPin(el.dataset.key || '');
  if (act === 'back-picker') {
    pinGen += 1;
    clearTimeout(pinTimer);
    state.busy = false;
    state.screen = 'picker';
    state.pin = emptyPin();
    try { state.profiles = asArray(await rpc('list_profiles')); } catch { /* keep */ }
    render();
    return;
  }
  if (act === 'switch') return switchAccount();
  if (act === 'refresh') return refresh();
  if (act === 'tab') return setTab(value);
  if (act === 'notifs') return openNotifs();
  if (act === 'close-notifs') {
    state.notifOpen = false;
    render();
    return;
  }
  if (act === 'mark-all') return markAllRead();
  if (act === 'open-notif') return openNotif(id);
  if (act === 'new-chore') return openChoreForm(null);
  if (act === 'edit-chore') {
    const chore = state.chores.find((c) => c.id === id);
    if (chore) openChoreForm(chore);
    return;
  }
  if (act === 'assignee') {
    state.draft.assignees = toggleIn(state.draft.assignees || [], id);
    render();
    return;
  }
  if (act === 'repeat') {
    if (state.draft.lock === 'once' && value !== 'none') return;
    if (state.draft.lock === 'recurring' && value === 'none') return;
    state.draft.repeat = value;
    if (value === 'weekly' && !(state.draft.weekdays || []).length && today()) {
      state.draft.weekdays = [isoDow(today())];
    }
    render();
    return;
  }
  if (act === 'weekday') {
    const n = Number(value);
    state.draft.weekdays = toggleIn(state.draft.weekdays || [], n);
    render();
    return;
  }
  if (act === 'save-chore') return saveChore();
  if (act === 'close-panel') {
    state.panel = null;
    state.photo = null;
    render();
    return;
  }
  if (act === 'archive-ask') {
    const chore = state.chores.find((c) => c.id === id);
    askConfirm({
      title: chore?.archived ? 'Bring this chore back?' : 'Archive this chore?',
      body: chore?.archived
        ? 'It will show up again from today. Missed days stay missed.'
        : 'It stops showing up. History stays.',
      ok: chore?.archived ? 'Bring back' : 'Archive',
      next: chore?.archived ? 'unarchive' : 'archive',
      id,
    });
    return;
  }
  if (act === 'confirm-yes') {
    if (state.draft.next === 'archive') return setArchived(state.draft.id, true);
    if (state.draft.next === 'unarchive') return setArchived(state.draft.id, false);
    if (state.draft.next === 'remove-wish') return removeWish(state.draft.id);
    return;
  }
  if (act === 'toggle-archived') {
    state.showArchived = !state.showArchived;
    return refresh();
  }
  if (act === 'complete') {
    const instance = state.instances.find((item) => item.id === id);
    if (!instance) return;
    state.photo = null;
    state.draft = { instance, note: '', error: '' };
    state.panel = 'complete';
    render();
    return;
  }
  if (act === 'pick-camera') {
    document.getElementById('photo-camera')?.click();
    return;
  }
  if (act === 'pick-library') {
    document.getElementById('photo-library')?.click();
    return;
  }
  if (act === 'clear-photo') {
    state.photo = null;
    render();
    return;
  }
  if (act === 'submit-complete') return submitComplete();
  if (act === 'approve') return approveInstance(id);
  if (act === 'reject') {
    const instance = state.approvals.find((item) => item.id === id);
    state.draft = { instanceId: id, title: instance?.title || 'Chore', note: '', error: '' };
    state.panel = 'reject';
    render();
    return;
  }
  if (act === 'submit-reject') return submitReject();
  if (act === 'photo') return viewPhoto(id);
  if (act === 'ledger') {
    if (state.ledgerKid === id) {
      state.ledgerKid = '';
      state.ledger = [];
      render();
      return;
    }
    state.ledgerKid = id;
    return refresh({ quiet: true });
  }
  if (act === 'adjust') {
    const kid = state.balances.find((b) => b.kid_id === id);
    state.draft = { kidId: id, kidName: kid?.name || 'Kid', amount: '', note: '', mode: 'bonus', error: '' };
    state.panel = 'adjust';
    render();
    return;
  }
  if (act === 'adjust-mode') {
    state.draft.mode = value;
    render();
    return;
  }
  if (act === 'submit-adjust') return submitAdjust();
  if (act === 'reset') {
    const profile = state.profiles.find((p) => p.id === id);
    state.draft = { profileId: id, name: profile?.name || 'Them', newPin: '', error: '', confirm: false };
    state.panel = 'reset';
    render();
    return;
  }
  if (act === 'reset-ask') {
    state.draft.confirm = true;
    render();
    return;
  }
  if (act === 'reset-clear') return resetCode('clear');
  if (act === 'reset-set') return resetCode('set');
  if (act === 'save-rate') return saveRate();
  if (act === 'change-pin') return changeOwnPin();
  if (act === 'new-wish') return openWishForm(null, isParent() ? (kidProfiles()[0]?.id || '') : state.me.id);
  if (act === 'edit-wish') {
    const wish = state.wishes.find((w) => w.id === id);
    if (wish) openWishForm(wish);
    return;
  }
  if (act === 'wish-kid') {
    state.draft.kidId = id;
    render();
    return;
  }
  if (act === 'cost-mode') {
    state.draft.costMode = value;
    render();
    return;
  }
  if (act === 'save-wish') return saveWish();
  if (act === 'remove-wish') {
    const wish = state.wishes.find((w) => w.id === id);
    askConfirm({
      title: 'Remove this wish?',
      body: wish ? `“${wish.title}” will leave the list.` : 'It will leave the list.',
      ok: 'Remove',
      next: 'remove-wish',
      id,
    });
    return;
  }
  if (act === 'redeem') {
    const wish = state.wishes.find((w) => w.id === id);
    state.draft = { wishId: id, title: wish?.title || 'Wish', note: '', error: '' };
    state.panel = 'redeem';
    render();
    return;
  }
  if (act === 'submit-redeem') return submitRedeem();
  if (act === 'cancel-redeem') return cancelRedeem(id);
  if (act === 'decide') {
    const req = state.redeems.find((r) => r.id === id);
    state.draft = {
      requestId: id,
      title: req?.wish_title || 'Wish',
      kidName: req?.kid_name || '',
      points: req?.points,
      approve: value === 'yes',
      note: '',
      error: '',
    };
    state.panel = 'decide';
    render();
    return;
  }
  if (act === 'submit-decide') return submitDecision();
  if (act === 'toggle-closed') {
    state.showClosed = !state.showClosed;
    return refresh();
  }
  if (act === 'toggle-earlier') {
    state.showEarlier = !state.showEarlier;
    render();
  }
}

function button(label, act, opts = {}) {
  const kind = opts.kind || 'primary';
  const dis = state.busy && kind !== 'text' ? 'disabled' : '';
  const id = opts.id ? ` data-id="${esc(opts.id)}"` : '';
  const value = opts.value ? ` data-value="${esc(opts.value)}"` : '';
  const test = opts.test ? ` data-testid="${esc(opts.test)}"` : '';
  return `<button type="button" class="btn ${kind === 'primary' ? '' : kind}" data-act="${act}"${id}${value}${test} ${dis}>${esc(label)}</button>`;
}

function field(label, bind, opts = {}) {
  const value = opts.value ?? '';
  const max = opts.maxlength ? ` maxlength="${opts.maxlength}"` : '';
  const mode = opts.inputmode ? ` inputmode="${opts.inputmode}"` : '';
  const placeholder = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
  const mask = opts.mask ? ' mask' : '';
  const common = `id="f-${bind}" data-bind="${bind}"${max}${mode}${placeholder} class="${mask.trim()}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"`;
  const control = opts.multiline
    ? `<textarea ${common} rows="3">${esc(value)}</textarea>`
    : `<input ${common} type="${opts.type || 'text'}" value="${esc(value)}"${opts.min ? ` min="${esc(opts.min)}"` : ''}${opts.max ? ` max="${esc(opts.max)}"` : ''}>`;
  return `<label class="field" for="f-${bind}"><span>${esc(label)}</span>${control}</label>`;
}

function statusPill(status) {
  const map = {
    open: ['To do', 'open'],
    submitted: [state.simple ? 'Waiting' : 'Waiting', 'wait'],
    approved: [state.simple ? 'Done' : 'Approved', 'good'],
    rejected: [state.simple ? 'Try again' : 'Try again', 'warn'],
    lapsed: ['Missed', 'missed'],
  };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function emptyBlock(emoji, text) {
  return `<div class="empty"><div class="empty-emoji">${emoji}</div><p>${esc(text)}</p></div>`;
}

function loadingBlock() {
  return `<div class="loading" role="status"><div class="spinner"></div><p>Loading…</p></div>`;
}

function hero(b) {
  if (!b) return '';
  const waiting = Number(b.awaiting_approval_points) || 0;
  const pending = Number(b.pending_redeem_points) || 0;
  const availableDiff = Number(b.available_points) !== Number(b.points);
  return `<section class="hero" data-testid="balance" data-points="${Number(b.points) || 0}" data-dollars="${Number(b.dollars) || 0}">
    <p class="hero-points">${esc(pointsWord(b.points, state.simple))}</p>
    <p class="hero-money">${esc(money(b.dollars))}</p>
    ${waiting ? `<p class="hero-sub">${state.simple ? `${waiting} ⭐ waiting to be checked` : `${waiting} points waiting for approval`}</p>` : ''}
    ${pending ? `<p class="hero-sub">${state.simple ? `${pending} ⭐ on a wish` : `${pending} points held for a wish`}</p>` : ''}
    ${availableDiff ? `<p class="hero-sub">${state.simple ? `${b.available_points} ⭐ you can use` : `${b.available_points} points free to spend · ${esc(money(b.available_dollars))}`}</p>` : ''}
  </section>`;
}

function instanceMeta(item) {
  const when = item.due_date
    ? `Due ${formatDate(item.due_date, today())}`
    : (item.period_date ? formatDate(item.period_date, today()) : 'Anytime');
  const who = isParent() && item.kid_name ? `${item.kid_name} · ` : '';
  return `${who}${when} · ${pointsWord(item.points, state.simple)} · ${money(item.dollars)}`;
}

function kidInstanceCard(item) {
  const lapsed = item.status === 'lapsed';
  const rejected = item.status === 'rejected';
  const label = rejected ? (state.simple ? 'Try again' : 'Redo') : (state.simple ? 'I did it!' : 'Mark done');
  return `<article class="card ${lapsed ? 'lapsed' : ''}" data-id="${esc(item.id)}">
    <div class="card-top"><h3>${esc(item.title)}</h3>${statusPill(item.status)}</div>
    ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ''}
    <p class="meta">${esc(instanceMeta(item))}</p>
    ${item.review_note ? `<p class="note">${item.reviewed_by_name ? `<strong>${esc(item.reviewed_by_name)}:</strong> ` : ''}${esc(item.review_note)}</p>` : ''}
    ${item.status === 'submitted' ? `<p class="meta">${state.simple ? 'Waiting for Mom or Dad' : 'Waiting for a parent'}${item.has_photo ? ' · photo added' : ''}</p>` : ''}
    ${item.can_complete ? `<div class="row">${button(label, 'complete', { id: item.id, test: 'complete' })}</div>` : ''}
  </article>`;
}

function approvalCard(item) {
  return `<article class="card" data-testid="approval" data-id="${esc(item.id)}">
    <div class="card-top"><h3>${esc(item.title)}</h3>${statusPill(item.status)}</div>
    ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ''}
    <p class="meta">${esc(instanceMeta(item))}</p>
    ${item.kid_note ? `<p class="note">${esc(item.kid_name)} said: ${esc(item.kid_note)}</p>` : ''}
    ${item.has_photo ? `<p class="meta">Photo attached</p>` : ''}
    <div class="row">
      ${item.has_photo ? button('See photo', 'photo', { id: item.id, kind: 'secondary' }) : ''}
      ${button('Approve', 'approve', { id: item.id, test: 'approve' })}
      ${button('Send back', 'reject', { id: item.id, kind: 'secondary' })}
    </div>
  </article>`;
}

function section(title, body) {
  return `<section class="section"><h2>${esc(title)}</h2><div class="stack" style="margin-top:10px">${body}</div></section>`;
}

function renderKidToday() {
  const groups = { todo: [], upcoming: [], waiting: [], missed: [], doneToday: [], doneEarlier: [] };
  const day = today();
  for (const item of state.instances) {
    if (item.status === 'lapsed') groups.missed.push(item);
    else if (item.status === 'submitted') groups.waiting.push(item);
    else if (item.status === 'approved') {
      if (item.period_date === day) groups.doneToday.push(item);
      else groups.doneEarlier.push(item);
    } else if (item.due_date && day && item.due_date > day) groups.upcoming.push(item);
    else groups.todo.push(item);
  }
  const parts = [hero(myBalance())];
  if (!state.instances.length && !state.loading) {
    parts.push(emptyBlock('🌟', state.simple ? 'Nothing to do. Yay!' : 'Nothing on your list right now.'));
  }
  if (groups.todo.length) parts.push(section(state.simple ? 'To do' : 'Today', groups.todo.map(kidInstanceCard).join('')));
  if (groups.upcoming.length) parts.push(section(state.simple ? 'Later' : 'Coming up', groups.upcoming.map(kidInstanceCard).join('')));
  if (groups.waiting.length) parts.push(section(state.simple ? 'Waiting' : 'Waiting for a parent', groups.waiting.map(kidInstanceCard).join('')));
  if (groups.missed.length) parts.push(section('Missed', groups.missed.map(kidInstanceCard).join('')));
  if (groups.doneToday.length) parts.push(section(state.simple ? 'Done today' : 'Done today', groups.doneToday.map(kidInstanceCard).join('')));
  if (groups.doneEarlier.length) {
    parts.push(`<button type="button" class="btn ghost" data-act="toggle-earlier">${state.showEarlier ? 'Hide earlier' : `Earlier (${groups.doneEarlier.length})`}</button>`);
    if (state.showEarlier) parts.push(`<div class="stack">${groups.doneEarlier.map(kidInstanceCard).join('')}</div>`);
  }
  parts.push(`<p class="hint">${state.simple ? 'Repeating chores pop up on the right day.' : 'Repeating chores show up on the morning they’re due. Times use New Zealand time.'}</p>`);
  return parts.join('');
}

function wishCard(w) {
  const cost = Number(w.cost_points) || 0;
  const avail = Math.max(0, Number(w.available_points) || 0);
  const pct = cost > 0 ? Math.max(0, Math.min(100, Math.round((avail / cost) * 100))) : 0;
  const link = safeUrl(w.link);
  const pending = w.pending_request;
  const redeemed = w.status === 'redeemed';
  const mine = !isParent();
  let actions = '';
  if (!redeemed && !pending) {
    if (mine && w.eligible) actions += button(state.simple ? 'Ask for this' : 'Redeem', 'redeem', { id: w.id, test: 'redeem' });
    actions += button('Edit', 'edit-wish', { id: w.id, kind: 'secondary' });
    actions += button('Remove', 'remove-wish', { id: w.id, kind: 'ghost' });
  }
  if (pending && mine) actions += button(state.simple ? 'Cancel' : 'Cancel request', 'cancel-redeem', { id: pending.id, kind: 'secondary' });
  return `<article class="card" data-testid="wish" data-id="${esc(w.id)}">
    <div class="card-top">
      <h3>${esc(w.title)}</h3>
      ${redeemed ? '<span class="pill good">Redeemed</span>' : (pending ? '<span class="pill wait">Waiting</span>' : (w.eligible ? '<span class="pill good">Ready</span>' : ''))}
    </div>
    ${isParent() ? `<p class="meta">${esc(w.kid_name)}</p>` : ''}
    <p class="meta">${esc(pointsWord(w.cost_points, state.simple))} · ${esc(money(w.cost_dollars))}</p>
    ${link ? `<p class="meta"><a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${state.simple ? 'Open link' : 'Open link'}</a></p>` : ''}
    ${!redeemed && !w.eligible ? `<div class="bar" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
      <p class="meta">${state.simple ? `Need ${w.points_needed} more ⭐` : `${w.points_needed} more points to go`}</p>` : ''}
    ${pending ? `<p class="meta">${state.simple ? 'Waiting for Mom or Dad' : 'Waiting for parents'}</p>` : ''}
    ${actions ? `<div class="row">${actions}</div>` : ''}
  </article>`;
}

function renderWishes() {
  const bits = [];
  if (!isParent() && myBalance()) {
    bits.push(`<p class="strip" data-testid="balance" data-points="${Number(myBalance().points) || 0}">${esc(pointsWord(myBalance().points, state.simple))} · ${esc(money(myBalance().dollars))}</p>`);
  }
  if (isParent() && state.redeems.length) {
    const cards = state.redeems.map((r) => `<article class="card" data-testid="redeem" data-id="${esc(r.id)}">
      <div class="card-top"><h3>${esc(r.wish_title)}</h3><span class="pill wait">Please decide</span></div>
      <p class="meta">${esc(r.kid_name)} · ${esc(pointsWord(r.points, false))} · ${esc(money(r.dollars))}</p>
      <p class="meta">Balance ${esc(String(r.kid_balance))} points</p>
      ${r.kid_note ? `<p class="note">${esc(r.kid_name)} said: ${esc(r.kid_note)}</p>` : ''}
      ${safeUrl(r.wish_link) ? `<p class="meta"><a class="link" href="${esc(safeUrl(r.wish_link))}" target="_blank" rel="noopener noreferrer">Open link</a></p>` : ''}
      ${Number(r.kid_balance) < Number(r.points) ? `<p class="form-error">Not enough points to approve right now.</p>` : ''}
      <div class="row">
        ${button('Approve', 'decide', { id: r.id, value: 'yes', test: 'decide-yes' })}
        ${button('Decline', 'decide', { id: r.id, value: 'no', kind: 'secondary' })}
      </div>
    </article>`).join('');
    bits.push(section('Redeem requests', cards));
  }
  bits.push(`<div class="row" style="margin-top:12px">
    ${button(state.simple ? 'New wish' : (isParent() ? 'Add a wish' : 'Add a wish'), 'new-wish', { test: 'new-wish' })}
    ${button(state.showClosed ? 'Hide old ones' : 'Show redeemed', 'toggle-closed', { kind: 'ghost' })}
  </div>`);
  if (!state.wishes.length && !state.loading) {
    bits.push(emptyBlock('🎁', state.simple ? 'No wishes yet. Add one!' : 'No wishes yet.'));
  } else {
    bits.push(`<div class="stack" style="margin-top:12px">${state.wishes.map(wishCard).join('')}</div>`);
  }
  return bits.join('');
}

function ledgerList(rows) {
  if (!rows.length) return emptyBlock('📒', 'No points history yet.');
  return `<ul class="list">${rows.map((row) => {
    const delta = Number(row.delta) || 0;
    const sign = delta > 0 ? '+' : '';
    const icon = { chore: '✅', redeem: '🎁', bonus: '🌟', adjust: '✏️' }[row.kind] || '•';
    return `<li class="ledger">
      <span class="ledger-icon" aria-hidden="true">${icon}</span>
      <div>
        <div class="ledger-note">${esc(row.note || row.kind)}</div>
        <div class="muted">${esc(formatStamp(row.created_at))}${row.created_by_name ? ` · ${esc(row.created_by_name)}` : ''}</div>
      </div>
      <div class="ledger-amt ${delta < 0 ? 'neg' : 'pos'}"><div>${sign}${delta}</div><div class="muted">${esc(money(row.dollars))}</div></div>
    </li>`;
  }).join('')}</ul>`;
}

function renderKidPoints() {
  return `${hero(myBalance())}<h2 class="section">History</h2>${ledgerList(state.ledger)}`;
}

function renderApprovals() {
  if (!state.approvals.length) {
    return emptyBlock('🎉', 'All caught up. Nothing is waiting for a yes.');
  }
  return `<div class="stack">${state.approvals.map(approvalCard).join('')}</div>`;
}

function renderChores() {
  const cards = state.chores.map((c) => `<article class="card ${c.archived ? 'lapsed' : ''}" data-testid="chore">
    <div class="card-top"><h3>${esc(c.title)}</h3>${c.archived ? '<span class="pill missed">Archived</span>' : ''}</div>
    ${c.description ? `<p class="desc">${esc(c.description)}</p>` : ''}
    <p class="meta">${esc(pointsWord(c.points, false))} · ${esc(money(c.dollars))}</p>
    <p class="meta">${esc(repeatLabel(c, today()))}</p>
    <p class="meta">${esc((c.assignees || []).map((a) => a.name).join(' & ') || 'No one')}</p>
    <div class="row">
      ${button('Edit', 'edit-chore', { id: c.id, kind: 'secondary' })}
      ${button(c.archived ? 'Bring back' : 'Archive', 'archive-ask', { id: c.id, kind: 'ghost' })}
    </div>
  </article>`).join('');
  return `<div class="row">
      ${button('Add a chore', 'new-chore', { test: 'new-chore' })}
      ${button(state.showArchived ? 'Hide archived' : 'Show archived', 'toggle-archived', { kind: 'ghost' })}
    </div>
    ${state.chores.length ? `<div class="stack two" style="margin-top:12px">${cards}</div>` : emptyBlock('📋', 'No chores yet. Add the first one.')}`;
}

function codeButton(profile) {
  const locked = profile.locked_until && new Date(profile.locked_until).getTime() > Date.now();
  const detail = locked
    ? `Locked until ${formatStamp(profile.locked_until)}`
    : (profile.has_pin ? 'Code is set' : 'No code yet');
  return `<div class="card">
    <div class="card-top"><h3>${esc(profile.avatar || '')} ${esc(profile.name)}</h3></div>
    <p class="meta">${esc(detail)}</p>
    <div class="row">${button('Reset code', 'reset', { id: profile.id, kind: 'secondary' })}</div>
  </div>`;
}

function renderKids() {
  const cards = state.balances.map((b) => {
    const open = state.ledgerKid === b.kid_id;
    return `<article class="card" data-testid="kid-balance" data-points="${Number(b.points) || 0}" data-kid="${esc(b.name)}">
      <div class="card-top">
        <h3>${esc(b.avatar || '')} ${esc(b.name)}</h3>
        <span class="pill">${esc(money(b.dollars))}</span>
      </div>
      <p class="hero-points" style="font-size:2rem">${esc(pointsWord(b.points, false))}</p>
      <p class="meta">${b.available_points} free · ${b.pending_redeem_points} on wishes · ${b.awaiting_approval_count} to approve</p>
      <div class="row">
        ${button(open ? 'Hide history' : 'History', 'ledger', { id: b.kid_id, kind: 'secondary' })}
        ${button('Give or take', 'adjust', { id: b.kid_id, kind: 'secondary' })}
      </div>
      ${open ? ledgerList(state.ledger) : ''}
    </article>`;
  }).join('');
  const parents = state.profiles.filter((p) => p.role === 'parent' && p.id !== state.me.id);
  const kids = kidProfiles();
  const me = state.profiles.find((p) => p.id === state.me.id) || state.me;
  return `<div class="stack">${cards}</div>
    <h2 class="section">Codes</h2>
    <p class="hint">Clear a code so they pick a new one, or set one for them. This also removes a lock.</p>
    <div class="stack" style="margin-top:10px">
      ${kids.map(codeButton).join('')}
      ${parents.map(codeButton).join('')}
      ${codeButton(me)}
    </div>`;
}

function renderSettings() {
  ensureSettingsDraft();
  const f = state.draft;
  const others = state.profiles.filter((p) => p.role === 'parent');
  return `<article class="card">
      <h2>Points to dollars</h2>
      <p class="hint">Now ${esc(String(state.settings?.rate_points))} points = ${esc(money(state.settings?.rate_dollars))}. Money is NZD. Dates use New Zealand time.</p>
      ${field('Points', 'ratePoints', { value: f.ratePoints, inputmode: 'numeric', maxlength: '7' })}
      ${field('Equals dollars', 'rateDollars', { value: f.rateDollars, inputmode: 'decimal', maxlength: '10' })}
      <p class="form-error">${esc(f.rateError || '')}</p>
      <div class="row">${button('Save rate', 'save-rate')}</div>
    </article>
    <article class="card" style="margin-top:12px">
      <h2>Your code</h2>
      <p class="hint">Changing it signs out your other devices. It does not lock you out if you mistype the current code.</p>
      ${field('Current code', 'currentPin', { value: f.currentPin, inputmode: 'numeric', maxlength: '4', mask: true })}
      ${field('New code', 'newPin', { value: f.newPin, inputmode: 'numeric', maxlength: '4', mask: true })}
      ${field('New code again', 'confirmPin', { value: f.confirmPin, inputmode: 'numeric', maxlength: '4', mask: true })}
      <p class="form-error">${esc(f.pinError || '')}</p>
      <div class="row">${button('Change code', 'change-pin')}</div>
    </article>
    <p class="hint">Parents on this family: ${esc(others.map((p) => p.name).join(' and ') || 'just you')}.</p>`;
}

function renderMain() {
  if (state.loading) return loadingBlock();
  if (isParent()) {
    if (state.tab === 'approvals') return renderApprovals();
    if (state.tab === 'chores') return renderChores();
    if (state.tab === 'kids') return renderKids();
    if (state.tab === 'wishes') return renderWishes();
    return renderSettings();
  }
  if (state.tab === 'wishes') return renderWishes();
  if (state.tab === 'points') return renderKidPoints();
  return renderKidToday();
}

function renderTabs() {
  const count = (n) => (n > 0 ? `<span class="tab-count">${n > 9 ? '9+' : n}</span>` : '');
  const tab = (id, icon, label, n) => {
    const on = state.tab === id;
    return `<button type="button" class="tab ${on ? 'on' : ''}" data-act="tab" data-value="${id}" aria-current="${on ? 'page' : 'false'}">
      <span class="tab-icon" aria-hidden="true">${icon}</span><span>${label}</span>${count(n)}
    </button>`;
  };
  if (isParent()) {
    return `<nav class="tabbar" aria-label="Parent">
      ${tab('approvals', '✅', 'Approve', state.approvals.length)}
      ${tab('chores', '📋', 'Chores', 0)}
      ${tab('kids', '💛', 'Kids', 0)}
      ${tab('wishes', '🎁', 'Wishes', state.redeems.length)}
      ${tab('settings', '⚙️', 'Settings', 0)}
    </nav>`;
  }
  return `<nav class="tabbar" aria-label="Home">
    ${tab('today', '🌟', state.simple ? 'Today' : 'Today', 0)}
    ${tab('wishes', '🎁', state.simple ? 'Wishes' : 'Wishes', 0)}
    ${tab('points', '⭐', 'Points', 0)}
  </nav>`;
}

function renderHeader() {
  const p = state.me;
  const unread = state.unread > 0;
  return `<header class="header">
    <div class="who">
      <span class="avatar sm" style="background:${safeColor(p.color)}22">${esc(p.avatar || '')}</span>
      <div>
        <div class="who-name">${esc(p.name)}</div>
        <div class="who-sub">${isParent() ? 'Parent' : (state.simple ? 'Hi!' : `Age ${p.age}`)}</div>
      </div>
    </div>
    <div class="header-actions">
      <button type="button" class="icon-btn" data-act="refresh" aria-label="Refresh">↻</button>
      <button type="button" class="icon-btn" data-act="notifs" aria-label="Notifications">
        <span aria-hidden="true">🔔</span>
        <span class="badge" data-badge ${unread ? '' : 'hidden'}>${state.unread > 9 ? '9+' : state.unread}</span>
      </button>
      <button type="button" class="text-btn" data-act="switch">Switch</button>
    </div>
  </header>`;
}

function renderNotifs() {
  if (!state.notifOpen) return '';
  const anyUnread = state.notifications.some((n) => n.unread);
  const list = state.loadingNotifs
    ? loadingBlock()
    : (state.notifications.length
      ? state.notifications.map((n) => `<button type="button" class="notif ${n.unread ? 'unread' : ''}" data-act="open-notif" data-id="${esc(n.id)}">
          <span class="notif-icon" aria-hidden="true">${KIND_ICON[n.kind] || '🔔'}</span>
          <span>
            <span class="notif-title">${esc(n.title)}</span>
            ${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ''}
            <span class="muted">${esc(formatStamp(n.created_at))}${n.unread ? ' · new' : ''}</span>
          </span>
        </button>`).join('')
      : emptyBlock('🔔', 'No notifications yet.'));
  return `<div class="backdrop" data-backdrop="notifs">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="notif-title">
      <div class="grab"></div>
      <div class="sheet-head">
        <h2 id="notif-title">Notifications</h2>
        <button type="button" class="text-btn" data-act="close-notifs">Close</button>
      </div>
      ${anyUnread ? `<div class="row">${button('Mark all read', 'mark-all', { kind: 'secondary' })}</div>` : ''}
      ${list}
    </div>
  </div>`;
}

function chip(label, act, on, extra) {
  return `<button type="button" class="chip ${on ? 'on' : ''}" data-act="${act}" ${extra} aria-pressed="${on ? 'true' : 'false'}">${esc(label)}</button>`;
}

function renderPanel() {
  if (!state.panel) return '';
  const f = state.draft || {};
  let body = '';
  let title = '';
  if (state.panel === 'chore') {
    title = f.id ? 'Edit chore' : 'New chore';
    const kids = kidProfiles();
    const repeats = f.lock === 'once'
      ? [['none', 'Once']]
      : (f.lock === 'recurring' ? [['daily', 'Every day'], ['weekly', 'Weekly']] : [['none', 'Once'], ['daily', 'Every day'], ['weekly', 'Weekly']]);
    body = `<form data-act="save-chore">
      ${field('Title', 'title', { value: f.title, maxlength: '120', placeholder: 'Feed the cat' })}
      ${field('Details', 'description', { value: f.description, maxlength: '2000', multiline: true, placeholder: 'Optional' })}
      ${field('Points', 'points', { value: f.points, inputmode: 'numeric', maxlength: '6' })}
      <p class="hint">Who is it for?</p>
      <div class="row">${kids.map((k) => chip(`${k.avatar || ''} ${k.name}`, 'assignee', (f.assignees || []).includes(k.id), `data-id="${esc(k.id)}"`)).join('')}</div>
      <p class="hint">How often?</p>
      <div class="row">${repeats.map(([val, label]) => chip(label, 'repeat', f.repeat === val, `data-value="${val}"`)).join('')}</div>
      ${f.lock === 'once' ? '<p class="hint">This one stays a one-off. Archive it and add a new chore if it should repeat.</p>' : ''}
      ${f.lock === 'recurring' ? '<p class="hint">Repeating chores can’t turn into a one-off. Add a new chore for that.</p>' : ''}
      ${f.repeat === 'none' ? field('Due date', 'due', { type: 'date', value: f.due, min: today() }) : ''}
      ${f.repeat === 'none' ? '<p class="hint">Leave the date empty if it can be done any time. It will not expire.</p>' : ''}
      ${f.repeat !== 'none' ? field('Starts', 'start', { type: 'date', value: f.start || today(), min: f.id ? '' : today() }) : ''}
      ${f.repeat === 'weekly' ? `<p class="hint">Which days?</p><div class="row">${WEEKDAYS.map((d) => chip(d.short, 'weekday', (f.weekdays || []).includes(d.n), `data-value="${d.n}"`)).join('')}</div>` : ''}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row" style="margin-top:12px">${button(f.id ? 'Save chore' : 'Add chore', 'save-chore')}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>
    </form>`;
  } else if (state.panel === 'complete') {
    const item = f.instance || {};
    title = state.simple ? 'I did it!' : 'Mark done';
    body = `<p class="lede">${esc(item.title || '')}</p>
      <p class="meta">${esc(pointsWord(item.points, state.simple))} when a parent says yes</p>
      ${field(state.simple ? 'Note (optional)' : 'Note for a parent (optional)', 'note', { value: f.note || '', maxlength: '500', multiline: true })}
      <div class="row" style="margin-top:12px">
        ${button('Take photo', 'pick-camera', { kind: 'secondary' })}
        ${button('Choose photo', 'pick-library', { kind: 'secondary' })}
        ${state.photo ? button('Remove photo', 'clear-photo', { kind: 'ghost' }) : ''}
      </div>
      <input id="photo-camera" class="file-input" type="file" accept="image/*" capture="environment">
      <input id="photo-library" class="file-input" type="file" accept="image/*">
      ${state.photo ? `<img class="preview" alt="Photo you are sending" src="data:image/jpeg;base64,${state.photo.base64}">` : ''}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button(state.simple ? 'Send' : 'Send to parent', 'submit-complete', { test: 'submit-complete' })}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'reject') {
    title = 'Send back';
    body = `<p class="lede">${esc(f.title || '')}</p>
      <p class="hint">A note is required. The kid sees it and can try again.</p>
      ${field('Note', 'note', { value: f.note || '', maxlength: '500', multiline: true, placeholder: 'What needs another go?' })}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button('Send back', 'submit-reject')}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'photo') {
    title = 'Photo';
    const photo = f.photo || {};
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(photo.mime) ? photo.mime : '';
    const b64 = /^[A-Za-z0-9+/=\s]+$/.test(photo.base64 || '') ? String(photo.base64).replace(/\s/g, '') : '';
    body = mime && b64
      ? `<img class="preview" alt="Chore photo" src="data:${mime};base64,${b64}"><div class="row">${button('Close', 'close-panel', { kind: 'secondary' })}</div>`
      : `<p>That photo couldn’t be shown.</p>`;
  } else if (state.panel === 'adjust') {
    title = `Points for ${f.kidName || ''}`;
    body = `<div class="row">
        ${chip('Give points', 'adjust-mode', f.mode !== 'take', 'data-value="bonus"')}
        ${chip('Take points', 'adjust-mode', f.mode === 'take', 'data-value="take"')}
      </div>
      ${field('How many', 'amount', { value: f.amount || '', inputmode: 'numeric', maxlength: '6' })}
      ${field('Note', 'note', { value: f.note || '', maxlength: '500', placeholder: 'Why?' })}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button('Save', 'submit-adjust')}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'reset') {
    title = `Code for ${f.name || ''}`;
    body = `<p class="hint">Clearing the code signs them out. Next time they pick their name, they choose a new code. A lock is cleared too.</p>
      ${f.confirm
        ? `<p class="lede">Clear ${esc(f.name)}’s code?</p><div class="row">${button('Yes, clear it', 'reset-clear', { kind: 'danger' })}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`
        : `<div class="row">${button('Clear code', 'reset-ask', { kind: 'secondary' })}</div>`}
      ${field('Or set a new 4-digit code', 'newPin', { value: f.newPin || '', inputmode: 'numeric', maxlength: '4', mask: true })}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button('Save new code', 'reset-set')}${button('Close', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'wish') {
    title = f.id ? 'Edit wish' : (state.simple ? 'New wish' : 'New wish');
    const kids = kidProfiles();
    body = `<form data-act="save-wish">
      ${isParent() ? `<p class="hint">Whose wish?</p><div class="row">${kids.map((k) => chip(k.name, 'wish-kid', f.kidId === k.id, `data-id="${esc(k.id)}"`)).join('')}</div>` : ''}
      ${field('What is it?', 'title', { value: f.title || '', maxlength: '120', placeholder: state.simple ? 'Lego set' : 'Something they want' })}
      ${field('Link (optional)', 'link', { value: f.link || '', maxlength: '1000', placeholder: 'https://' })}
      <div class="row" style="margin-top:12px">
        ${chip('Dollars', 'cost-mode', f.costMode !== 'points', 'data-value="dollars"')}
        ${chip('Points', 'cost-mode', f.costMode === 'points', 'data-value="points"')}
      </div>
      ${field(f.costMode === 'points' ? 'Points' : 'Price in NZD', 'amount', { value: f.amount || '', inputmode: f.costMode === 'points' ? 'numeric' : 'decimal', maxlength: '10' })}
      <p class="hint">${f.costMode === 'dollars' ? 'Dollars are turned into points using the family rate, rounded up.' : 'Points are used as the price, even if you also had a dollar price.'}</p>
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button('Save wish', 'save-wish')}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>
    </form>`;
  } else if (state.panel === 'redeem') {
    title = state.simple ? 'Ask for this?' : 'Ask a parent';
    body = `<p class="lede">${esc(f.title || '')}</p>
      ${field(state.simple ? 'Say something (optional)' : 'Note (optional)', 'note', { value: f.note || '', maxlength: '500', multiline: true })}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button(state.simple ? 'Ask' : 'Send request', 'submit-redeem', { test: 'submit-redeem' })}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'decide') {
    title = f.approve ? 'Approve wish' : 'Decline wish';
    body = `<p class="lede">${esc(f.kidName)} · ${esc(f.title || '')}</p>
      <p class="meta">${esc(pointsWord(f.points, false))}</p>
      ${field('Note (optional)', 'note', { value: f.note || '', maxlength: '500', multiline: true, placeholder: f.approve ? 'Have fun' : 'Not this time' })}
      <p class="form-error">${esc(f.error || '')}</p>
      <div class="row">${button(f.approve ? 'Approve' : 'Decline', 'submit-decide', { kind: f.approve ? 'primary' : 'danger', test: 'submit-decide' })}${button('Back', 'close-panel', { kind: 'ghost' })}</div>`;
  } else if (state.panel === 'confirm') {
    title = f.title || 'Are you sure?';
    body = `<p class="lede">${esc(f.body || '')}</p>
      <div class="row" style="margin-top:12px">${button(f.ok || 'Yes', 'confirm-yes', { kind: f.next === 'remove-wish' ? 'danger' : 'primary' })}${button('Cancel', 'close-panel', { kind: 'ghost' })}</div>`;
  }
  return `<div class="backdrop" data-backdrop="panel">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grab"></div>
      <div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
        <button type="button" class="text-btn" data-act="close-panel">Close</button>
      </div>
      ${body}
    </div>
  </div>`;
}

function shellOpen(extra = '') {
  const color = safeColor(state.me?.color || '#ea580c');
  const ink = inkFor(color);
  return `<div class="shell${state.simple ? ' simple' : ''}${extra}" style="--accent:${color};--accent-ink:${ink}" data-screen="${esc(state.screen)}" data-role="${esc(state.me?.role || '')}" data-slug="${esc(state.me?.slug || selected()?.slug || '')}">`;
}

function overlayBits() {
  return `${state.busy ? '<div class="busy-flag" role="status">Working…</div>' : ''}
    ${state.toast ? `<div class="toast ${state.toast.kind === 'bad' ? 'bad' : 'good'}" role="status">${esc(state.toast.text)}</div>` : ''}`;
}

function renderBoot() {
  return `${shellOpen()}<main class="stage">${loadingBlock()}</main></div>${overlayBits()}`;
}

function renderFatal() {
  return `${shellOpen()}<main class="stage">
    <p class="eyebrow">Family chores</p>
    <h1>Can’t connect</h1>
    <p class="lede">${esc(state.fatal)}</p>
    <div class="row" style="margin-top:16px">${button('Try again', 'retry-boot')}</div>
  </main></div>`;
}

function renderPicker() {
  const tiles = state.profiles.map((p) => {
    const sub = p.role === 'parent' ? 'Parent' : `${p.age} · ${p.device === 'ipad' ? 'iPad' : 'phone'}`;
    const locked = p.locked_until && new Date(p.locked_until).getTime() > Date.now();
    const badge = locked ? 'Locked' : (p.has_pin ? '' : 'Set a code');
    return `<button type="button" class="tile" style="--c:${safeColor(p.color)}" data-act="pick" data-id="${esc(p.id)}" data-slug="${esc(p.slug)}" data-testid="tile-${esc(p.slug)}">
      <span class="avatar" aria-hidden="true">${esc(p.avatar || '🙂')}</span>
      <span class="tile-name">${esc(p.name)}</span>
      <span class="tile-sub">${esc(sub)}</span>
      ${badge ? `<span class="tile-badge">${esc(badge)}</span>` : ''}
    </button>`;
  }).join('');
  return `${shellOpen()}<main class="stage">
    <p class="eyebrow">Family chores</p>
    <h1>Who’s here?</h1>
    <p class="lede">Tap your name, then your 4-digit code.</p>
    <div class="tiles">${tiles}</div>
  </main></div>${overlayBits()}`;
}

function renderPin() {
  const profile = selected();
  const mode = state.pin.mode;
  const title = mode === 'enter'
    ? (state.simple ? 'Your code' : 'Enter your code')
    : mode === 'confirm'
      ? (state.simple ? 'Type it again' : 'Type the same code again')
      : (state.simple ? 'Make a code' : 'Choose a 4-digit code');
  const hint = mode === 'enter'
    ? 'Four numbers. This device will remember you.'
    : mode === 'confirm'
      ? 'Just to be sure.'
      : 'Pick something you can remember. You can ask a parent to reset it later.';
  const locked = Boolean(state.pin.lockedUntil && lockClock(state.pin.lockedUntil));
  const dis = locked || state.busy ? 'disabled' : '';
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="key" data-act="pin" data-key="${n}" ${dis}>${n}</button>`).join('');
  return `${shellOpen()}<main class="stage">
    <button type="button" class="text-btn" data-act="back-picker" style="align-self:flex-start">Back</button>
    <div style="text-align:center;margin-top:12px">
      <div class="avatar" style="width:84px;height:84px;border-radius:50%;display:grid;place-items:center;font-size:44px;margin:0 auto 8px;background:${safeColor(profile?.color)}22">${esc(profile?.avatar || '')}</div>
      <h1>${esc(profile?.name || '')}</h1>
      <p class="lede">${esc(title)}</p>
      <p class="hint">${esc(hint)}</p>
      <div class="dots ${state.pin.shake ? 'shake' : ''}" aria-hidden="true">
        ${[0, 1, 2, 3].map((i) => `<span class="dot ${i < state.pin.digits.length ? 'on' : ''}"></span>`).join('')}
      </div>
      <p class="pin-error" role="alert">${esc(state.pin.error || '')}${locked ? ` <span class="lock-clock" data-lock-clock>${esc(lockClock(state.pin.lockedUntil))}</span>` : ''}</p>
      ${state.busy ? '<p class="hint">Checking…</p>' : ''}
    </div>
    <div class="keypad" aria-label="Number pad">
      ${keys}
      <span></span>
      <button type="button" class="key" data-act="pin" data-key="0" ${dis}>0</button>
      <button type="button" class="key" data-act="pin" data-key="back" aria-label="Delete" ${dis}>⌫</button>
    </div>
  </main></div>${overlayBits()}`;
}

function renderApp() {
  return `${shellOpen()}
    ${renderHeader()}
    <main class="main">${renderMain()}</main>
    ${renderTabs()}
  </div>${renderNotifs()}${renderPanel()}${overlayBits()}`;
}

function view() {
  if (state.screen === 'boot') return renderBoot();
  if (state.screen === 'fatal') return renderFatal();
  if (state.screen === 'picker') return renderPicker();
  if (state.screen === 'pin') return renderPin();
  return renderApp();
}

function render() {
  const root = document.getElementById('app');
  const main = document.querySelector('.main');
  const scroll = main ? main.scrollTop : 0;
  const active = document.activeElement;
  const bind = active?.dataset?.bind || '';
  const sel = active && 'selectionStart' in active ? active.selectionStart : null;
  root.innerHTML = view();
  const color = state.me ? safeColor(state.me.color) : '#f97316';
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', color);
  document.title = state.me ? `Chores · ${state.me.name}` : 'Family Chores';
  const next = document.querySelector('.main');
  if (next) next.scrollTop = scroll;
  if (bind) {
    const el = root.querySelector(`[data-bind="${CSS.escape(bind)}"]`);
    if (el) {
      el.focus();
      if (typeof sel === 'number' && el.setSelectionRange) {
        try { el.setSelectionRange(sel, sel); } catch { /* date and number inputs */ }
      }
    }
  }
}

function runAction(act, el) {
  Promise.resolve(onAction(act, el)).catch((err) => {
    noteError(err instanceof ApiError ? err : new ApiError('network'));
    state.busy = false;
    render();
  });
}

document.addEventListener('click', (event) => {
  const backdrop = event.target.closest?.('[data-backdrop]');
  if (backdrop && event.target === backdrop && !state.busy) {
    if (backdrop.dataset.backdrop === 'notifs') state.notifOpen = false;
    else state.panel = null;
    state.photo = null;
    render();
    return;
  }
  const el = event.target.closest?.('[data-act]');
  if (!el) return;
  event.preventDefault();
  runAction(el.dataset.act, el);
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form?.dataset?.act && !state.busy) runAction(form.dataset.act, form);
});

document.addEventListener('input', (event) => {
  const key = event.target?.dataset?.bind;
  if (!key || !state.draft) return;
  state.draft[key] = event.target.value;
});

document.addEventListener('change', (event) => {
  const input = event.target;
  if (input?.id !== 'photo-camera' && input?.id !== 'photo-library') return;
  const file = input.files && input.files[0];
  input.value = '';
  if (file) onPhotoPicked(file);
});

boot();

// Browser client for the Family Chores RPC API.
// The publishable key is safe to ship; there is no service role key here.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';

export const SUPABASE_URL = 'https://qtvfcdeuvdzaasmkqkpl.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_snOQLinjpR-2HkA85GcntQ_YpPFH0nB';

export const TOKEN_PREFIX = 'chores.token.';
export const LAST_PROFILE_KEY = 'chores.lastProfile';

export function tokenKey(profileId) {
  return TOKEN_PREFIX + profileId;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export class ApiError extends Error {
  constructor(code, detail) {
    super(code || 'unknown');
    this.name = 'ApiError';
    this.code = code || 'unknown';
    this.detail = detail || '';
  }
}

/** Friendly copy for every documented error code. */
export function friendlyMessage(code, detail = '', role = '') {
  const extra = (detail || '').trim();
  switch (code) {
    case 'invalid_session':
      return 'That sign-in ended. Please enter your code again.';
    case 'forbidden':
      return role === 'kid' ? 'Ask a parent to do that.' : 'That action isn’t available for this account.';
    case 'not_found':
      return 'That item isn’t here anymore. The list has been refreshed.';
    case 'invalid_status':
      return extra
        ? `That’s already changed (${extra}). Have another look.`
        : 'That’s already changed. Have another look.';
    case 'invalid_pin_format':
      return 'Use exactly 4 numbers.';
    case 'wrong_pin':
      return 'That code isn’t right.';
    case 'invalid_title':
      return extra ? `Check the title. ${extra}` : 'Add a short title.';
    case 'invalid_points':
      return extra ? `Check the points. ${extra}` : 'Enter a whole number of points in the allowed range.';
    case 'invalid_repeat':
      return 'Choose once, every day, or weekly.';
    case 'invalid_assignees':
      return 'Choose at least one kid.';
    case 'invalid_weekdays':
      return extra ? `Check the days. ${extra}` : 'Pick at least one day of the week.';
    case 'invalid_due_date':
      return extra ? `Check the date. ${extra}` : 'That date doesn’t work for this chore.';
    case 'repeat_change_not_allowed':
      return 'You can’t switch between a one-off and a repeating chore. Archive it and make a new one.';
    case 'note_required':
      return 'Please add a note so they know why.';
    case 'invalid_photo':
      return 'That photo couldn’t be used. Try another one.';
    case 'photo_too_large':
      return 'That photo is still too big. Try a smaller one.';
    case 'invalid_kid':
      return 'Pick which kid this is for.';
    case 'invalid_rate':
      return extra ? `That rate doesn’t work. ${extra}` : 'Points must be 1 or more, and dollars must be more than zero.';
    case 'invalid_link':
      return 'The link needs to start with http:// or https://.';
    case 'invalid_cost':
      return 'Add a cost in dollars or in points.';
    case 'request_pending':
      return 'Waiting for a parent already.';
    case 'insufficient_points':
      return extra ? `Not enough points. ${extra}` : 'There aren’t enough points for that.';
    case 'invalid_decision':
      return 'Choose approve or decline.';
    case 'pin_already_set':
      return 'A code is already set. Enter it instead.';
    case 'locked':
      return 'Too many tries. This account is locked for a little while.';
    case 'pin_not_set':
      return 'No code yet. Let’s make one.';
    case 'not_found_profile':
      return 'That person isn’t on this family list.';
    case 'PGRST202':
      return 'The app tried to call something the server doesn’t know. Refresh the page.';
    case 'network':
      return 'Can’t reach the server. Check the internet and try again.';
    default:
      return extra ? `Something went wrong. ${extra}` : 'Something went wrong. Please try again.';
  }
}

export async function rpc(fn, params = {}) {
  let result;
  try {
    result = await supabase.rpc(fn, params);
  } catch {
    throw new ApiError('network', '');
  }
  const { data, error } = result;
  if (error) {
    let code = 'unknown';
    if (error.code === 'PGRST202') code = 'PGRST202';
    else if (error.message && !/\s/.test(error.message)) code = error.message;
    else if (error.code) code = error.code;
    throw new ApiError(code, error.details || '');
  }
  return data;
}

let tokenGetter = () => '';

export function setTokenGetter(fn) {
  tokenGetter = fn;
}

export function call(fn, params = {}) {
  return rpc(fn, { p_token: tokenGetter(), ...params });
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Names that keep this app isolated from any other app hosted on the same
// github.io origin. Everything this app stores uses one of these prefixes,
// and the app never reads, changes or deletes anything without them.
export const APP_ID = 'monthly-budget-aed';
export const IDB_NAME = 'mbapp-monthly-budget-aed';   // IndexedDB database name
export const LS_PREFIX = 'mbapp.monthly-budget-aed.'; // localStorage key prefix
export const CACHE_PREFIX = 'mbapp-monthly-budget-aed-'; // Cache Storage prefix (see sw.js)

export const DRIVE_FILE_NAME = 'Monthly Budget App Data';
// drive.file = the app can only see files it created itself (narrowest Drive scope).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const CURRENCY = 'AED';
export const MONTHS = 12;
export const DEFAULT_START = '2026-10';
export const FILE_FORMAT = 1;
export const PBKDF2_ITERATIONS = 310000;

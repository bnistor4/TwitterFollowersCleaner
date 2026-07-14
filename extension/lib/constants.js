/** Shared constants for X Followers Cleaner */
const XFC = {
  MSG: {
    FOLLOWERS_BATCH: 'XFC_FOLLOWERS_BATCH',
    SCAN_STATUS: 'XFC_SCAN_STATUS',
    USER_CONTEXT: 'XFC_USER_CONTEXT',
    START_SCAN: 'XFC_START_SCAN',
    STOP_SCAN: 'XFC_STOP_SCAN',
    GET_STATE: 'XFC_GET_STATE',
    STATE: 'XFC_STATE',
    REMOVE_USER: 'XFC_REMOVE_USER',
    REMOVE_BATCH: 'XFC_REMOVE_BATCH',
    EXPORT: 'XFC_EXPORT',
    CLEAR: 'XFC_CLEAR',
    SCROLL: 'XFC_SCROLL'
  },

  STORAGE_KEY: 'xfc_followers_v1',
  SETTINGS_KEY: 'xfc_settings_v1',

  GRAPHQL_PATTERNS: [
    /\/Followers\b/,
    /\/BlueVerifiedFollowers\b/,
    /\/FollowersYouKnow\b/,
    /\/Following\b/,
    /UserByScreenName/,
    /UserByRestId/
  ],

  DEFAULT_SETTINGS: {
    autoScroll: true,
    scrollDelayMs: 1200,
    riskThreshold: 55,
    spamThreshold: 65,
    inactiveDays: 90,
    minFollowers: 0,
    maxFollowingRatio: 50,
    batchRemoveDelayMs: 2500
  },

  RISK: {
    LOW: { min: 0, max: 34, label: 'Low', color: '#00ba7c' },
    MEDIUM: { min: 35, max: 54, label: 'Medium', color: '#ffd400' },
    HIGH: { min: 55, max: 74, label: 'High', color: '#ff7a00' },
    CRITICAL: { min: 75, max: 100, label: 'Critical', color: '#f4212e' }
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.XFC = XFC;
}

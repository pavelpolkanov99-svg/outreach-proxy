const HEYREACH_API               = "https://api.heyreach.io/api/public";
const DEFAULT_LINKEDIN_ACCOUNT_ID = 81384; // Anton's LinkedIn account

function heyreachHeaders(hrKey) {
  return {
    "X-API-KEY":    hrKey,
    "Content-Type": "application/json",
  };
}

module.exports = {
  HEYREACH_API,
  DEFAULT_LINKEDIN_ACCOUNT_ID,
  heyreachHeaders,
};

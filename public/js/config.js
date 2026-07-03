/* =================================================================
   MERVEKS SAP — runtime configuration
   -----------------------------------------------------------------
   The system runs in two modes:

   • DEMO mode  (default) — when API_BASE is empty, the SAP runs fully
     in the browser using seeded demo data persisted in localStorage.
     Everything is editable and every action is recorded to the audit
     history, but nothing leaves the device.

   • LIVE mode — set API_BASE to your backend root (e.g.
     "https://api.merveks.com/sap"). On boot the app probes
     `${API_BASE}/health`; if it answers, the SAP switches to LIVE and
     reads/writes through the REST endpoints instead of demo data.
     If the probe fails, it falls back to DEMO so the UI never breaks.

   The connection state is shown in the top bar and can also be changed
   at runtime from  Settings → Backend connection  (stored locally).
   ================================================================= */
window.SAP_CONFIG = {
  // Backend REST root. Leave "" to run on demo data.
  API_BASE: "",

  // Marketing site the SAP belongs to (linked from the sidebar).
  SITE_URL: "https://www.merveks.com/en/main-page/",

  // Company identity shown across the console.
  COMPANY: "MERVEKS",
  TAGLINE: "Logistics & Trade",

  // --- AI Accounting (Google Gemini) ---
  // Paste a Google Gemini API key to enable the live AI Accountant in
  // Finance. Leave blank to use the built-in offline analysis engine.
  // (You can also set this at runtime in Settings → AI Accounting.)
  GEMINI_API_KEY: "",
  GEMINI_MODEL: "gemini-2.0-flash",

  // Expected shape of REST endpoints when LIVE (per collection):
  //   GET    {API_BASE}/{collection}        -> array
  //   POST   {API_BASE}/{collection}        -> created record
  //   PUT    {API_BASE}/{collection}/{id}   -> updated record
  //   DELETE {API_BASE}/{collection}/{id}   -> 204
  //   GET    {API_BASE}/health              -> 200 OK
  HEALTH_PATH: "/health"
};

window.COUNTRIES = [
  { code: "US", name: "United States", vat: 0, tax: 15, social: 6.2 },
  { code: "CN", name: "China", vat: 13, tax: 10, social: 8 },
  { code: "JP", name: "Japan", vat: 10, tax: 10, social: 9 },
  { code: "DE", name: "Germany", vat: 19, tax: 20, social: 10 },
  { code: "GB", name: "United Kingdom", vat: 20, tax: 20, social: 12 },
  { code: "FR", name: "France", vat: 20, tax: 15, social: 13 },
  { code: "IN", name: "India", vat: 18, tax: 10, social: 12 },
  { code: "IT", name: "Italy", vat: 22, tax: 15, social: 9 },
  { code: "BR", name: "Brazil", vat: 17, tax: 11, social: 8 },
  { code: "CA", name: "Canada", vat: 5, tax: 15, social: 5 },
  { code: "RU", name: "Russia", vat: 20, tax: 13, social: 10 },
  { code: "KR", name: "South Korea", vat: 10, tax: 10, social: 8 },
  { code: "ES", name: "Spain", vat: 21, tax: 15, social: 6 },
  { code: "AU", name: "Australia", vat: 10, tax: 15, social: 9.5 },
  { code: "MX", name: "Mexico", vat: 16, tax: 15, social: 5 },
  { code: "ID", name: "Indonesia", vat: 11, tax: 10, social: 5 },
  { code: "NL", name: "Netherlands", vat: 21, tax: 20, social: 10 },
  { code: "SA", name: "Saudi Arabia", vat: 15, tax: 0, social: 10 },
  { code: "TR", name: "Turkey", vat: 20, tax: 15, social: 14 },
  { code: "CH", name: "Switzerland", vat: 8.1, tax: 10, social: 6 },
  { code: "PL", name: "Poland", vat: 23, tax: 12, social: 10 },
  { code: "SE", name: "Sweden", vat: 25, tax: 20, social: 10 },
  { code: "BE", name: "Belgium", vat: 21, tax: 20, social: 13 },
  { code: "AR", name: "Argentina", vat: 21, tax: 15, social: 14 },
  { code: "NO", name: "Norway", vat: 25, tax: 22, social: 8 },
  { code: "AT", name: "Austria", vat: 20, tax: 20, social: 10 },
  { code: "IR", name: "Iran", vat: 9, tax: 10, social: 7 },
  { code: "TH", name: "Thailand", vat: 7, tax: 10, social: 5 },
  { code: "AE", name: "United Arab Emirates", vat: 5, tax: 0, social: 5 },
  { code: "CO", name: "Colombia", vat: 19, tax: 10, social: 8 },
  { code: "ZA", name: "South Africa", vat: 15, tax: 15, social: 1 },
  { code: "EG", name: "Egypt", vat: 14, tax: 10, social: 11 },
  { code: "IL", name: "Israel", vat: 17, tax: 10, social: 12 },
  { code: "IE", name: "Ireland", vat: 23, tax: 20, social: 4 },
  { code: "MY", name: "Malaysia", vat: 6, tax: 10, social: 11 },
  { code: "SG", name: "Singapore", vat: 9, tax: 5, social: 10 },
  { code: "VN", name: "Vietnam", vat: 10, tax: 10, social: 8 },
  { code: "PH", name: "Philippines", vat: 12, tax: 10, social: 10 },
  { code: "PK", name: "Pakistan", vat: 18, tax: 10, social: 5 },
  { code: "BD", name: "Bangladesh", vat: 15, tax: 10, social: 0 },
  { code: "CL", name: "Chile", vat: 19, tax: 10, social: 10 },
  { code: "FI", name: "Finland", vat: 24, tax: 20, social: 10 },
  { code: "DK", name: "Denmark", vat: 25, tax: 25, social: 8 },
  { code: "PT", name: "Portugal", vat: 23, tax: 15, social: 11 },
  { code: "GR", name: "Greece", vat: 24, tax: 15, social: 15 },
  { code: "CZ", name: "Czech Republic", vat: 21, tax: 15, social: 11 },
  { code: "RO", name: "Romania", vat: 19, tax: 10, social: 10 },
  { code: "PE", name: "Peru", vat: 18, tax: 10, social: 9 },
  { code: "NZ", name: "New Zealand", vat: 15, tax: 15, social: 0 },
  { code: "HU", name: "Hungary", vat: 27, tax: 15, social: 10.5 }
];

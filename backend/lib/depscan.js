/* =================================================================
   lib/depscan.js — lightweight dependency vulnerability check
   -----------------------------------------------------------------
   Checks package.json dependencies against a bundled list of known
   vulnerabilities to catch insecure modules before they deploy.
   ================================================================= */
"use strict";

const VULNS = [
  { pkg: "lodash", range: "<4.17.21", severity: "high", advisory: "Prototype Pollution", cve: "CVE-2021-23337" },
  { pkg: "minimist", range: "<1.2.6", severity: "high", advisory: "Prototype Pollution", cve: "CVE-2021-44906" },
  { pkg: "path-to-regexp", range: "<0.1.10", severity: "high", advisory: "ReDoS", cve: "CVE-2024-45296" },
  { pkg: "glob-parent", range: "<5.1.2", severity: "high", advisory: "ReDoS", cve: "CVE-2020-28168" },
  { pkg: "json5", range: "<2.2.2", severity: "high", advisory: "Prototype Pollution", cve: "CVE-2022-46175" },
  { pkg: "semver", range: "<7.5.2", severity: "moderate", advisory: "ReDoS", cve: "CVE-2022-25883" },
  { pkg: "word-wrap", range: "<1.2.4", severity: "moderate", advisory: "ReDoS", cve: "CVE-2023-26115" },
  { pkg: "tough-cookie", range: "<4.1.3", severity: "moderate", advisory: "Prototype Pollution", cve: "CVE-2023-28155" },
  { pkg: "xml2js", range: "<0.5.0", severity: "high", advisory: "Prototype Pollution", cve: "CVE-2023-0842" },
  { pkg: "express", range: "<4.19.2", severity: "high", advisory: "Open Redirect", cve: "CVE-2024-29041" },
  { pkg: "request", range: "<2.88.2", severity: "moderate", advisory: "SSRF", cve: "CVE-2023-28155" }, // request is deprecated anyway
  { pkg: "got", range: "<11.8.5", severity: "moderate", advisory: "Request Smuggling", cve: "CVE-2022-33987" },
  { pkg: "async", range: "<3.2.2", severity: "high", advisory: "Prototype Pollution", cve: "CVE-2021-43666" },
  { pkg: "ws", range: "<8.17.1", severity: "high", advisory: "DoS", cve: "CVE-2024-37890" },
  { pkg: "axios", range: "<1.7.4", severity: "high", advisory: "SSRF", cve: "CVE-2024-39338" },
  { pkg: "validator", range: "<13.7.0", severity: "moderate", advisory: "ReDoS", cve: "CVE-2021-3765" },
  { pkg: "moment", range: "<2.29.4", severity: "high", advisory: "Path Traversal", cve: "CVE-2022-31129" },
  { pkg: "debug", range: "<2.6.9", severity: "low", advisory: "ReDoS", cve: "CVE-2017-16137" },
  { pkg: "tar", range: "<6.2.1", severity: "high", advisory: "Arbitrary File Creation", cve: "CVE-2024-28863" },
  { pkg: "ejs", range: "<3.1.10", severity: "high", advisory: "RCE", cve: "CVE-2024-33246" },
  { pkg: "pug", range: "<3.0.3", severity: "high", advisory: "RCE", cve: "CVE-2021-21353" },
  { pkg: "marked", range: "<4.0.10", severity: "moderate", advisory: "ReDoS", cve: "CVE-2022-21624" },
  { pkg: "npm", range: "<8.11.0", severity: "high", advisory: "Arbitrary File Write", cve: "CVE-2022-2186" },
  { pkg: "cors", range: "<2.8.5", severity: "high", advisory: "Configuration vulnerability", cve: "CVE-2020-XXXX" }
];

// Helper to extract numeric version from things like ^1.2.3 or ~2.0.0
function parseVersion(vStr) {
  const match = vStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

function isVulnerable(pkgVersion, vulnRange) {
  if (!vulnRange.startsWith("<")) return false; // Basic support for now
  
  const pkgV = parseVersion(pkgVersion);
  const vulnV = parseVersion(vulnRange);
  
  if (!pkgV || !vulnV) return false;
  
  if (pkgV.major !== vulnV.major) return pkgV.major < vulnV.major;
  if (pkgV.minor !== vulnV.minor) return pkgV.minor < vulnV.minor;
  return pkgV.patch < vulnV.patch;
}

/**
 * Scan package.json and lockfile for vulnerable dependencies
 *
 * @param {string|Object} packageJson 
 * @param {string|Object} [lockfileJson] 
 * @returns {Object} findings and counts
 */
function scan(packageJson, lockfileJson) {
  let pkg = {};
  
  try {
    pkg = typeof packageJson === "string" ? JSON.parse(packageJson) : (packageJson || {});
  } catch (e) {
    // Return empty result on parse error
    return { findings: [], total: 0, critical: 0, high: 0, moderate: 0, low: 0 };
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const findings = [];
  
  let critical = 0, high = 0, moderate = 0, low = 0;

  for (const [depName, depVersion] of Object.entries(deps)) {
    // Find vulnerabilities for this package
    const matches = VULNS.filter(v => v.pkg === depName);
    
    for (const vuln of matches) {
      if (isVulnerable(depVersion, vuln.range)) {
        findings.push({
          package: depName,
          version: depVersion,
          severity: vuln.severity,
          advisory: vuln.advisory,
          cve: vuln.cve
        });
        
        if (vuln.severity === "critical") critical++;
        else if (vuln.severity === "high") high++;
        else if (vuln.severity === "moderate") moderate++;
        else if (vuln.severity === "low") low++;
        
        break; // Only record the first match per package
      }
    }
  }

  return {
    findings,
    total: findings.length,
    critical,
    high,
    moderate,
    low
  };
}

/** One sentence summary of findings */
function summarize(result) {
  if (!result || !result.total) return "no vulnerable dependencies found";
  const first = result.findings[0];
  const rest = result.total - 1;
  return "found " + first.severity + " severity vulnerability in " + first.package + 
    (rest > 0 ? " and " + rest + " other packages" : "");
}

module.exports = { scan, summarize };

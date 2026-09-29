export interface AdvisoryDetails {
  cves?: string[];
  ghsaId?: string;
  severity?: string;
  cvss?: { score: number; vector?: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cvssDetails(value: unknown): AdvisoryDetails['cvss'] {
  if (!record(value) || typeof value.score !== 'number') return undefined;
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 10) return undefined;
  const vector = value.vectorString ?? value.vector_string;
  return { score: value.score, ...(typeof vector === 'string' ? { vector } : {}) };
}

/** Missing optional identifiers or scores must never be invented from severity labels. */
export function advisoryDetails(value: Record<string, unknown>): AdvisoryDetails {
  const details: AdvisoryDetails = {};
  const cves = value.cves ?? (value.cve_id === null ? [] : [value.cve_id]);
  if (Array.isArray(cves)) {
    const valid = cves.filter((id): id is string => typeof id === 'string' && /^CVE-\d{4}-\d{4,}$/i.test(id));
    if (!cves.length || valid.length) details.cves = [...new Set(valid.map(id => id.toUpperCase()))];
  }
  const ghsa = value.github_advisory_id ?? value.ghsa_id ?? value.url;
  if (typeof ghsa === 'string') {
    const match = /(?:^|\/)(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})(?:$|[?#])/.exec(ghsa);
    if (match) details.ghsaId = match[1];
  }
  if (typeof value.severity === 'string') details.severity = value.severity;
  const severities = record(value.cvss_severities) ? value.cvss_severities : {};
  const cvss = cvssDetails(value.cvss) ?? cvssDetails(severities.cvss_v3) ?? cvssDetails(severities.cvss_v4);
  if (cvss) details.cvss = cvss;
  return details;
}

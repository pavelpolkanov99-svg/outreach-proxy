function filterPerson(p) {
  const org = p.organization || {};
  return {
    id: p.id,
    name: p.name,
    firstName: p.first_name,
    lastName: p.last_name,
    title: p.title,
    seniority: p.seniority,
    email: p.email,
    emailStatus: p.email_status,
    linkedin: p.linkedin_url,
    location: [p.city, p.country].filter(Boolean).join(", "),
    company: p.organization_name || org.name,
    companyWebsite: org.website_url,
    companyLinkedin: org.linkedin_url,
    companyDescription: (org.short_description || "").slice(0, 200),
    companyEmployees: org.estimated_num_employees,
    companyRevenue: org.annual_revenue_printed,
    companyIndustry: org.industry,
    companyFounded: org.founded_year,
    companyKeywords: (org.keywords || []).slice(0, 20),
    latestFunding: org.latest_funding_stage,
    latestFundingDate: org.latest_funding_round_date,
    totalFunding: org.total_funding_printed,
  };
}

// Extract canonical organization profile from Apollo's org_enrich response.
// Used to derive company name from a domain.
function filterOrganization(o) {
  if (!o) return null;
  return {
    id:           o.id,
    name:         o.name,
    website:      o.website_url,
    linkedin:     o.linkedin_url,
    description:  (o.short_description || "").slice(0, 500),
    employees:    o.estimated_num_employees,
    industry:     o.industry,
    keywords:     (o.keywords || []).slice(0, 20),
    revenue:      o.annual_revenue_printed,
    founded:      o.founded_year,
    location:     [o.city, o.state, o.country].filter(Boolean).join(", "),
    latestFunding:     o.latest_funding_stage,
    latestFundingDate: o.latest_funding_round_date,
    totalFunding:      o.total_funding_printed,
  };
}

module.exports = { filterPerson, filterOrganization };

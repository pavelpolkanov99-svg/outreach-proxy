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

module.exports = { filterPerson };

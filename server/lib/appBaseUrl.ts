export function getAppBaseUrl() {
  const appDomain = process.env.REPLIT_DOMAINS
    ? process.env.REPLIT_DOMAINS.split(',')[0]
    : null
  if (appDomain) return `https://${appDomain}`
  const isReplit = process.env.REPL_ID !== undefined
  const port = isReplit ? 5000 : 5001
  return `http://localhost:${port}`
}

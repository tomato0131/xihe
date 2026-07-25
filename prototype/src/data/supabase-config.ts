export interface SupabaseConfig {
  url: string
  anonKey: string
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim()
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null
  return { url: url.replace(/\/$/, ''), anonKey }
}

export async function healthCheckSupabase(config: SupabaseConfig): Promise<boolean> {
  const response = await fetch(`${config.url}/rest/v1/`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
  })
  return response.ok
}


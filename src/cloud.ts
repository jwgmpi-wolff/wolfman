import { createClient, type Session } from '@supabase/supabase-js'
import type { JarvisData } from './domain'

const url = import.meta.env.VITE_SUPABASE_URL
const publicKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const cloudEnabled = Boolean(url && publicKey)
const client = cloudEnabled ? createClient(url, publicKey) : null

export async function getSession() {
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  return data.session
}

export function onSessionChange(callback: (session: Session | null) => void) {
  if (!client) return () => undefined
  const { data } = client.auth.onAuthStateChange((_event, session) => callback(session))
  return () => data.subscription.unsubscribe()
}

export async function requestMagicLink(email: string) {
  if (!client) throw new Error('Cloud sync is not configured.')
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  })
  if (error) throw error
}

export async function signOut() {
  if (!client) return
  const { error } = await client.auth.signOut()
  if (error) throw error
}

export async function uploadData(data: JarvisData) {
  if (!client) throw new Error('Cloud sync is not configured.')
  const { data: userData, error: userError } = await client.auth.getUser()
  if (userError || !userData.user) throw userError ?? new Error('Sign in before syncing.')
  const { error } = await client.from('jarvis_profiles').upsert({
    user_id: userData.user.id,
    payload: data,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
}

export async function restoreData() {
  if (!client) throw new Error('Cloud sync is not configured.')
  const { data: userData, error: userError } = await client.auth.getUser()
  if (userError || !userData.user) throw userError ?? new Error('Sign in before syncing.')
  const { data, error } = await client
    .from('jarvis_profiles')
    .select('payload')
    .eq('user_id', userData.user.id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('No cloud backup exists yet.')
  return data.payload as JarvisData
}

import { createClient } from '@supabase/supabase-js'
const supabaseUrl = 'https://tyfrkmbuhyuvmypjmsny.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5ZnJrbWJ1aHl1dm15cGptc255Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTM5MzMsImV4cCI6MjA5MzQ4OTkzM30.P8BafJHGiy8HbvI9J0SOpP2SJOqNhoqt_PfXqLvNnq8'
export const supabase = createClient(supabaseUrl, supabaseKey)
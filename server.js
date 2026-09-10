const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const speech = require('@google-cloud/speech')
const OpenAI = require('openai')

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------
// Manual parser for compatibility with any Node version. Safe no-op if missing.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  const content = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const eq = line.indexOf('=')
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadEnvFile(path.join(__dirname, '.env'))

// ---------------------------------------------------------------------------
// KNOWLEDGE BASE
// ---------------------------------------------------------------------------
// The app is an AI interview assistant that answers personalized questions
// grounded in the candidate's identity, experience, and the target job.
//
//   knowledge/identity.md          - always injected (candidate identity, skills)
//   knowledge/experience.md        - always injected (background / work style)
//   knowledge/projects/*.md        - one file per project, retrieved selectively
//
// To keep token usage bounded, only identity + experience + the job description
// are always sent. Project files are retrieved on every request by matching the
// job description keywords against each project's keywords.
// ---------------------------------------------------------------------------
const KB_ROOT = path.join(__dirname, 'knowledge')
const KB_PROJECTS_DIR = path.join(KB_ROOT, 'projects')

// Approximated as ~4 chars per token.
const CHARS_PER_TOKEN = 4

const CONTEXT_MAX_TOKENS = Number(process.env.CONTEXT_MAX_TOKENS || 3000)
const JD_MAX_TOKENS     = Number(process.env.JD_MAX_TOKENS || 800)
const PROJECT_MAX_TOKENS= Number(process.env.PROJECT_MAX_TOKENS || 500)
const PROJECT_RETRIEVAL_COUNT = Number(process.env.PROJECT_RETRIEVAL_COUNT || 2)

function compactText(text, charBudget) {
  const compact = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
  if (compact.length <= charBudget) return compact
  return compact.slice(0, charBudget).split('\n').slice(0, -1).join('\n')
}

function parseFrontMatter(raw) {
  const meta = {}
  let body = raw
  const m = raw.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n\s*---\s*\r?\n?/)
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key) meta[key] = val
    }
  }
  return { meta, body }
}

const STOP_WORDS = new Set([
  'a','an','the','and','or','for','of','with','in','on','to','as','is','are','at','by','from',
  'our','your','we','us','you','their','them','i','me','my','it','its','this','that','these','those',
  'have','has','had','will','would','can','could','should','may','must','be','been','being','not',
  'no','yes','do','does','did','also','very','just','like','about','into','over','under','while',
  'during','using','use','used','build','builds','built','develop','development','experience',
  'ability','strong','skills','role','responsibilities','responsibility','work','working','team',
  'software','knowledge','including','etc','eg','ie','required','requirements','preferred','plus'
])

function tokenize(text) {
  const tokens = new Set()
  const words = text.toLowerCase().match(/[a-z0-9+#]+/g) || []
  for (const w of words) {
    if (w.length < 2) continue
    if (STOP_WORDS.has(w)) continue
    tokens.add(w)
  }
  return tokens
}

function loadKnowledgeBase() {
  const identity = compactText(fs.existsSync(path.join(KB_ROOT, 'identity.md'))
    ? fs.readFileSync(path.join(KB_ROOT, 'identity.md'), 'utf8') : '', CONTEXT_MAX_TOKENS * 2 * CHARS_PER_TOKEN)
  const experience = compactText(fs.existsSync(path.join(KB_ROOT, 'experience.md'))
    ? fs.readFileSync(path.join(KB_ROOT, 'experience.md'), 'utf8') : '', CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN)

  let projects = []
  try {
    if (fs.existsSync(KB_PROJECTS_DIR)) {
      for (const f of fs.readdirSync(KB_PROJECTS_DIR)) {
        if (!f.endsWith('.md')) continue
        const raw = fs.readFileSync(path.join(KB_PROJECTS_DIR, f), 'utf8')
        const { meta, body } = parseFrontMatter(raw)
        const keywords = tokenize(meta.keywords || '')
        projects.push({
          id: f.replace(/\.md$/, ''),
          title: meta.title || f,
          keywords,
          nameTokens: tokenize(meta.title || f),
          content: compactText(body, PROJECT_MAX_TOKENS * CHARS_PER_TOKEN)
        })
      }
    }
  } catch (err) {
    console.warn('Could not load project knowledge:', err.message)
  }
  return { identity, experience, projects }
}

const kb = loadKnowledgeBase()

function retrieveProjects(query, count = PROJECT_RETRIEVAL_COUNT) {
  if (!kb.projects.length || !query) return []
  const qTokens = tokenize(query)
  const scored = kb.projects.map(p => {
    let score = 0
    for (const t of qTokens) {
      if (p.keywords.has(t)) score += 2
      if (p.nameTokens.has(t)) score += 1
    }
    return { project: p, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored
    .filter(s => s.score > 0)
    .slice(0, count)
    .map(s => s.project)
}

function buildSystemPrompt(jobContext) {
  const parts = []

  parts.push(
    "You are an AI job-interview assistant helping Cleven Samwel, a Software Developer, " +
    "answer interview questions. Speak in the first person as if Cleven is answering. " +
    "Your goal is to help him present himself convincingly and truthfully for the target role."
  )

  if (kb.identity) {
    parts.push("## Cleven's Identity & Skills (source of truth):\n" + kb.identity)
  }
  if (kb.experience) {
    parts.push("## Background & Work Style:\n" + kb.experience)
  }

  if (jobContext && (jobContext.title || jobContext.description)) {
    const jd = compactText(
      (jobContext.title ? ("JOB TITLE: " + jobContext.title + "\n") : '') + (jobContext.description || ''),
      JD_MAX_TOKENS * CHARS_PER_TOKEN
    )
    parts.push(
      "## Target Job (use to tailor answers and highlight matching experience):\n" + jd +
      "\n\nWhenever you answer, explicitly note which job requirement/responsibility the " +
      "answer satisfies whenever it is reasonable to do so."
    )
  }

  const projects = retrieveProjects(
    (jobContext && jobContext.description || '') + '\n' + (jobContext && jobContext.title || '')
  )
  if (projects.length) {
    const projBlocks = projects.map((p, i) =>
      `### Project ${i + 1}: ${p.title}\n${p.content}`
    ).join('\n\n')
    parts.push("## Relevant Experience / Projects (prefer these when answering):\n" + projBlocks)
  }

  parts.push(
    "## Answering Guidelines:\n" +
    "- Keep answers brief, clear, and direct: no more than 2-3 sentences, unless the interviewer " +
    "explicitly asks for detail.\n" +
    "- For behavioral questions, answer in STAR format (Situation, Task, Action, Result) using real " +
    "projects/metrics from the experience above.\n" +
    "- Tie each answer to the specific job requirement it addresses whenever possible.\n" +
    "- If a question is not covered by the provided context, answer honestly and generically rather " +
    "than inventing details."
  )

  let prompt = parts.join('\n\n')
  const maxChars = CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN
  if (prompt.length > maxChars) {
    prompt = compactText(prompt, maxChars)
  }
  return prompt
}

// ---------------------------------------------------------------------------
// GOOGLE SPEECH-TO-TEXT (batch recognize; Vercel-compatible, no long-lived streams)
// ---------------------------------------------------------------------------
function getCredentialsPath() {
  return path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
}

let speechClient = null
function getSpeechClient() {
  if (!speechClient) {
    // Prefer credentials from an env var (Vercel): base64-encoded service-account JSON.
    // Falls back to the local key file for development.
    const encoded = process.env.GOOGLE_CLOUD_CREDENTIALS_B64
    if (encoded) {
      const creds = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      if (!creds.client_email || !creds.private_key) {
        throw new Error('GOOGLE_CLOUD_CREDENTIALS_B64 does not look like a Google service-account key')
      }
      speechClient = new speech.SpeechClient({ credentials: creds })
    } else if (fs.existsSync(getCredentialsPath())) {
      speechClient = new speech.SpeechClient({ keyFilename: getCredentialsPath() })
    } else {
      throw new Error('Google Cloud credentials not configured. Set GOOGLE_CLOUD_CREDENTIALS_B64 on Vercel (or restore the local key file).')
    }
  }
  return speechClient
}

async function transcribeBase64Audio(base64Audio) {
  if (!base64Audio) {
    throw new Error('No audio received')
  }
  const audioBuffer = Buffer.from(base64Audio, 'base64')
  if (audioBuffer.length < 100) {
    throw new Error('Audio too small, likely empty recording')
  }

  const request = {
    config: {
      encoding: 'WEBM_OPUS',  // Matches the browser MediaRecorder format
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true
    },
    audio: { content: audioBuffer }
  }

  const [response] = await getSpeechClient().recognize(request)
  if (!response || !response.results || response.results.length === 0) {
    return ''
  }
  return response.results
    .map(result => result.alternatives && result.alternatives[0] && result.alternatives[0].transcript)
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// LLM (any OpenAI-compatible provider)
// ---------------------------------------------------------------------------
const llmConfig = {
  baseURL: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '',
  httpExtraHeaders: process.env.OPENROUTER_API_KEY ? {
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://lazyjobseeker.com',
    'X-Title': process.env.OPENROUTER_TITLE || 'Lazy Job Seeker'
  } : undefined,
  maxRetries: 3,
  timeout: 60000
}

const openai = new OpenAI(llmConfig)

const llmModels = (process.env.LLM_MODELS || 'openai/gpt-4o-mini,google/gemini-2.5-flash,nvidia/nemotron-3-ultra-550b-a55b:free')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)

async function getLLMAnswer(transcript, jobContext) {
  if (!transcript || transcript.trim().length === 0) {
    throw new Error('No speech detected. Please try again.')
  }

  const isLocalProvider = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(llmConfig.baseURL)
  if (!llmConfig.apiKey && !isLocalProvider) {
    throw new Error('LLM API key not configured. Set LLM_API_KEY (or OPENROUTER_API_KEY) as a Vercel environment variable.')
  }

  const systemPrompt = buildSystemPrompt(jobContext)
  let lastError = null

  for (const model of llmModels) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript }
        ],
        temperature: 0.3,
        max_tokens: 100,
        presence_penalty: 0,
        frequency_penalty: 0
      })

      const answer = completion?.choices?.[0]?.message?.content
      if (answer) return { model, answer }

      lastError = new Error(`Model ${model} returned no content`)
    } catch (err) {
      console.error(`Model ${model} failed:`, err.message)
      lastError = err
    }
  }

  throw lastError || new Error('No models available')
}

// ---------------------------------------------------------------------------
// HTTP SERVER
// ---------------------------------------------------------------------------
const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

app.get('/', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'))
})

// Transcribe a full recording (base64 webm/opus) -> text
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64 } = req.body || {}
    const transcript = await transcribeBase64Audio(audioBase64)
    if (!transcript) {
      return res.json({ transcript: null, message: 'No speech detected. Please try again.' })
    }
    return res.json({ transcript })
  } catch (err) {
    console.error('Transcription error:', err.message)
    return res.status(400).json({ error: err.message || 'Transcription failed' })
  }
})

// Generate an interview answer for a transcript using the knowledge base + job context
app.post('/api/answer', async (req, res) => {
  try {
    const { transcript, job } = req.body || {}
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'No speech detected. Please try again.' })
    }
    const jobContext = {
      title: String((job && job.title) || '').slice(0, 500),
      description: String((job && job.description) || '').slice(0, JD_MAX_TOKENS * CHARS_PER_TOKEN)
    }
    const { answer } = await getLLMAnswer(transcript, jobContext)
    return res.json({ answer })
  } catch (err) {
    console.error('Answer error:', err.message)
    return res.status(500).json({ error: err.message || 'Could not generate an answer. Please try again.' })
  }
})

const PORT = Number(process.env.PORT || 3000)

app.listen(PORT, () => {
  console.log(`Angel AI Assistant web app running at http://localhost:${PORT}`)
})
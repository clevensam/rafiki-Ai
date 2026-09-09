const { app, BrowserWindow, ipcMain, screen, systemPreferences, Tray, Menu, nativeImage, globalShortcut, desktopCapturer } = require('electron')
const path = require('path')
const fs = require('fs')
const speech = require('@google-cloud/speech')
const record = require('node-record-lpcm16')
const textToSpeech = require('@google-cloud/text-to-speech')
const OpenAI = require('openai')

// Load environment variables from .env (if present) so keys aren't committed to the repo.
// Uses a small manual parser for compatibility with Electron's bundled Node (Node 18),
// which lacks the process.loadEnvFile() API. Safe no-op if the file doesn't exist.
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

try {
  const envPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, '.env')
  loadEnvFile(envPath)
} catch (err) {
  console.warn('Could not load .env:', err.message)
}

// ---------------------------------------------------------------------------
// KNOWLEDGE BASE
// ---------------------------------------------------------------------------
// The app is an AI interview assistant that answers personalized questions
// grounded in the candidate's identity, experience, and the target job.
//
// Layout (bundled by build config "**/*"):
//   knowledge/identity.md          - always injected (candidate identity, skills)
//   knowledge/experience.md        - always injected (background / work style)
//   knowledge/projects/*.md        - one file per project, retrieved selectively
//
// To keep token usage bounded, only identity + experience + the job description
// are always sent. Project files are retrieved on every request by matching the
// job description keywords against each project's keywords, injecting only the
// most relevant projects. Configurable via env (see .env.example).
// ---------------------------------------------------------------------------
const KB_ROOT = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'knowledge')
const KB_PROJECTS_DIR = path.join(KB_ROOT, 'projects')

// Approximated as ~4 chars per token.
const CHARS_PER_TOKEN = 4

// Token budgets (configurable via env). Defaults are tuned so a request stays
// predictable and bounded while covering the full identity + JD + relevant projects.
const CONTEXT_MAX_TOKENS = Number(process.env.CONTEXT_MAX_TOKENS || 3000)          // hard total cap
const JD_MAX_TOKENS     = Number(process.env.JD_MAX_TOKENS || 800)                 // job description cap
const PROJECT_MAX_TOKENS= Number(process.env.PROJECT_MAX_TOKENS || 500)            // per-project cap
const PROJECT_RETRIEVAL_COUNT = Number(process.env.PROJECT_RETRIEVAL_COUNT || 2)   // projects to inject

// Compacts text (trims each line, drops blanks) and truncates to a char budget,
// cutting cleanly at a newline boundary.
function compactText(text, charBudget) {
  const compact = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
  if (compact.length <= charBudget) return compact
  return compact.slice(0, charBudget).split('\n').slice(0, -1).join('\n')
}

// Parses a YAML-ish front-matter header from a knowledge file:
//   ---
//   key: value
//   ---
// Returns { meta: {key:value...}, body: restOfFile }
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

// Tokenizes a string into a set of lowercase keyword tokens (filters stop words).
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

// Loads the identity + experience (always injected) and the project index.
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

// Job context (title + description/requirements) set from the renderer UI.
let jobContext = { title: '', description: '' }

// Selects the most relevant projects for a given query by scoring token overlap
// between the query and each project's keywords + title. Returns top N projects.
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

// Builds the system prompt integrating identity + experience + job context +
// retrieved projects + answer guidelines.
function buildSystemPrompt() {
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

  if (jobContext.title || jobContext.description) {
    const jd = compactText(
      (jobContext.title ? ("JOB TITLE: " + jobContext.title + "\n") : '') + jobContext.description,
      JD_MAX_TOKENS * CHARS_PER_TOKEN
    )
    parts.push(
      "## Target Job (use to tailor answers and highlight matching experience):\n" + jd +
      "\n\nWhenever you answer, explicitly note which job requirement/responsibility the " +
      "answer satisfies whenever it is reasonable to do so."
    )
  }

  const projects = retrieveProjects(jobContext.description + '\n' + jobContext.title)
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

  // Enforce the hard total token cap.
  let prompt = parts.join('\n\n')
  const maxChars = CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN
  if (prompt.length > maxChars) {
    prompt = compactText(prompt, maxChars)
  }
  return prompt
}

// Global variables
let mainWindow = null
let recording = null
let isRecording = false
let recognizeStream = null
let currentTranscript = ''
let answerDebounceTimer = null

// Create a backup of window position and size for restoring
let windowState = {
  width: 500,
  height: 400,
  x: null,
  y: null
};

// Add this to track if we're in screen sharing mode
let isInScreenSharingMode = false;

// Keep a reference to the tray so it isn't garbage-collected.
let tray = null;

// "Protect" (overlay) mode: set from the renderer's Hide toggle. While ON, the
// window stays visible as a transparent overlay, and the app auto-hides if a
// full-screen capture source is detected.
let protectMode = false;
let isAutoHidden = false;
let autoHideTimer = null;

// Initialize the LLM client. Supports any OpenAI-compatible provider via env vars:
//   LLM_BASE_URL - OpenAI-compatible endpoint (defaults to OpenRouter)
//   LLM_API_KEY  - provider API key (falls back to OPENAI_API_KEY)
//   LLM_MODELS   - comma-separated model fallback list (defaults to OpenRouter models)
// Local providers (e.g. Ollama) may omit a key entirely.
const llmConfig = {
  baseURL: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '',
  httpExtraHeaders: process.env.OPENROUTER_API_KEY ? {
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://lazyjobseeker.com',
    'X-Title': process.env.OPENROUTER_TITLE || 'Lazy Job Seeker'
  } : undefined,
  maxRetries: 3,
  timeout: 60000
};

const openai = new OpenAI(llmConfig);

// Models to try in order (first listed is primary, subsequent are fallbacks)
const llmModels = (process.env.LLM_MODELS || 'nvidia/nemotron-3-ultra-550b-a55b:free,openai/gpt-4o-mini,anthropic/claude-3.5-haiku,google/gemini-flash-1.5')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// Add this near the top with other platform-specific code
const isWindows = process.platform === 'win32';

// Function to get credentials path that works in both dev and production
function getCredentialsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  } else {
    return path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  }
}

// Initialize Google clients
const speechClient = new speech.SpeechClient({
  keyFilename: getCredentialsPath()
})

const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: getCredentialsPath()
})

// Update the createWindow function to handle Windows-specific settings
function createWindow() {
  // Configure window options. The window is created as a transparent, frameless
  // overlay so it can be made see-through (transparent overlay mode). The renderer
  // toggles between a solid, readable background and a transparent overlay via a
  // body class; both keep the always-on-top floating behavior.
  const windowOptions = {
    width: 500,
    height: 400,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: false,
    icon: path.join(__dirname, isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png'),
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  };
  
  // Create the window
  mainWindow = new BrowserWindow(windowOptions);
  
  // Load the HTML file
  mainWindow.loadFile('index.html');
  
  // Set up window for screen exclusion compatibility
  if (process.platform === 'darwin') {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      
      // Initialize with properties that make exclusion work better
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setWindowButtonVisibility(true);
      
      // Move to front to establish window layering
      app.dock.show();
      mainWindow.moveTop();
    });
  } else if (isWindows) {
    // Windows-specific setup
    mainWindow.setSkipTaskbar(false);
    app.setAppUserModelId('com.lazyjobseeker.angel');
  }
  
  // Log when window is created
  console.log('Main window created');
}

function createRecognizeStream() {
  const request = {
    config: {
      encoding: 'WEBM_OPUS',  // Changed to match browser's MediaRecorder format
      sampleRateHertz: 48000, // Changed to match browser's MediaRecorder format (48kHz)
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true,
      metadata: {
        interactionType: 'DISCUSSION',
        microphoneDistance: 'NEARFIELD',
        originalMediaType: 'AUDIO'
      },
      enableVoiceActivityDetection: false,
      maxAlternatives: 1
    },
    singleUtterance: false,
    interimResults: true
  }

  return speechClient
    .streamingRecognize(request)
    .on('error', error => {
      console.error('Error:', error)
      if (error.code === 11 && isRecording) {
        console.log('Stream timeout, creating new stream while preserving transcript')
        if (recognizeStream) {
          recognizeStream = createRecognizeStream()
        }
      }
      if (mainWindow) {
        mainWindow.webContents.send('transcript', currentTranscript)
      }
    })
    .on('data', data => {
      if (data.results[0]) {
        const result = data.results[0]
        const transcript = result.alternatives[0].transcript
        
        if (result.isFinal) {
          // For final results, append to the running transcript
          currentTranscript = (currentTranscript + ' ' + transcript).trim()
          if (mainWindow) {
            mainWindow.webContents.send('transcript', currentTranscript)
            // Removed automatic answer generation here
          }
        } else {
          // For interim results, show the current transcript plus the interim result
          // This gives the live transcription feel without modifying currentTranscript yet
          if (mainWindow) {
            const interimTranscript = (currentTranscript + ' ' + transcript).trim()
            mainWindow.webContents.send('transcript', interimTranscript)
            
            // Removed debounced answer generation here
          }
        }
      }
    })
}

// Update the toggle-recording handler to provide immediate feedback
ipcMain.on('toggle-recording', async (event, isStarting) => {
  // Clear timeout if there's any pending
  if (answerDebounceTimer) {
    clearTimeout(answerDebounceTimer);
    answerDebounceTimer = null;
  }

  // Handle recording start/stop based on explicit parameter
  if (isStarting) {
    // Starting a new recording session
    console.log('Starting new recording session');
    isRecording = true;
    // Reset transcript when starting a new recording
    currentTranscript = '';
    recognizeStream = createRecognizeStream();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-started');
      // Send empty transcript to UI
      mainWindow.webContents.send('transcript', '');
    }
  } else {
    // Stopping recording - this should be fast
    console.log('Stopping recording and generating answer');
    isRecording = false;
    
    // Close the stream properly
    if (recognizeStream) {
      try {
        recognizeStream.end();
        recognizeStream = null;
      } catch (error) {
        console.error('Error ending recognizeStream:', error);
      }
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stopped');
      
      // Get answer immediately for the current transcript
      if (currentTranscript && currentTranscript.trim().length > 0) {
        try {
          // Send a preliminary status message
          mainWindow.webContents.send('answer-status', 'Generating answer...');
          
          // Generate answer with shorter timeout
          await getOpenAIAnswer(currentTranscript);
        } catch (error) {
          console.error('Error generating answer:', error);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer', 'Error generating answer. Please try again.');
          }
        }
      } else {
        mainWindow.webContents.send('answer', 'No speech detected. Please try again.');
      }
    }
  }
});

// Add this handler for stream audio chunks with proper error handling
ipcMain.on('stream-audio-chunk', async (event, audioChunk) => {
  try {
    // Skip processing if we're not recording
    if (!isRecording) return;
    
    // Create recognizeStream if it doesn't exist
    if (!recognizeStream || recognizeStream.destroyed) {
      recognizeStream = createRecognizeStream();
      isRecording = true;
    }
    
    // Write the chunk to the stream
    if (recognizeStream && !recognizeStream.destroyed) {
      // Convert base64 audio chunk to buffer
      const audioBuffer = Buffer.from(audioChunk, 'base64');
      
      try {
        recognizeStream.write(audioBuffer);
      } catch (error) {
        console.error('Stream write error:', error);
        // Don't recreate the stream here to avoid infinite loops
        // Just log the error and let the next chunk attempt to fix if needed
      }
    }
  } catch (error) {
    console.error('Error processing audio chunk:', error);
  }
});

// Optimize the OpenAI answer function for speed
async function getOpenAIAnswer(transcript) {
  try {
    if (!transcript || transcript.trim().length === 0) {
      console.log('Empty transcript, not sending to OpenAI');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'I couldn\'t hear anything. Please try again.');
      }
      return;
    }

    console.log('Sending to OpenAI:', transcript);
    
    // Send status update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer-status', 'Generating answer...');
    }

    // Helpful message if no API key is configured for a remote provider
    const isLocalProvider = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(llmConfig.baseURL);
    if (!llmConfig.apiKey && !isLocalProvider && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer', 'LLM API key not configured. Set LLM_API_KEY (or OPENAI_API_KEY) and restart the app.');
      return;
    }

    // Try models in order (first listed is primary, then fallbacks)
    const models = llmModels;
    
    let completion = null;
    let modelIndex = 0; // Start with the first (primary) model
    let error = null;
    
    while (!completion && modelIndex >= 0) {
      try {
        const model = models[modelIndex];
        console.log(`Trying model: ${model}`);
        
        completion = await openai.chat.completions.create({
          model: model,
          messages: [
            {
              role: "system", 
              content: buildSystemPrompt()
            },
            {
              role: "user",
              content: transcript
            }
          ],
          temperature: 0.3, // Lower temperature for more predictable outputs
          max_tokens: 100,  // Reduce token count for faster responses
          presence_penalty: 0,
          frequency_penalty: 0
        });
        
      } catch (err) {
        console.error(`Error with model ${models[modelIndex]}:`, err);
        error = err;
        modelIndex--; // Try the next model in the list
      }
    }

    if (completion?.choices?.[0]?.message?.content) {
      const answer = completion.choices[0].message.content;
      console.log('Received answer from OpenAI:', answer);
      
      // Explicitly send answer to UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Sending answer to UI');
        mainWindow.webContents.send('answer', answer);
      } else {
        console.error('Main window not available for sending answer');
      }
    } else {
      console.error('No answer content in OpenAI response');
      
      // Send appropriate error message
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (error) {
          mainWindow.webContents.send('answer', `Sorry, I couldn't generate an answer: ${error.message}`);
        } else {
          mainWindow.webContents.send('answer', 'Could not generate an answer. Please try again.');
        }
      }
    }
  } catch (error) {
    console.error('OpenAI API error:', error);
    
    // Provide more specific error message
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        mainWindow.webContents.send('answer', 'The connection to the AI service timed out. Please try again.');
      } else {
        mainWindow.webContents.send('answer', `Sorry, I couldn't generate an answer: ${error.message}`);
      }
    }
  }
}

// Add a new IPC event handler for stopping the stream
ipcMain.on('stop-audio-stream', () => {
  if (recognizeStream && !recognizeStream.destroyed) {
    isRecording = false;
    recognizeStream.end();
    recognizeStream = null;
  }
});

// Add this new function to reset transcript without creating a new chat
ipcMain.on('reset-transcript', () => {
  currentTranscript = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

// ---------------------------------------------------------------------------
// PROTECT / HIDE (keep out of screen capture while staying usable)
//
// On Linux/Wayland there is no OS-level per-window capture exclusion: a window
// that is visible to the user is visible in a full-screen recording. Two modes:
//   - "Protect" (overlay) mode: the renderer's Hide toggle switches the window to
//     a faint transparent overlay that STAYS VISIBLE and usable (it does not hide).
//     While protect mode is ON, the app polls for an active full-screen capture
//     source and true-hides itself if one is detected, then restores when it stops.
//   - "True hide": the global hotkey (Ctrl+Shift+H) / tray fully hide the window,
//     which is the only guaranteed way to keep it out of a full-screen recording.
// ---------------------------------------------------------------------------
const HIDE_HOTKEY = process.env.HIDE_HOTKEY || 'Control+Shift+H'
const AUTO_HIDE_ON_CAPTURE = String(process.env.AUTO_HIDE_ON_CAPTURE || 'true') === 'true'
const AUTO_HIDE_POLL_MS = Number(process.env.AUTO_HIDE_POLL_MS || 2000)

function applyContentProtection(protected_) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try { mainWindow.setContentProtection(protected_); } catch (e) { /* ignore */ }
  }
}

// True-hides or shows the window. Only this guarantees the window is not captured.
function setWindowHidden(hidden) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (hidden) {
      applyContentProtection(true);
      mainWindow.hide();
      isInScreenSharingMode = true;
      console.log('Assistant hidden (not captured)');
    } else {
      applyContentProtection(false);
      if (!mainWindow.isVisible()) {
        mainWindow.setBounds({
          x: windowState.x,
          y: windowState.y,
          width: windowState.width,
          height: windowState.height
        });
      }
      mainWindow.show();
      mainWindow.focus();
      isInScreenSharingMode = false;
      console.log('Assistant shown');
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screen-sharing-active', hidden);
    }
  } catch (error) {
    console.error('Error toggling hide/show:', error);
  }
}

// Global-hotkey / tray toggle for true hide.
function toggleWindowHidden() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isInScreenSharingMode || !mainWindow.isVisible()) {
    setWindowHidden(false);
  } else {
    const position = mainWindow.getPosition();
    const size = mainWindow.getSize();
    windowState = { width: size[0], height: size[1], x: position[0], y: position[1] };
    setWindowHidden(true);
  }
}

// Renderer toggles "protect"/overlay mode. The window stays visible (transparent
// overlay); only the renderer switches the visual style. This is what replaces the
// old behavior where toggling fully hid the window.
ipcMain.on('set-overlay-mode', (event, on) => {
  protectMode = Boolean(on);
  // Starting auto-hide built-in readiness; the actual hide is driven by polling.
  console.log('Protect/overlay mode ' + (protectMode ? 'ON' : 'OFF'));
});

// Detect an active full-screen capture source. Linux has no per-window capture
// exclusion, so when protect mode is ON and a screen source is being captured, we
// true-hide to stay out of the recording.
async function checkCaptureAndAutoHide() {
  if (!mainWindow || mainWindow.isDestroyed() || !protectMode) {
    if (isAutoHidden) { isAutoHidden = false; setWindowHidden(false); }
    return;
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const fullScreenShared = sources.length > 0;
    if (fullScreenShared && !isAutoHidden && mainWindow.isVisible()) {
      isAutoHidden = true;
      // Save bounds before hiding so restore returns to the same spot.
      const position = mainWindow.getPosition();
      const size = mainWindow.getSize();
      windowState = { width: size[0], height: size[1], x: position[0], y: position[1] };
      setWindowHidden(true);
      console.log('[auto-hide] Full-screen capture detected; hidden to avoid capture');
    } else if (!fullScreenShared && isAutoHidden) {
      isAutoHidden = false;
      setWindowHidden(false);
      console.log('[auto-hide] Capture stopped; assistant shown');
    }
  } catch (err) {
    // Enumeration can fail on restricted Wayland sessions; ignore and retry next poll.
    console.warn('[auto-hide] Capture check failed:', err.message);
  }
}

function startAutoHidePolling() {
  if (!AUTO_HIDE_ON_CAPTURE) {
    console.log('Auto-hide on capture is disabled (AUTO_HIDE_ON_CAPTURE=false)');
    return;
  }
  autoHideTimer = setInterval(checkCaptureAndAutoHide, AUTO_HIDE_POLL_MS);
  console.log(`Auto-hide on capture enabled (poll every ${AUTO_HIDE_POLL_MS}ms, fires only in protect mode)`);
}

function stopAutoHidePolling() {
  if (autoHideTimer) { clearInterval(autoHideTimer); autoHideTimer = null; }
}

// Global hotkey so the window can be hidden/shown instantly during a screen
// share even when the window doesn't have focus. Works on X11 (and on Wayland
// where the compositor supports global shortcuts).
function registerHideHotkey() {
  try {
    const ok = globalShortcut.register(HIDE_HOTKEY, toggleWindowHidden);
    if (ok) {
      console.log(`Registered global hotkey ${HIDE_HOTKEY} to hide/show assistant`);
    } else {
      console.warn(`Could not register global hotkey ${HIDE_HOTKEY} (may already be in use or unsupported). The tray and the in-window toggle still work.`);
    }
  } catch (err) {
    console.warn('Error registering global hotkey:', err.message);
  }
}

// System tray so the hidden window can always be restored (required on Linux/
// Wayland where hiding removes the in-window toggle). Tray click toggles the
// window; the context menu also offers explicit Show/Hide and Quit.
function createTray() {
  const iconPath = path.join(__dirname, 'assets/icons/icon.png');
  let icon = null;
  try { icon = nativeImage.createFromPath(iconPath); } catch (e) { /* ignore */ }

  const tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip('Angel AI Assistant — ' + HIDE_HOTKEY + ' to hide/show');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Assistant', click: () => setWindowHidden(false) },
    { label: 'Hide Assistant', click: () => setWindowHidden(true) },
    { type: 'separator' },
    { label: ('Hide/Show Hotkey: ' + HIDE_HOTKEY).replace('Control', 'Ctrl'), enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));

  tray.on('click', toggleWindowHidden);
  return tray;
}

ipcMain.on('get-answer', async (event, transcript) => {
  await getOpenAIAnswer(transcript || currentTranscript)
})

// Receive the target job context (title + description/requirements) from the
// renderer UI. Rebuilt into the system prompt on the next answer request.
ipcMain.on('set-job-context', (event, ctx) => {
  const title = (ctx && ctx.title) || ''
  const description = (ctx && ctx.description) || ''
  jobContext.title = String(title).slice(0, 500)
  jobContext.description = String(description).slice(0, JD_MAX_TOKENS * CHARS_PER_TOKEN)
  console.log('Job context set:', jobContext.title ? `"${jobContext.title}"` : '(none)', '| desc chars:', jobContext.description.length)
})

ipcMain.on('new-chat', () => {
  currentTranscript = ''
  if (isRecording) {
    isRecording = false
    if (recording) {
      record.stop()
      recording = null
    }
    if (recognizeStream) {
      recognizeStream.end()
      recognizeStream = null
    }
    if (mainWindow) {
      mainWindow.webContents.send('recording-stopped')
    }
  }
  if (mainWindow) {
    mainWindow.webContents.send('transcript', '')
  }
})

ipcMain.on('recording-stopped', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-recording-status', false)
  }
})

// Handle audio data from renderer process
ipcMain.on('audio-data', async (event, base64Audio) => {
  try {
    if (!base64Audio) {
      console.error('No audio data received');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'Error: No audio data received');
      }
      return;
    }

    const audioBuffer = Buffer.from(base64Audio, 'base64');
    console.log('Received audio data from renderer, size:', audioBuffer.length);

    if (audioBuffer.length < 100) {
      console.error('Audio buffer too small, likely empty recording');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
      return;
    }

    // Convert audio to LINEAR16 format
    const request = {
      config: {
        encoding: 'WEBM_OPUS',  // Updated to match the browser's MediaRecorder format
        sampleRateHertz: 48000, // Updated to match MediaRecorder's default 48kHz
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
        model: 'default',
        useEnhanced: true,
      },
      audio: {
        content: audioBuffer
      }
    };

    console.log('Sending audio to Google Speech-to-Text...');
    // Process audio with Google Speech-to-Text
    const [response] = await speechClient.recognize(request);
    
    if (!response || !response.results || response.results.length === 0) {
      console.log('No transcription results available');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
      return;
    }
    
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    if (transcription) {
      console.log('Transcription:', transcription);
      currentTranscript = transcription;
      
      // Send transcription to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', transcription);
        // Automatically get answer from OpenAI
        await getOpenAIAnswer(transcription);
      }
    } else {
      console.log('No transcription available');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
    }
  } catch (error) {
    console.error('Error processing audio:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcript', `Error: ${error.message || 'Unknown error'}`);
    }
  }
});

app.whenReady().then(() => {
  createWindow()
  tray = createTray()
  registerHideHotkey()
  startAutoHidePolling()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  stopAutoHidePolling()
  globalShortcut.unregisterAll()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error)
})
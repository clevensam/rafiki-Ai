# Setup Instructions

## Environment Variables

The Angel AI Meeting Assistant requires the following environment variables to be set:

### LLM Provider (any OpenAI-compatible provider)

The app uses the LLM for generating answers. It defaults to **OpenRouter** (which gives you access to hundreds of models from one key: OpenAI, Anthropic, Google, etc.), but you can use OpenAI or any provider with an OpenAI-compatible endpoint (Groq, Ollama, Mistral, DeepSeek, Together, etc.) by setting these environment variables:

| Variable | Purpose | Example |
|---|---|---|
| `LLM_API_KEY` | Provider API key (falls back to `OPENAI_API_KEY`) | `sk-or-...`, `gsk_...` |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (defaults to OpenRouter) | `https://api.openai.com/v1` |
| `LLM_MODELS` | Comma-separated model fallback list (first is primary) | `openai/gpt-4o-mini,mistral/mistral-small-latest` |
| `OPENROUTER_API_KEY` | OpenRouter key (used for provider headers) | `sk-or-...` |
| `OPENROUTER_REFERER` | Your site URL for OpenRouter attribution (optional) | `https://yoursite.com` |
| `OPENROUTER_TITLE` | App name shown to OAuth users (optional) | `Lazy Job Seeker` |

**OpenRouter (default):** get a free key at [openrouter.ai](https://openrouter.ai/keys), then:

**macOS/Linux**:
```bash
export LLM_API_KEY='sk-REPLACED_PLACEHOLDER'
```
or
```bash
export OPENROUTER_API_KEY='sk-REPLACED_PLACEHOLDER'
```

**Windows**:
```cmd
set LLM_API_KEY=sk-REPLACED_PLACEHOLDER
```

**OpenAI (opt-in):** set the base URL to OpenAI:
```bash
export LLM_BASE_URL='https://api.openai.com/v1'
export LLM_API_KEY='sk-REPLACED_PLACEHOLDER'
export LLM_MODELS='gpt-4o-mini,gpt-3.5-turbo'
```

Local providers like Ollama (no API key) work too — omit the key and set a local base URL:
```bash
export LLM_BASE_URL='http://localhost:11434/v1'
export LLM_MODELS='llama3.1'
```

**Compatible provider presets:**

| Provider | `LLM_BASE_URL` | `LLM_MODELS` |
|---|---|---|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3-ultra-550b-a55b:free,openai/gpt-4o-mini,anthropic/claude-3.5-haiku,google/gemini-flash-1.5` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini,gpt-3.5-turbo` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama (local, no key) | `http://localhost:11434/v1` | `llama3.1` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

## Google Cloud Credentials

The application uses Google Cloud Speech-to-Text for transcription. You need to:

1. Create a Google Cloud project
2. Enable the Speech-to-Text API
3. Create a service account and download the JSON key
4. Save the JSON key file as `lazy-job-seeker-4b29b-eb0b308d0ba7.json` in the project root

## Running the Application

After setting up the environment variables and Google Cloud credentials:

1. Install dependencies:
```bash
npm install
```

2. Start the application:
```bash
./start.sh
```

## Building for Production

See the README.md file for instructions on building the application for production. 
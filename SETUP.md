# Setup Instructions

## Environment Variables

The Angel AI Meeting Assistant requires the following environment variables to be set:

### OpenAI API Key

You need to set your OpenAI API key as an environment variable:

**macOS/Linux**:
```bash
export OPENAI_API_KEY='your-openai-api-key-here'
```

**Windows**:
```cmd
set OPENAI_API_KEY=your-openai-api-key-here
```

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
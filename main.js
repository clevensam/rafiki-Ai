const { app, BrowserWindow, ipcMain, systemPreferences } = require('electron')
const path = require('path')
const fs = require('fs')
const speech = require('@google-cloud/speech')
const record = require('node-record-lpcm16')
const textToSpeech = require('@google-cloud/text-to-speech')
const OpenAI = require('openai')

// Global variables
let mainWindow = null
let recording = null
let isRecording = false
let recognizeStream = null
let currentTranscript = ''

// Initialize OpenAI client with simple configuration
const openai = new OpenAI({
  apiKey: 'YOUR_OPENAI_API_KEY' // Replace with your actual key before using
});

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    skipTaskbar: false,
    icon: path.join(__dirname, 'assets/icons/icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mainWindow.loadFile('index.html')
  mainWindow.setVisibleOnAllWorkspaces(true)
}

function createRecognizeStream() {
  const request = {
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
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
          currentTranscript = (currentTranscript + ' ' + transcript).trim()
          if (mainWindow) {
            mainWindow.webContents.send('transcript', currentTranscript)
            // Automatically get answer when we have final transcription
            getOpenAIAnswer(currentTranscript)
          }
        } else {
          if (mainWindow) {
            mainWindow.webContents.send('transcript', 
              (currentTranscript + ' ' + transcript).trim())
          }
        }
      }
    })
}

// Function to get answer from OpenAI
async function getOpenAIAnswer(transcript) {
  try {
    console.log('Sending to OpenAI:', transcript)
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "system",
          content: "You are a helpful AI assistant in a meeting. Keep your responses clear, concise, and professional."
        },
        {
          role: "user",
          content: transcript
        }
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    if (completion?.choices?.[0]?.message?.content) {
      const answer = completion.choices[0].message.content
      console.log('Received answer from OpenAI:', answer)
      // Explicitly send answer to UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Sending answer to UI')
        mainWindow.webContents.send('answer', answer)
      } else {
        console.error('Main window not available for sending answer')
      }
    } else {
      console.error('No answer content in OpenAI response')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'Could not generate an answer. Please try again.')
      }
    }
  } catch (error) {
    console.error('OpenAI API error:', error)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer', 'Could not generate an answer. Please try again.')
    }
  }
}

ipcMain.on('toggle-recording', async () => {
  if (!isRecording) {
    isRecording = true
    recognizeStream = createRecognizeStream()

    const recordingConfig = {
      sampleRate: 16000,
      verbose: false,
      silence: '10.0',
      threshold: 0,
      audioBufferSize: 4096,
      channels: 1,
      endOnSilence: false,
      keepSilence: true,
      asRaw: true,
      audioType: 'wav'
    }

    recording = record.start(recordingConfig)

    recording.on('data', data => {
      if (recognizeStream && !recognizeStream.destroyed) {
        try {
          recognizeStream.write(data)
        } catch (error) {
          console.error('Stream write error:', error)
        }
      }
    })

    recording.on('error', error => {
      console.error('Recording error:', error)
      if (mainWindow) {
        mainWindow.webContents.send('recording-error', error.message)
      }
    })
  } else {
    isRecording = false
    if (recording) {
      record.stop()
      recording = null
    }
    if (recognizeStream) {
      recognizeStream.end()
      recognizeStream = null
    }
  }
})

ipcMain.on('toggle-screen-sharing-mode', (event, isScreenSharing) => {
  if (mainWindow) {
    if (isScreenSharing) {
      // Hide mode settings
      mainWindow.setAlwaysOnTop(true, "screen-saver")
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      mainWindow.setOpacity(0.9)
      
      if (process.platform === 'darwin') {
        mainWindow.setWindowButtonVisibility(false)
      }
      
      // Set minimum size in hide mode
      mainWindow.setMinimumSize(200, 100)
      mainWindow.setSize(200, 100)
      
      // Remove frame in hide mode
      mainWindow.setHasShadow(false)
      mainWindow.setContentProtection(true)
    } else {
      // Normal mode settings
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setVisibleOnAllWorkspaces(false)
      mainWindow.setOpacity(1.0)
      
      if (process.platform === 'darwin') {
        mainWindow.setWindowButtonVisibility(true)
      }
      
      // Restore normal size
      mainWindow.setMinimumSize(500, 400)
      mainWindow.setSize(500, 400)
      
      // Restore frame
      mainWindow.setHasShadow(true)
      mainWindow.setContentProtection(false)
    }
    
    mainWindow.webContents.send('screen-sharing-active', isScreenSharing)
  }
})

ipcMain.on('get-answer', async (event, transcript) => {
  await getOpenAIAnswer(transcript || currentTranscript)
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
        // Get answer from OpenAI
        getOpenAIAnswer(transcription);
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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
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
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

// Initialize OpenAI client with simple configuration
const openai = new OpenAI({
  apiKey: 'sk-REPLACED_PLACEHOLDER', // Replace with your actual key before using
  maxRetries: 3, // Add retry logic
  timeout: 60000 // 60 second timeout for the overall client, not per request
});

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
  // Configure window options with screen sharing compatibility in mind
  const windowOptions = {
    width: 500,
    height: 400,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    skipTaskbar: false,
    icon: path.join(__dirname, isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png'),
    backgroundColor: '#FFFFFF',
    titleBarStyle: 'default',
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

    // Try with faster model first
    const models = [
      "gpt-3.5-turbo", // Fall back to more reliable model
      "gpt-4o-mini"    // Try this first
    ];
    
    let completion = null;
    let modelIndex = 1; // Start with gpt-4o-mini
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
              content: "You are a helpful AI assistant in a meeting. Your answers must be brief, clear, and direct - no more than 2-3 sentences."
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

// Completely rework the IPC handler for toggling screen sharing mode
ipcMain.on('toggle-screen-sharing-mode', (event, isScreenSharing) => {
  // Get current window position and size if not in sharing mode already
  if (!isInScreenSharingMode && mainWindow) {
    const position = mainWindow.getPosition();
    const size = mainWindow.getSize();
    windowState = {
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1]
    };
  }
  
  // Update tracking variable
  isInScreenSharingMode = isScreenSharing;
  
  if (mainWindow) {
    if (isScreenSharing) {
      // On macOS, we need special handling
      if (process.platform === 'darwin') {
        try {
          // Critical sequence for macOS - order matters
          
          // First make it invisible to screen sharing
          mainWindow.setContentProtection(true);
          console.log('Screen sharing exclusion activated on macOS');
          
          // Set window to be visible on all workspaces (including full screen)
          mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          
          // Use specific window level to ensure it stays on top but excluded
          mainWindow.setAlwaysOnTop(true, "floating", 1);
          
          // Hide the traffic lights (window buttons)
          mainWindow.setWindowButtonVisibility(false);
          
          // Apply a very slight opacity change (not visible to users)
          // This is a crucial trick that helps with exclusion
          mainWindow.setOpacity(0.99);
          
          // Get the window bounds and temporarily resize to force a redraw
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
          
          // Restore original bounds after a brief delay
          setTimeout(() => {
            mainWindow.setBounds(bounds);
          }, 10);
          
          // Force a repaint with vibrancy changes
          mainWindow.setVibrancy('popover');
          setTimeout(() => {
            mainWindow.setVibrancy(null);
          }, 50);
        } catch (error) {
          console.error('Failed to apply screen sharing protection on macOS:', error);
        }
      } 
      // For Windows
      else if (process.platform === 'win32') {
        try {
          // Windows approach is simpler
          mainWindow.setContentProtection(true);
          mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
          console.log('Screen sharing exclusion activated on Windows');
        } catch (error) {
          console.error('Failed to apply screen sharing protection on Windows:', error);
        }
      }
      
      // Notify renderer that screen sharing mode is active
      mainWindow.webContents.send('screen-sharing-active', true);
    } 
    else {
      try {
        // Restore normal window behavior in exact opposite order
        mainWindow.setOpacity(1.0);
        
        if (process.platform === 'darwin') {
          mainWindow.setWindowButtonVisibility(true);
          mainWindow.setVisibleOnAllWorkspaces(false);
        }
        
        mainWindow.setAlwaysOnTop(true); // Keep on top but with default behavior
        mainWindow.setContentProtection(false);
        
        // Force window redraw on macOS
        if (process.platform === 'darwin') {
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
          setTimeout(() => {
            mainWindow.setBounds(bounds);
          }, 10);
        }
        
        // Notify renderer
        mainWindow.webContents.send('screen-sharing-active', false);
        console.log('Screen sharing exclusion deactivated');
      } catch (error) {
        console.error('Error disabling screen sharing protection:', error);
      }
    }
  }
});

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
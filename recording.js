const { desktopCapturer } = require('electron');

class RecordingService {
    constructor() {
        this.mediaRecorder = null;
        this.isRecording = false;
        this.chunks = [];
    }

    async start() {
        if (this.isRecording) return;

        try {
            // Get audio stream directly from the system
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop'
                    }
                },
                video: false
            });

            // Create MediaRecorder instance
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            // Clear previous chunks
            this.chunks = [];

            // Handle data available event
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.chunks.push(event.data);
                }
            };

            // Start recording
            this.mediaRecorder.start(100); // Collect data every 100ms
            this.isRecording = true;

            return true;
        } catch (error) {
            console.error('Failed to start recording:', error);
            this.stop();
            throw error;
        }
    }

    stop() {
        if (!this.isRecording) return null;

        return new Promise((resolve, reject) => {
            try {
                this.mediaRecorder.onstop = async () => {
                    try {
                        // Convert chunks to base64
                        const blob = new Blob(this.chunks, { type: 'audio/webm' });
                        const buffer = await blob.arrayBuffer();
                        const base64Data = Buffer.from(buffer).toString('base64');
                        
                        // Clean up
                        this.chunks = [];
                        this.isRecording = false;
                        this.mediaRecorder = null;
                        
                        resolve(base64Data);
                    } catch (error) {
                        reject(error);
                    }
                };

                // Stop recording
                this.mediaRecorder.stop();
                
                // Stop all tracks
                this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            } catch (error) {
                console.error('Failed to stop recording:', error);
                reject(error);
            }
        });
    }

    isActive() {
        return this.isRecording;
    }
}

module.exports = RecordingService; 
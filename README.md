# Angel AI Meeting Assistant

An Electron-based AI meeting assistant that provides real-time transcription and answers during meetings. The application sits on your desktop and helps answer questions during important meetings.

## Features

- Real-time speech transcription using Google Speech-to-Text
- AI-powered answers using OpenAI GPT-4
- Screen sharing mode (minimizes and stays on top)
- Always-on-top functionality
- Cross-platform support (macOS and Windows)

## Installation

### macOS (Intel and Apple Silicon)

1. Download the latest DMG file from the Releases page
2. Open the DMG file and drag the application to your Applications folder
3. When first opening, right-click the app and select "Open" to bypass macOS security

### Windows

1. Download the latest EXE installer from the Releases page
2. Run the installer and follow the prompts
3. Launch the application from the Start menu

## Development Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Google Cloud account with Speech-to-Text API enabled
- OpenAI API key

### Installation

1. Clone the repository
```bash
git clone https://github.com/Raviteja-me/angel-for-amc-windows-and-silicon.git
cd angel-for-amc-windows-and-silicon
```

2. Install dependencies
```bash
npm install
```

3. Create a Google Cloud credentials file and save it as `lazy-job-seeker-4b29b-eb0b308d0ba7.json` in the project root

4. Start the development server
```bash
./start.sh
```

### Building for Production

To build for all platforms:
```bash
./build-all.sh
```

To build for just macOS:
```bash
./build.sh
```

## License

This project is proprietary software.

## Credits

Developed by LazyJobSeeker.com 
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import { fileURLToPath } from 'url';

// __dirname replacement for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Directories
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
const tempDir = path.join(__dirname, 'temp');

// Ensure directories exist
[uploadsDir, outputDir, tempDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json());

// --- File tracking ---
const fileTracker = {
  uploads: new Map(), // filename -> { timestamp, clientId, inUse }
  output: new Map(),
  temp: new Map()
};

const clients = new Map(); // clientId -> { lastActivity, files }
const downloadTokens = new Map(); // token -> { filename, created }

// --- Client ID generation ---
function generateClientId() {
  return 'client-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
}

// --- Track files ---
function trackFile(filename, type, clientId) {
  const tracker = type === 'upload' ? fileTracker.uploads :
                  type === 'output' ? fileTracker.output : fileTracker.temp;

  tracker.set(filename, { timestamp: Date.now(), clientId, inUse: false });

  if (!clients.has(clientId)) clients.set(clientId, { lastActivity: Date.now(), files: [] });

  clients.get(clientId).files.push({ filename, type });
  clients.get(clientId).lastActivity = Date.now();
}

// --- Delete file safely ---
function deleteFile(filename, type) {
  let tracker, filePath;
  switch(type) {
    case 'upload': tracker = fileTracker.uploads; filePath = path.join(uploadsDir, filename); break;
    case 'output': tracker = fileTracker.output; filePath = path.join(outputDir, filename); break;
    case 'temp': tracker = fileTracker.temp; filePath = path.join(tempDir, filename); break;
  }

  const data = tracker?.get(filename);
  if (data?.inUse) return false; // Don't delete if currently being used

  if (fs.existsSync(filePath)) {
    try { 
      fs.unlinkSync(filePath); 
      tracker?.delete(filename); 
      console.log(`Deleted ${type} file: ${filename}`);
      return true; 
    } catch(e) { 
      console.error(`Error deleting ${type} file ${filename}:`, e); 
      return false; 
    }
  }
  return false;
}

// --- Cleanup client files ---
function cleanupClientFiles(clientId) {
  if (!clients.has(clientId)) return;
  const client = clients.get(clientId);
  client.files.forEach(file => deleteFile(file.filename, file.type));
  clients.delete(clientId);
  console.log(`Cleaned up all files for client: ${clientId}`);
}

// --- Scheduled cleanup ---
function scheduledCleanup() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 mins

  // Clean up old files from all trackers
  [fileTracker.uploads, fileTracker.output, fileTracker.temp].forEach(tracker => {
    for (const [filename, data] of tracker.entries()) {
      if (!data.inUse && now - data.timestamp > maxAge) {
        deleteFile(filename,
          tracker === fileTracker.uploads ? 'upload' :
          tracker === fileTracker.output ? 'output' : 'temp');
      }
    }
  });

  // Clean up inactive clients
  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastActivity > maxAge) cleanupClientFiles(clientId);
  }

  // Clean up expired download tokens
  for (const [token, data] of downloadTokens.entries()) {
    if (now - data.created > maxAge) {
      downloadTokens.delete(token);
      console.log(`Deleted expired download token: ${token}`);
    }
  }
}

// Run scheduled cleanup every 10 minutes
setInterval(scheduledCleanup, 10 * 60 * 1000);

// --- Multer setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.floor(Math.random()*1e9) + path.extname(file.originalname))
});
const upload = multer({ storage });

// --- API Endpoints ---

// Generate client ID
app.get('/client-id', (req, res) => {
  const clientId = generateClientId();
  res.json({ clientId });
});

// Upload video
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const clientId = req.body.clientId || generateClientId();
  trackFile(req.file.filename, 'upload', clientId);

  res.json({
    message: 'Uploaded successfully',
    filename: req.file.filename,
    originalname: req.file.originalname,
    clientId
  });
});

// Process video segments
app.post('/process', async (req, res) => {
  const { filename, segments, clientId } = req.body;
  if (!filename || !segments || !Array.isArray(segments) || !segments.length)
    return res.status(400).json({ error: 'Invalid request' });

  const inputPath = path.join(uploadsDir, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const outputFilename = `processed-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  // Temporary segment files
  const tempFiles = segments.map((seg, i) => path.join(tempDir, `temp-${i}-${Date.now()}.mp4`));
  tempFiles.forEach(f => trackFile(path.basename(f), 'temp', clientId));

  try {
    // Process segments sequentially with RE-ENCODING for reliability
    for (let i=0; i<segments.length; i++) {
      const seg = segments[i];
      // NOTE: We are now re-encoding instead of using '-c copy'.
      // This is slower but much more reliable and creates valid, playable segments.
      const cmd = `"${ffmpeg}" -i "${inputPath}" -ss ${seg.start} -to ${seg.end} -c:v libx264 -c:a aac -preset fast -crf 23 -avoid_negative_ts make_zero "${tempFiles[i]}"`;
      
      console.log(`Processing segment ${i+1}/${segments.length}...`);
      await new Promise((resolve, reject) => {
        exec(cmd, (err, stderr, stdout) => {
          if (err) {
            console.error(`FFmpeg error on segment ${i}:`, stderr);
            return reject(err);
          }
          resolve();
        });
      });
    }

    // Create file list for concat
    const listFile = path.join(tempDir, `list-${Date.now()}.txt`);
    const content = tempFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, content);
    trackFile(path.basename(listFile), 'temp', clientId);

    // Concatenate with RE-ENCODING to ensure a clean final file
    console.log('Concatenating segments...');
    await new Promise((resolve, reject) => {
      const cmd = `"${ffmpeg}" -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -preset fast -crf 23 "${outputPath}"`;
      exec(cmd, (err, stderr, stdout) => {
        if (err) {
            console.error(`FFmpeg error on concat:`, stderr);
            return reject(err);
        }
        resolve();
      });
    });

    // Delete temp files
    tempFiles.forEach(f => deleteFile(path.basename(f), 'temp'));
    deleteFile(path.basename(listFile), 'temp');

    // Track the final output file
    trackFile(outputFilename, 'output', clientId);

    // Generate a one-time download token
    const token = `dl-${Date.now()}-${Math.floor(Math.random()*1e9)}`;
    downloadTokens.set(token, { filename: outputFilename, created: Date.now() });

    console.log('Processing complete.');
    res.json({ message: 'Video processed', downloadToken: token });
  } catch (err) {
    console.error('Processing error:', err);
    res.status(500).json({ error: 'Video processing failed' });
  }
});

// One-time download endpoint
app.get('/download/:token', (req, res) => {
  const { token } = req.params;
  const data = downloadTokens.get(token);
  if (!data) return res.status(404).send('Download link has expired or is invalid.');

  const filePath = path.join(outputDir, data.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found on server.');

  // Mark file as in use to prevent cleanup during download
  const fileData = fileTracker.output.get(data.filename);
  if (fileData) fileData.inUse = true;

  res.download(filePath, `edited-video.mp4`, (err) => {
    // Cleanup after download
    if (fileData) fileData.inUse = false;
    // Optionally delete the file immediately after download
    // deleteFile(data.filename, 'output'); 
    downloadTokens.delete(token);
  });
});

// Manual cleanup endpoint
app.post('/cleanup', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'Client ID required' });
  cleanupClientFiles(clientId);
  res.json({ message: 'Client files cleaned' });
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
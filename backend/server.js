import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import ffmpeg from "ffmpeg-static";
import { fileURLToPath } from "url";

// __dirname replacement for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Local directories
const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");
const tempDir = path.join(__dirname, "temp");


// Ensure directories exist
[uploadsDir, outputDir, tempDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json());

// --- File tracking ---
const fileTracker = {
  uploads: new Map(), // filename -> { timestamp, clientId, inUse }
  output: new Map(),
  temp: new Map(),
};

const clients = new Map(); // clientId -> { lastActivity, files, originalName }
const downloadTokens = new Map(); // token -> { filename, created, originalName }

// --- Client ID generation for file tracking ---
function generateClientId() {
  return "client-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
}

// --- Track files ---
function trackFile(filename, type, clientId) {
  const tracker =
    type === "upload"
      ? fileTracker.uploads
      : type === "output"
        ? fileTracker.output
        : fileTracker.temp;

  tracker.set(filename, { timestamp: Date.now(), clientId, inUse: false });

  if (!clients.has(clientId))
    clients.set(clientId, { lastActivity: Date.now(), files: [] });

  clients.get(clientId).files.push({ filename, type });
  clients.get(clientId).lastActivity = Date.now();
}

// --- Delete file safely ---
function deleteFile(filename, type) {
  let tracker, filePath;
  switch (type) {
    case "upload":
      tracker = fileTracker.uploads;
      filePath = path.join(uploadsDir, filename);
      break;
    case "output":
      tracker = fileTracker.output;
      filePath = path.join(outputDir, filename);
      break;
    case "temp":
      tracker = fileTracker.temp;
      filePath = path.join(tempDir, filename);
      break;
  }

  const data = tracker?.get(filename);
  if (data?.inUse) return false; // Don't delete if currently being used

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      tracker?.delete(filename);
      console.log(`Deleted ${type} file: ${filename}`);
      return true;
    } catch (e) {
      console.error(`Error deleting ${type} file ${filename}:`, e);
      return false;
    }
  }
  return false;
}

// --- Cleanup client files ---
// Deletes all files associated with a client and removes the client from tracking
function cleanupClientFiles(clientId) {
  if (!clients.has(clientId)) return;
  const client = clients.get(clientId);
  client.files.forEach((file) => deleteFile(file.filename, file.type));
  clients.delete(clientId);
  console.log(`Cleaned up all files for client: ${clientId}`);
}

// --- Scheduled cleanup ---
function scheduledCleanup() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 mins
  const heartbeatTimeout = 5 * 60 * 1000; // 5 mins for heartbeat timeout

  // Clean up old files from all trackers > 30min
  [fileTracker.uploads, fileTracker.output, fileTracker.temp].forEach(
    (tracker) => {
      for (const [filename, data] of tracker.entries()) {
        if (!data.inUse && now - data.timestamp > maxAge) {
          deleteFile(
            filename,
            tracker === fileTracker.uploads
              ? "upload"
              : tracker === fileTracker.output
                ? "output"
                : "temp"
          );
        }
      }
    }
  );

  // Clean up inactive clients all files (no heartbeat for 5 minutes)
  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastActivity > heartbeatTimeout) {
      console.log(`Client ${clientId} inactive, cleaning up files...`);
      cleanupClientFiles(clientId);
    }
  }

  // Clean up expired download tokens
  for (const [token, data] of downloadTokens.entries()) {
    if (now - data.created > maxAge) {
      downloadTokens.delete(token);
      console.log(`Deleted expired download token: ${token}`);
    }
  }
}

// Run scheduled cleanup every 5 minutes 
// If a tracked file is older than 30 minutes, it deletes it
// If a client has not sent a heartbeat for 5 minutes, it deletes all their files
// If a download token is older than 30 minutes, it deletes it
setInterval(scheduledCleanup, 5 * 60 * 1000);

// --- Multer setup ---
// Multer storage config
// multer - middleware for handling multipart/form-data, primarily used for uploading files
const storage = multer.diskStorage({
  // destination property - function
  destination: (req, file, cb) => cb(null, uploadsDir),
  // callback function cb(err, result) gives these arguments, first is error, second is result and multer works with the given data - null and uploadsDir
  // creating unique filename
  filename: (req, file, cb) =>
    cb(
      null,
      Date.now() +
      "-" +
      Math.floor(Math.random() * 1e9) +
      path.extname(file.originalname)
    ),
});

// Multer uses this configuration and passes the actual HTTP/upload data
// to the configured functions when the upload middleware runs.
// upload.single("video") creates middleware that expects one uploaded file
// whose form-data field name is "video"
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

// --- API Endpoints ---

// GET - generate a new client ID for tracking and gives to the client
// Generate client ID
app.get("/client-id", (req, res) => {
  const clientId = generateClientId();
  res.json({ clientId });
});

// POST - send clientId to keep the client active
app.post("/heartbeat", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Client ID required" });

  if (clients.has(clientId)) {
    clients.get(clientId).lastActivity = Date.now();
    res.json({ status: "active" });
  } else {
    res.status(404).json({ error: "Client not found" });
  }
});

// Upload video
// POST - upload a video file, track it, and return the filename and clientId
// (endpoint, middleware, handlers)
app.post("/upload", upload.single("video"), (req, res) => {

  // Check if a file was uploaded
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Generate if theres no clientId or retrieve clientId from request body
  const clientId = req.body.clientId || generateClientId();

  // Track the uploaded file with the clientId
  trackFile(req.file.filename, "upload", clientId);

  // Store the original filename in the client data
  if (!clients.has(clientId))
    clients.set(clientId, { lastActivity: Date.now(), files: [] });

  // Store the original filename for later use in download naming
  clients.get(clientId).originalName = req.file.originalname;

  // Respond with the uploaded file info and clientId
  res.json({
    message: "Uploaded successfully",
    filename: req.file.filename,
    originalname: req.file.originalname,
    clientId,
  });
});

// Process video segments
app.post("/process", async (req, res) => {

  // Destructure the request body to get filename, segments, and clientId
  const { filename, segments, clientId } = req.body;

  // Validate request body
  if (!filename || !segments || !Array.isArray(segments) || !segments.length)
    return res.status(400).json({ error: "Invalid request" });

  // Get the original filename from client data
  const clientData = clients.get(clientId);

  // If the client data does not exist, return an error
  if (!clientData) {
    return res.status(400).json({
      error: "Please upload a video first"
    });
  }

  // Find the uploaded file in the client's files
  const uploadedFile = clientData.files.find(
    file => file.type === "upload"
  );

  // If the uploaded file does not exist or the filename does not match, return an error
  if (!uploadedFile || uploadedFile.filename !== filename) {
    return res.status(400).json({
      error: "Please upload a video first"
    });
  }

  // Set the input path for the uploaded file
  const inputPath = path.join(uploadsDir, filename);

  // Check if the input file exists
  if (!fs.existsSync(inputPath))
    return res.status(404).json({ error: "File not found" });

  // Generate unique ouput filename and full output path /uploads/filename
  const outputFilename = `processed-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  // Use the original name
  const originalName = clientData.originalName;

  // Temporary segment files goes in the temp dir, after that they will be merged into the output
  const tempFiles = segments.map((seg, i) =>
    path.join(tempDir, `temp-${i}-${Date.now()}.mp4`)
  );

  // Track temp files for cleanup
  tempFiles.forEach((f) => trackFile(path.basename(f), "temp", clientId));

  // Split and process segments using ffmpeg with re-encoding for reliability
  try {

    // Process segments sequentially with RE-ENCODING for reliability
    // Splitting the video
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // This is slower but much more reliable and creates valid, playable segments.
      // ffmpgeg path
      // -i input file
      // -ss start time s
      // -to end time s
      // -c codec
      // -c:v libx264 (video codec - H.264)
      // -c:a aac (audio codec)
      // -preset fast (encoding speed)
      // -crf 23 (quality)
      // -avoid_negative_ts make_zero (fixes timestamp issues)
      const cmd = `"${ffmpeg}" -i "${inputPath}" -ss ${seg.start} -to ${seg.end} -c:v libx264 -c:a aac -preset fast -crf 23 -avoid_negative_ts make_zero "${tempFiles[i]}"`;

      // Execute the command and wait for it to finish
      console.log(`Processing segment ${i + 1}/${segments.length}...`);

      // Use a promise to handle the asynchronous execution of the command
      await new Promise((resolve, reject) => {
        exec(cmd, (err, stderr, stdout) => {
          if (err) {
            console.error(`FFmpeg error on segment ${i}:`, stderr);
            return reject(err);
          }

          // Resolves the promise and continues to the next segment
          resolve();
        });
      });
    }

    // Create list-Date.now().txt file name
    const listFile = path.join(tempDir, `list-${Date.now()}.txt`);

    // Generate the content for the list file
    const content = tempFiles.map((f) => `file '${f}'`).join("\n");

    // Write the list file to disk
    fs.writeFileSync(listFile, content);

    // Track the list file for cleanup
    trackFile(path.basename(listFile), "temp", clientId);

    // Concatenate with RE-ENCODING to ensure a clean final file
    console.log("Concatenating segments...");

    // -f concat (-f is format, and the format is concatinating)
    // -safe 0 (allow unsafe file paths)
    // -i input list file
    // -c:v libx264 (video codec)
    // -c:a aac (audio codec)
    // -preset fast (encoding speed)
    // -crf 23 (quality)
    // -preset fast (encoding speed H.264)
    const cmd = `"${ffmpeg}" -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -preset fast -crf 23 "${outputPath}"`;

    // Use a promise to handle the asynchronous execution of the command
    await new Promise((resolve, reject) => {
      // Execute the command and wait for it to finish
      exec(cmd, (err, stderr, stdout) => {
        if (err) {
          console.error(`FFmpeg error on concat:`, stderr);
          return reject(err);
        }
        resolve();
      });
    });

    // Delete all the temporary video segments
    tempFiles.forEach((f) => deleteFile(path.basename(f), "temp"));

    // Delete the list file
    deleteFile(path.basename(listFile), "temp");

    // Track the final output file
    trackFile(outputFilename, "output", clientId);

    // Generate a one-time download token
    const token = `dl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    // Extract the filename without extension
    const originalNameWithoutExt = path.parse(originalName).name;

    downloadTokens.set(token, {
      filename: outputFilename,
      created: Date.now(),
      originalName: originalNameWithoutExt
    });

    console.log("Processing complete.");

    // Respond with the download token for the client to use
    res.json({ message: "Video processed", downloadToken: token });
  } catch (err) {
    console.error("Processing error:", err);
    res.status(500).json({ error: "Video processing failed" });
  }
});

// One-time download endpoint
// GET - download the processed video using a one-time token variable in the URL
app.get("/download/:token", (req, res) => {
  const { token } = req.params;
  const data = downloadTokens.get(token);
  if (!data)
    return res.status(404).send("Download link has expired or is invalid.");

  const filePath = path.join(outputDir, data.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).send("File not found on server.");

  // Mark file as in use to prevent cleanup during download
  const fileData = fileTracker.output.get(data.filename);
  if (fileData) fileData.inUse = true;

  // Use the original filename with "-vidsnip-edited" appended
  const downloadName = `${data.originalName}-vidsnip-edited.mp4`;

  // Send the file for download
  res.download(filePath, downloadName, (err) => {
    
    // Cleanup after download
    if (fileData) fileData.inUse = false;

    // Optionally delete the file immediately after download
    downloadTokens.delete(token);
  });
});

// Manual cleanup endpoint
app.post("/cleanup", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Client ID required" });
  cleanupClientFiles(clientId);
  res.json({ message: "Client files cleaned" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

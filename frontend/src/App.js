import React, { useState, useRef, useEffect } from "react";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { motion, AnimatePresence } from "framer-motion";

// Define an array of colors for segments
const segmentColors = [
  "#0077BE",
  "#00A8E8",
  "#00C9FF",
  "#00E5FF",
  "#1DE9B6",
  "#00E676",
  "#69F0AE",
  "#B2FF59",
  "#76FF03",
  "#64DD17",
];

const App = () => {
  const [clientId, setClientId] = useState("");
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [segments, setSegments] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [downloadToken, setDownloadToken] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showStartMarker, setShowStartMarker] = useState(false);
  const [showEndMarker, setShowEndMarker] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredSegment, setHoveredSegment] = useState(null);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);

  // --- Persist client ID ---
  useEffect(() => {
    let savedId = localStorage.getItem("clientId");
    if (!savedId) {
      const getClientId = async () => {
        try {
          const res = await axios.get("http://localhost:5000/client-id");
          savedId = res.data.clientId;
          localStorage.setItem("clientId", savedId);
          setClientId(savedId);
          toast.success("Connected to server");
        } catch (error) {
          toast.error("Failed to get client ID");
          console.error("Error getting client ID:", error);
        }
      };
      getClientId();
    } else {
      setClientId(savedId);
    }
  }, []);

  // --- Handle file selection ---
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setSegments([]);
      setDownloadToken("");
      setCurrentTime(0); // Reset current time when a new video is selected
      toast.success(`Video "${file.name}" loaded successfully`);
    }
  };

  // --- Video events ---
  const handleVideoLoaded = () => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration);
      // Reset video to beginning
      videoRef.current.currentTime = 0;
      setCurrentTime(0);
      toast.success("Video ready for editing");
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (e) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  // --- Check if segments overlap ---
  const checkOverlap = (segment1, segment2) => {
    return (
      (segment1.start <= segment2.end && segment1.end >= segment2.start) ||
      (segment2.start <= segment1.end && segment2.end >= segment1.start)
    );
  };

  // --- Merge overlapping segments ---
  const mergeSegments = (segment1, segment2) => {
    return {
      start: Math.min(segment1.start, segment2.start),
      end: Math.max(segment1.end, segment2.end),
      color: segment1.color, // Keep the color of the first segment
    };
  };

  // --- Segment selection ---
  const startSelection = () => {
    setSelectionStart(currentTime);
    setSelectionEnd(currentTime);
    setIsSelecting(true);
    setShowStartMarker(true);
    setShowEndMarker(false);
    toast("Selection started", { icon: "🎬" });
  };

  const endSelection = () => {
    if (isSelecting) {
      const endTime = currentTime;
      setSelectionEnd(endTime);
      setIsSelecting(false);
      setShowEndMarker(true);

      if (endTime > selectionStart) {
        // Get a unique color for this segment
        const colorIndex = segments.length % segmentColors.length;
        const newSegment = {
          start: parseFloat(Math.min(selectionStart, endTime).toFixed(2)),
          end: parseFloat(Math.max(selectionStart, endTime).toFixed(2)),
          color: segmentColors[colorIndex],
        };

        // Check for overlapping segments
        let updatedSegments = [...segments];
        let mergedSegment = newSegment;
        let hasOverlap = false;

        for (let i = 0; i < updatedSegments.length; i++) {
          if (checkOverlap(mergedSegment, updatedSegments[i])) {
            mergedSegment = mergeSegments(mergedSegment, updatedSegments[i]);
            updatedSegments.splice(i, 1);
            i--; // Adjust index after removal
            hasOverlap = true;
          }
        }

        if (hasOverlap) {
          updatedSegments.push(mergedSegment);
          toast("Segments merged to avoid overlap", { icon: "🔗" });
        } else {
          updatedSegments.push(newSegment);
          toast.success("Segment added", { icon: "✂️" });
        }

        // Sort segments by start time
        updatedSegments.sort((a, b) => a.start - b.start);
        setSegments(updatedSegments);
      }

      // Hide markers after a short delay
      setTimeout(() => {
        setShowStartMarker(false);
        setShowEndMarker(false);
      }, 2000);
    }
  };

  const removeSegment = (index) => {
    const newSegments = [...segments];
    newSegments.splice(index, 1);
    setSegments(newSegments);
    toast("Segment removed", { icon: "🗑️" });
  };

  // --- Format time with milliseconds ---
  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    if (h > 0)
      return `${h}:${m.toString().padStart(2, "0")}:${s
        .toString()
        .padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}.${ms
      .toString()
      .padStart(3, "0")}`;
  };

  // --- Upload video ---
  const uploadVideo = async () => {
    if (!videoFile) return null;

    const formData = new FormData();
    formData.append("video", videoFile);
    formData.append("clientId", clientId);

    try {
      const response = await axios.post(
        "http://localhost:5000/upload",
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (progressEvent) => {
            const progress = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            setUploadProgress(progress);
          },
        }
      );

      setUploadProgress(0);
      return response.data.filename;
    } catch (error) {
      toast.error("Failed to upload video");
      console.error("Error uploading video:", error);
      return null;
    }
  };

  // --- Process video ---
  const processVideo = async () => {
    if (segments.length === 0) {
      toast.error("Please select at least one segment");
      return;
    }

    setIsProcessing(true);
    toast.loading("Processing video...", { id: "process" });

    try {
      const filename = await uploadVideo();
      if (!filename) return setIsProcessing(false);

      const response = await axios.post("http://localhost:5000/process", {
        filename,
        segments,
        clientId,
      });

      setDownloadToken(response.data.downloadToken);
      toast.success("Video processed successfully", {
        id: "process",
        icon: "🎉",
      });
    } catch (error) {
      toast.error("Failed to process video", { id: "process" });
      console.error("Error processing video:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  // --- Download video safely ---
  const downloadVideo = async () => {
    if (!downloadToken) return;
    try {
      const res = await axios.get(
        `http://localhost:5000/download/${downloadToken}`,
        { responseType: "blob" }
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = "processed-video.mp4";
      a.click();
      window.URL.revokeObjectURL(url);
      setDownloadToken(""); // reset token
      toast.success("Download started", { icon: "⬇️" });
    } catch (err) {
      toast.error("Failed to download video");
      console.error(err);
    }
  };

  // --- Cleanup files manually ---
  const handleCleanup = async () => {
    if (!clientId) return;
    try {
      await axios.post("http://localhost:5000/cleanup", { clientId });
      toast.success("Files cleaned up successfully");
      setVideoFile(null);
      setVideoUrl("");
      setSegments([]);
      setDownloadToken("");
      setCurrentTime(0); // Reset current time when cleaning up
    } catch (err) {
      toast.error("Failed to clean up files");
      console.error(err);
    }
  };

  const calculatePosition = (time) =>
    videoDuration ? (time / videoDuration) * 100 : 0;

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setSegments([]);
      setDownloadToken("");
      setCurrentTime(0); // Reset current time when a new video is dropped
      toast.success(`Video "${file.name}" loaded successfully`);
    } else {
      toast.error("Please drop a valid video file");
    }
  };

  return (
    <div className="min-h-screen bg-gray-950">
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "rgba(30, 30, 30, 0.9)",
            color: "#fff",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          },
          success: {
            duration: 3000,
            iconTheme: {
              primary: "#00E676",
              secondary: "#fff",
            },
          },
          error: {
            duration: 5000,
            iconTheme: {
              primary: "#00A8E8",
              secondary: "#fff",
            },
          },
        }}
      />

      {/* Header */}
      <header className="bg-gray-900 bg-opacity-60 backdrop-blur-xl shadow-2xl border-b border-gray-800">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-teal-500 rounded-lg flex items-center justify-center shadow-lg">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white">VidSnip</h1>
          </div>
          <div className="flex items-center space-x-2">
            <div className="badge badge-outline bg-gray-800 bg-opacity-60 text-gray-300 border-gray-700 px-3 py-4">
              Client ID: {clientId}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto p-4 max-w-7xl">
        {/* Upload Section */}
        <div className="mb-6">
          <div
            className={`bg-gray-900 bg-opacity-40 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-800 p-6 ${
              isDragging ? "border-blue-500 bg-opacity-60" : ""
            } transition-all duration-300`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="flex flex-wrap items-center justify-center gap-4">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="video/*"
                className="hidden"
              />
              <motion.button
                className="btn bg-gradient-to-r from-blue-500 to-teal-500 border-none text-white hover:from-blue-600 hover:to-teal-600 shadow-lg"
                onClick={() => fileInputRef.current.click()}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                Select Video
              </motion.button>
              {videoFile && (
                <motion.div
                  className="text-gray-300 flex items-center space-x-2"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5 text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span className="font-medium">Selected:</span>{" "}
                  {videoFile.name}
                </motion.div>
              )}
              <motion.button
                onClick={handleCleanup}
                className="btn bg-gray-800 bg-opacity-60 border-gray-700 text-gray-300 hover:bg-opacity-80"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                Clean Up
              </motion.button>
            </div>
            {!videoFile && (
              <div className="text-center mt-4 text-gray-400">
                <p>Drag and drop a video file here or click the button above</p>
              </div>
            )}
          </div>
        </div>

        {videoUrl && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Video Section */}
            <div className="lg:col-span-2">
              <motion.div
                className="bg-gray-900 bg-opacity-40 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-800 p-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
              >
                <div className="aspect-video bg-black rounded-xl overflow-hidden shadow-2xl">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    onLoadedMetadata={handleVideoLoaded}
                    onTimeUpdate={handleTimeUpdate}
                    className="w-full h-full"
                  />
                </div>

                {/* Video Controls */}
                <div className="mt-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <motion.button
                        onClick={togglePlayPause}
                        className="btn btn-circle bg-gradient-to-r from-blue-500 to-teal-500 border-none text-white shadow-lg"
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                      >
                        {isPlaying ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-6 w-6"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                        ) : (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-6 w-6"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                        )}
                      </motion.button>
                      <div className="text-gray-300">
                        <span className="font-mono text-lg">
                          {formatTime(currentTime)}
                        </span>
                        <span className="mx-2 text-gray-500">/</span>
                        <span className="font-mono text-lg text-gray-400">
                          {formatTime(videoDuration)}
                        </span>
                      </div>
                    </div>
                    <div className="text-gray-400 text-sm">
                      {isSelecting ? (
                        <span className="flex items-center">
                          <span className="w-2 h-2 bg-red-500 rounded-full mr-2 animate-pulse"></span>
                          Selecting...
                        </span>
                      ) : (
                        <span>Ready</span>
                      )}
                    </div>
                  </div>

                  {/* Timeline */}
                  <div className="mb-6">
                    <div className="relative h-16 bg-gray-800 bg-opacity-60 rounded-xl overflow-hidden shadow-inner">
                      {segments.map((segment, index) => (
                        <motion.div
                          key={index}
                          className="absolute h-12 top-2 rounded-md shadow-md cursor-pointer"
                          style={{
                            left: `${calculatePosition(segment.start)}%`,
                            width: `${calculatePosition(
                              segment.end - segment.start
                            )}%`,
                            backgroundColor: segment.color,
                          }}
                          title={`${formatTime(segment.start)} - ${formatTime(
                            segment.end
                          )}`}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3 }}
                          whileHover={{ scale: 1.05 }}
                        />
                      ))}
                      {isSelecting && (
                        <motion.div
                          className="absolute h-12 top-2 bg-white bg-opacity-20 border-2 border-white border-dashed rounded-md"
                          style={{
                            left: `${calculatePosition(selectionStart)}%`,
                            width: `${calculatePosition(
                              selectionEnd - selectionStart
                            )}%`,
                          }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.2 }}
                        />
                      )}
                      <div
                        className="absolute w-1 h-full bg-white shadow-lg"
                        style={{ left: `${calculatePosition(currentTime)}%` }}
                      />
                      {showStartMarker && (
                        <motion.div
                          className="absolute w-1 h-full bg-red-500"
                          style={{
                            left: `${calculatePosition(selectionStart)}%`,
                          }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.2 }}
                        />
                      )}
                      {showEndMarker && (
                        <motion.div
                          className="absolute w-1 h-full bg-red-500"
                          style={{
                            left: `${calculatePosition(selectionEnd)}%`,
                          }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.2 }}
                        />
                      )}
                    </div>
                    <input
                      type="range"
                      min="0"
                      max={videoDuration}
                      step="0.01" // Changed to 0.01 for more precise seeking
                      value={currentTime}
                      onChange={handleSeek}
                      className="w-full mt-2 slider"
                    />
                  </div>

                  {/* Selection Controls */}
                  <div className="flex gap-3 justify-center">
                    <motion.button
                      onClick={startSelection}
                      disabled={isSelecting}
                      className={`btn ${
                        isSelecting
                          ? "bg-red-500"
                          : "bg-gradient-to-r from-blue-500 to-cyan-500"
                      } border-none text-white shadow-lg`}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      {isSelecting ? (
                        <>
                          <span className="w-2 h-2 bg-white rounded-full mr-2 animate-pulse"></span>
                          Selecting...
                        </>
                      ) : (
                        <>
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-5 w-5 mr-2"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 4v16m8-8H4"
                            />
                          </svg>
                          Start Selection
                        </>
                      )}
                    </motion.button>
                    <motion.button
                      onClick={endSelection}
                      disabled={!isSelecting}
                      className="btn bg-gradient-to-r from-green-500 to-teal-500 border-none text-white shadow-lg disabled:opacity-50"
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5 mr-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      End Selection
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            </div>

            {/* Segments and Process Section */}
            <div className="lg:col-span-1">
              <motion.div
                className="bg-gray-900 bg-opacity-40 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-800 p-6 h-full flex flex-col"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
              >
                <h3 className="text-white text-lg mb-4 flex items-center">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-6 w-6 mr-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                    />
                  </svg>
                  Selected Segments
                </h3>

                {segments.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center text-gray-400">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-12 w-12 mx-auto mb-3 text-gray-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 15l-2 5L9 9l11 4-5 2z"
                        />
                      </svg>
                      <p>No segments selected yet</p>
                      <p className="text-sm mt-1">
                        Use the timeline to select segments
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto space-y-2 mb-4">
                    <AnimatePresence>
                      {segments.map((segment, index) => (
                        <motion.div
                          key={index}
                          className="flex items-center justify-between p-3 bg-gray-800 bg-opacity-40 rounded-lg backdrop-blur-sm border border-gray-700 m-2"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          transition={{ duration: 0.3 }}
                          whileHover={{
                            backgroundColor: "rgba(55, 65, 81, 0.6)",
                            boxShadow: "0 0px 10px rgba(255, 255, 255, 0.3)",
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className="w-4 h-4 rounded-full shadow-md"
                              style={{ backgroundColor: segment.color }}
                            />
                            <span className="text-gray-300 font-mono text-sm">
                              {formatTime(segment.start)} -{" "}
                              {formatTime(segment.end)}
                            </span>
                          </div>
                          <motion.button
                            onClick={() => removeSegment(index)}
                            className="btn btn-ghost btn-circle btn-sm text-gray-400 hover:bg-red-500 hover:bg-opacity-20 hover:text-red-400"
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </motion.button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                )}

                {/* Process Section */}
                <div className="mt-auto">
                  <motion.button
                    onClick={processVideo}
                    disabled={isProcessing || segments.length === 0}
                    className="btn w-full bg-gradient-to-r from-blue-500 to-teal-500 border-none text-white shadow-lg disabled:opacity-50"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {isProcessing ? (
                      <>
                        <span className="loading loading-spinner"></span>
                        Processing...
                      </>
                    ) : (
                      <>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5 mr-2"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        Process Video
                      </>
                    )}
                  </motion.button>

                  {uploadProgress > 0 && (
                    <div className="mt-3">
                      <div className="flex justify-between text-gray-300 text-sm mb-1">
                        <span>Uploading</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full bg-gray-800 bg-opacity-60 rounded-full h-2">
                        <motion.div
                          className="h-2 bg-gradient-to-r from-blue-500 to-teal-500 rounded-full"
                          style={{ width: `${uploadProgress}%` }}
                          initial={{ width: 0 }}
                          animate={{ width: `${uploadProgress}%` }}
                          transition={{ duration: 0.3 }}
                        ></motion.div>
                      </div>
                    </div>
                  )}

                  {downloadToken && (
                    <motion.div
                      className="mt-4"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3 }}
                    >
                      <div className="bg-green-900 bg-opacity-30 border border-green-700 text-green-300 p-3 rounded-lg backdrop-blur-sm">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="inline-block h-5 w-5 mr-2"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <span>Video ready for download</span>
                      </div>
                      <motion.button
                        onClick={downloadVideo}
                        className="btn w-full bg-gradient-to-r from-green-500 to-teal-500 border-none text-white shadow-lg mt-2"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5 mr-2"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
                          />
                        </svg>
                        Download Video
                      </motion.button>
                    </motion.div>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        .slider {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          cursor: pointer;
        }

        .slider::-webkit-slider-track {
          background: rgba(75, 85, 99, 0.6);
          height: 6px;
          border-radius: 3px;
        }

        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          background: linear-gradient(to right, #3b82f6, #14b8a6);
          height: 18px;
          width: 18px;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        .slider::-moz-range-track {
          background: rgba(75, 85, 99, 0.6);
          height: 6px;
          border-radius: 3px;
        }

        .slider::-moz-range-thumb {
          background: linear-gradient(to right, #3b82f6, #14b8a6);
          height: 18px;
          width: 18px;
          border-radius: 50%;
          cursor: pointer;
          border: none;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }
      `}</style>
    </div>
  );
};

export default App;

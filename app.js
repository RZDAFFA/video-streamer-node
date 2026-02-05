const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 9001;

const LOG_DIR = 'logs';
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const APP_LOG = path.join(LOG_DIR, 'app.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logError(message, error = null) {
    const time = new Date().toISOString();
    const detail = error ? (error.stack || error.toString()) : '';
    const line = `[${time}] ERROR: ${message}\n${detail}\n\n`;
    fs.appendFileSync(ERROR_LOG, line);
    console.error(line);
}

function logInfo(message) {
    const time = new Date().toISOString();
    const line = `[${time}] INFO: ${message}\n`;
    fs.appendFileSync(APP_LOG, line);
    console.log(line.trim());
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use((err, req, res, next) => {
    logError(`HTTP ${req.method} ${req.url}`, err);
    res.status(500).json({ error: 'Server error' });
});

// Configuration
const config = {
    uploadFolder: 'uploads',
    outputFolder: 'output',
    maxFileSize: 500 * 1024 * 1024, // 500MB
    allowedExtensions: ['.mp4', '.avi', '.mov', '.mkv', '.webm'],
    hlsTime: 6,          // 6 second segments
    hlsListSize: 10,     // Keep 10 segments (increased for better looping)
//    maxSegments: 10,     // Maximum segments before auto-delete
    maxConcurrentStreams: 10
};

// Create directories
if (!fs.existsSync(config.uploadFolder)) {
    fs.mkdirSync(config.uploadFolder, { recursive: true });
}
if (!fs.existsSync(config.outputFolder)) {
    fs.mkdirSync(config.outputFolder, { recursive: true });
}

// Store active streams
let activeStreams = {};

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.uploadFolder);
    },
    filename: (req, file, cb) => {
        const streamId = req.body.name + '_' + uuidv4().substring(0, 8);
        const sanitizedName = file.originalname.replace(/[<>:"/\\|?*]/g, '_');
        cb(null, `${streamId}_${sanitizedName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: config.maxFileSize },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (config.allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});


// Utility functions
function sanitizeFilename(filename) {
    return filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

// Auto-delete old segments function
// function setupSegmentCleaner(streamId, outputPath) {
//     const cleanerInterval = setInterval(() => {
//         if (!activeStreams[streamId]) {
//             clearInterval(cleanerInterval);
//             return;
//         }

//         try {
//             if (!fs.existsSync(outputPath)) {
//                 clearInterval(cleanerInterval);
//                 return;
//             }

//             const files = fs.readdirSync(outputPath);
//             const segmentFiles = files
//                 .filter(file => file.endsWith('.ts') && file.startsWith('segment_'))
//                 .map(file => {
//                     const filePath = path.join(outputPath, file);
//                     const stats = fs.statSync(filePath);
//                     return {
//                         name: file,
//                         path: filePath,
//                         mtime: stats.mtime.getTime()
//                     };
//                 })
//                 .sort((a, b) => a.mtime - b.mtime); // Sort by creation time

//             // Keep only the latest 10 segments
//             if (segmentFiles.length > config.maxSegments) {
//                 const filesToDelete = segmentFiles.slice(0, segmentFiles.length - config.maxSegments);
//                 filesToDelete.forEach(file => {
//                     try {
//                         fs.unlinkSync(file.path);
//                         console.log(`Auto-deleted old segment: ${file.name} for stream ${streamId}`);
//                     } catch (err) {
//                         console.error(`Error deleting segment ${file.name}:`, err.message);
//                     }
//                 });
//             }
//         } catch (error) {
//             console.error(`Error in segment cleaner for ${streamId}:`, error.message);
//         }
//     }, 10000); // Check every 10 seconds

//     // Store the interval ID for cleanup
//     if (activeStreams[streamId]) {
//         activeStreams[streamId].cleanerInterval = cleanerInterval;
//     }
// }

// Tambahkan logging stdout dan stderr dari FFmpeg ke dalam fungsi
function startFFmpegStream(inputPath, outputPath) {
    const outputSegmentPath = path.join(outputPath, 'segment_%05d.ts');
    const outputPlaylistPath = path.join(outputPath, 'index.m3u8');

    const cmd = [
        '-y',
        '-stream_loop', '-1',
        '-i', inputPath,
        // '-c:v', 'libx264',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '28',
        '-maxrate', '1500k',
        '-bufsize', '3000k',
        // Auto-scale to even resolution (avoid error: height not divisible by 2)
        //'-vf', 'scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2,fps=24',
        '-vf',
        'scale=w=if(gt(iw\\,1920)\\,1920\\,iw):h=if(gt(ih\\,1080)\\,1080\\,ih):force_original_aspect_ratio=decrease,pad=w=ceil(iw/2)*2:h=ceil(ih/2)*2,setsar=1,fps=24', 
        '-g', '48',
        '-sc_threshold', '0',
        '-threads', '2',
        // '-c:a', 'aac',
        '-b:a', '96k',
        '-ac', '2',
        '-ar', '44100',
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_list_size', '10',
        '-hls_playlist_type', 'event',
        // '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_flags', 'delete_segments+independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', outputSegmentPath,
        outputPlaylistPath
    ];

    console.log('🚀 Starting FFmpeg with command:\nffmpeg ' + cmd.join(' '));

    const ffmpegProcess = spawn('ffmpeg', cmd);

    ffmpegProcess.stdout.on('data', (data) => {
        logInfo(`[FFmpeg ${ffmpegProcess.pid}] ${data.toString().trim()}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        logError(`[FFmpeg ${ffmpegProcess.pid}] stderr`, data.toString());
    });

    ffmpegProcess.on('exit', (code) => {
        logInfo(`⚠️ FFmpeg process exited with code ${code}`);
    });

    ffmpegProcess.on('exit', (code, signal) => {
        logError(`FFmpeg exited`, `code=${code}, signal=${signal}`);
    });

    ffmpegProcess.on('error', (err) => {
        logError('FFmpeg spawn failed', err);
    });

    // Optional: reduce process priority
    if (ffmpegProcess.pid) {
        try {
            exec(`renice +10 ${ffmpegProcess.pid}`);
        } catch (err) {
            console.warn('Could not renice FFmpeg process:', err.message);
        }
    }

    return ffmpegProcess;
}

function cleanupInputFile(filePath) {
    // setTimeout(() => {
    //     if (fs.existsSync(filePath)) {
    //         fs.unlinkSync(filePath);
    //         console.log(`Cleaned up input file: ${filePath}`);
    //     }
    // }, 300000); // 5 minutes
}

// Routes
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Video Loop Streamer Control Panel</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 900px;
                margin: 20px auto;
                padding: 20px;
                background: #f5f5f5;
            }
            .container {
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                margin-bottom: 20px;
            }
            h1 { color: #333; text-align: center; }
            h2 { color: #666; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
            .form-group { margin: 15px 0; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input[type="text"], input[type="file"] {
                width: 100%;
                padding: 10px;
                border: 1px solid #ddd;
                border-radius: 4px;
                box-sizing: border-box;
            }
            .btn {
                padding: 10px 15px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin: 5px;
            }
            .btn-primary { background: #007bff; color: white; }
            .btn-danger { background: #dc3545; color: white; }
            .btn-success { background: #28a745; color: white; }
            .btn:hover { opacity: 0.8; }
            .stream-item {
                background: #f8f9fa;
                padding: 15px;
                margin: 10px 0;
                border-radius: 4px;
                border: 1px solid #dee2e6;
                border-left: 4px solid #28a745;
            }
            .stream-url {
                background: #e9ecef;
                padding: 8px;
                border-radius: 3px;
                font-family: monospace;
                font-size: 12px;
                word-break: break-all;
                margin: 5px 0;
                cursor: pointer;
            }
            .stream-url:hover {
                background: #dee2e6;
            }
            .status {
                margin-top: 20px;
                padding: 10px;
                border-radius: 4px;
                display: none;
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 1000;
                min-width: 300px;
            }
            .status.success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .status.error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .loop-info {
                background: #e3f2fd;
                padding: 10px;
                border-radius: 4px;
                margin: 10px 0;
                font-size: 12px;
                color: #1565c0;
            }
        </style>
    </head>
    <body>
        <h1>🎥 Video Loop Streamer Control Panel</h1>

        <div class="container">
            <div class="loop-info">
                <strong>🔄 Auto-Loop Feature:</strong> Videos will automatically loop continuously.
                Old segments are automatically deleted after 10 segments to maintain optimal performance.
            </div>
        </div>

        <div class="container">
            <h2>📤 Upload New Video</h2>
            <form id="uploadForm" enctype="multipart/form-data">
                <div class="form-group">
                    <label for="name">Stream Name:</label>
                    <input type="text" name="name" id="name" required placeholder="Enter stream name">
                </div>
                <div class="form-group">
                    <label for="file">Select Video:</label>
                    <input type="file" name="file" id="file" accept="video/*" required>
                </div>
                <button type="submit" class="btn btn-primary">📤 Upload and Start Stream</button>
            </form>
        </div>

        <div class="container">
            <h2>🎛️ Stream Control Panel</h2>
            <button onclick="refreshStreams()" class="btn btn-primary">🔄 Refresh Stream List</button>
            <button onclick="stopAllStreams()" class="btn btn-danger">⏹️ Stop All Streams</button>
            <button onclick="cleanupAll()" class="btn btn-danger">🧹 Cleanup All</button>
        </div>

        <div class="container">
            <h2>📡 Active Streams</h2>
            <div id="streamsList">
                <div id="noStreams" style="text-align: center; color: #666; padding: 20px;">
                    No active streams found
                </div>
            </div>
        </div>

        <div id="status" class="status"></div>

        <script>
            function showStatus(message, type = 'success') {
                const statusDiv = document.getElementById('status');
                statusDiv.className = 'status ' + type;
                statusDiv.textContent = message;
                statusDiv.style.display = 'block';
                setTimeout(() => statusDiv.style.display = 'none', 3000);
            }

            async function refreshStreams() {
                try {
                    const response = await fetch('/streams');
                    const streams = await response.json();
                    displayStreams(streams);
                } catch (error) {
                    showStatus('Failed to load streams: ' + error.message, 'error');
                }
            }

            function displayStreams(streams) {
                const container = document.getElementById('streamsList');
                const noStreamsDiv = document.getElementById('noStreams');

                if (Object.keys(streams).length === 0) {
                    noStreamsDiv.style.display = 'block';
                    container.innerHTML = '<div id="noStreams" style="text-align: center; color: #666; padding: 20px;">No active streams found</div>';
                    return;
                }

                let html = '';
                for (const [streamId, streamUrl] of Object.entries(streams)) {
                    const fullUrl = window.location.origin + streamUrl;
                    html += \`
                        <div class="stream-item">
                            <h3>🟢 \${streamId}</h3>
                            <div class="stream-url" onclick="copyToClipboard('\${fullUrl}')" title="Click to copy URL">
                                <strong>HLS URL:</strong> \${fullUrl}
                            </div>
                            <div class="loop-info">
                                🔄 This stream is automatically looping. Segments auto-delete after 10 segments.
                            </div>
                            <div style="margin-top: 10px;">
                                <button onclick="copyToClipboard('\${fullUrl}')" class="btn btn-success">📋 Copy URL</button>
                                <button onclick="testStream('\${streamUrl}')" class="btn btn-primary">▶️ Test Stream</button>
                                <button onclick="stopStream('\${streamId}')" class="btn btn-danger">⏹️ Stop Stream</button>
                            </div>
                        </div>
                    \`;
                }
                container.innerHTML = html;
            }

            // Fixed copy function
            async function copyToClipboard(text) {
                try {
                    if (navigator.clipboard && window.isSecureContext) {
                        await navigator.clipboard.writeText(text);
                        showStatus('📋 Stream URL copied to clipboard!', 'success');
                    } else {
                        // Fallback for older browsers or non-secure contexts
                        const textArea = document.createElement('textarea');
                        textArea.value = text;
                        textArea.style.position = 'fixed';
                        textArea.style.left = '-999999px';
                        textArea.style.top = '-999999px';
                        document.body.appendChild(textArea);
                        textArea.focus();
                        textArea.select();

                        try {
                            document.execCommand('copy');
                            textArea.remove();
                            showStatus('📋 Stream URL copied to clipboard!', 'success');
                        } catch (err) {
                            textArea.remove();
                            showStatus('❌ Failed to copy URL. Please copy manually.', 'error');
                        }
                    }
                } catch (err) {
                    console.error('Copy failed:', err);
                    showStatus('❌ Failed to copy URL. Please copy manually.', 'error');
                }
            }

            function testStream(url) {
                const fullUrl = window.location.origin + url;
                window.open(fullUrl, '_blank');
            }

            async function stopStream(streamId) {
                if (!confirm(\`Are you sure you want to stop stream: \${streamId}?\`)) return;
                try {
                    const response = await fetch(\`/streams/\${streamId}\`, { method: 'DELETE' });
                    if (response.ok) {
                        showStatus(\`✅ Stream \${streamId} stopped successfully\`, 'success');
                        refreshStreams();
                    } else {
                        const error = await response.json();
                        showStatus(\`❌ Failed to stop stream: \${error.error}\`, 'error');
                    }
                } catch (error) {
                    showStatus(\`❌ Error stopping stream: \${error.message}\`, 'error');
                }
            }

            async function stopAllStreams() {
                if (!confirm('Are you sure you want to stop ALL streams?')) return;
                try {
                    const response = await fetch('/streams/all', { method: 'DELETE' });
                    if (response.ok) {
                        showStatus('✅ All streams stopped successfully', 'success');
                        refreshStreams();
                    }
                } catch (error) {
                    showStatus(\`❌ Error stopping streams: \${error.message}\`, 'error');
                }
            }

            async function cleanupAll() {
                if (!confirm('Are you sure you want to cleanup all files?')) return;
                try {
                    const response = await fetch('/cleanup', { method: 'POST' });
                    if (response.ok) {
                        showStatus('✅ Cleanup completed successfully', 'success');
                        refreshStreams();
                    }
                } catch (error) {
                    showStatus(\`❌ Error during cleanup: \${error.message}\`, 'error');
                }
            }

            document.getElementById('uploadForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const formData = new FormData(e.target);

                try {
                    showStatus('⏳ Uploading and processing video...', 'success');
                    const response = await fetch('/upload', {
                        method: 'POST',
                        body: formData
                    });

                    if (response.ok) {
                        const result = await response.json();
                        showStatus(\`✅ Stream started: \${result.stream_id}\`, 'success');
                        e.target.reset();
                        refreshStreams();
                    } else {
                        const error = await response.json();
                        showStatus(\`❌ Upload failed: \${error.error}\`, 'error');
                    }
                } catch (error) {
                    showStatus(\`❌ Upload error: \${error.message}\`, 'error');
                }
            });

            // Auto refresh streams
            refreshStreams();
            setInterval(refreshStreams, 30000);
        </script>
    </body>
    </html>
    `);
});

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        const { name } = req.body;
        const file = req.file;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Stream name cannot be empty' });
        }

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Check concurrent stream limit
        const activeStreamCount = Object.keys(activeStreams).length;
        if (activeStreamCount >= config.maxConcurrentStreams) {
            return res.status(429).json({
                error: `Maximum ${config.maxConcurrentStreams} concurrent streams allowed. Please stop a stream first.`
            });
        }

        const streamId = `${sanitizeFilename(name)}_${uuidv4().substring(0, 8)}`;
        const inputPath = file.path;
        const outputPath = path.join(config.outputFolder, streamId);

        // Create output directory
        if (fs.existsSync(outputPath)) {
            fs.rmSync(outputPath, { recursive: true, force: true });
        }
        fs.mkdirSync(outputPath, { recursive: true });

        // Start FFmpeg process
        const ffmpegProcess = startFFmpegStream(inputPath, outputPath);

        activeStreams[streamId] = {
            process: ffmpegProcess,
            outputPath: outputPath,
            inputPath: inputPath,
            startTime: Date.now(),
            // cleanerInterval: null
        };

        // Setup automatic segment cleaner
        setTimeout(() => {
            setupSegmentCleaner(streamId, outputPath);
        }, 30000); // Start cleaning after 30 seconds

        ffmpegProcess.on('error', (error) => {
            console.error(`FFmpeg error for ${streamId}:`, error);
            if (activeStreams[streamId] && activeStreams[streamId].cleanerInterval) {
                clearInterval(activeStreams[streamId].cleanerInterval);
            }
            delete activeStreams[streamId];
        });

        ffmpegProcess.on('exit', (code) => {
            console.log(`FFmpeg process for ${streamId} exited with code ${code}`);
            if (activeStreams[streamId]) {
                if (activeStreams[streamId].cleanerInterval) {
                    clearInterval(activeStreams[streamId].cleanerInterval);
                }
                delete activeStreams[streamId];
            }
        });

        // Schedule cleanup of input file
        cleanupInputFile(inputPath);

        const streamUrl = `/output/${streamId}/index.m3u8`;
        console.log(`🔄 Loop stream started: ${streamId} (${activeStreamCount + 1}/${config.maxConcurrentStreams} active)`);

        res.json({
            stream_id: streamId,
            stream_url: streamUrl,
            status: 'streaming',
            loop_enabled: true,
            auto_segment_cleanup: true,
            max_segments: config.maxSegments,
            active_streams: activeStreamCount + 1,
            max_streams: config.maxConcurrentStreams
        });

    } catch (error) {
        logError('Upload processing failed', error);
        res.status(500).json({ error: 'Internal server error' });
    }

});

// Serve output files
app.use('/output', express.static(config.outputFolder, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// List streams endpoint
app.get('/streams', (req, res) => {
    const streams = {};
    for (const [streamId, data] of Object.entries(activeStreams)) {
        if (data.process && !data.process.killed) {
            streams[streamId] = `/output/${streamId}/index.m3u8`;
        }
    }
    res.json(streams);
});

// Stop specific stream
app.delete('/streams/:streamId', (req, res) => {
    const { streamId } = req.params;

    if (!activeStreams[streamId]) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    const stream = activeStreams[streamId];

    // Stop segment cleaner
    // if (stream.cleanerInterval) {
    //     clearInterval(stream.cleanerInterval);
    // }

    // Kill FFmpeg process
    if (stream.process && !stream.process.killed) {
        stream.process.kill('SIGTERM');
        setTimeout(() => {
            if (!stream.process.killed) {
                stream.process.kill('SIGKILL');
            }
        }, 5000);
    }

    // Clean up output directory
    if (fs.existsSync(stream.outputPath)) {
        fs.rmSync(stream.outputPath, { recursive: true, force: true });
    }

    delete activeStreams[streamId];
    console.log(`🛑 Stream stopped: ${streamId}`);
    res.json({ message: `Stream ${streamId} stopped` });
});

// Stop all streams
app.delete('/streams/all', (req, res) => {
    const stoppedStreams = [];

    for (const [streamId, stream] of Object.entries(activeStreams)) {
        // Stop segment cleaner
        // if (stream.cleanerInterval) {
        //     clearInterval(stream.cleanerInterval);
        // }

        if (stream.process && !stream.process.killed) {
            stream.process.kill('SIGTERM');
            setTimeout(() => {
                if (!stream.process.killed) {
                    stream.process.kill('SIGKILL');
                }
            }, 5000);
        }

        if (fs.existsSync(stream.outputPath)) {
            fs.rmSync(stream.outputPath, { recursive: true, force: true });
        }

        stoppedStreams.push(streamId);
    }

    activeStreams = {};
    console.log(`🛑 All streams stopped: ${stoppedStreams.length} streams`);
    res.json({
        message: `Stopped ${stoppedStreams.length} streams`,
        stopped_streams: stoppedStreams
    });
});

// Cleanup endpoint
app.post('/cleanup', (req, res) => {
    try {
        // Stop all streams first
        for (const [streamId, stream] of Object.entries(activeStreams)) {
            // if (stream.cleanerInterval) {
            //     clearInterval(stream.cleanerInterval);
            // }
            if (stream.process && !stream.process.killed) {
                stream.process.kill('SIGKILL');
            }
        }
        activeStreams = {};

        // Clean up upload files
        let uploadFilesRemoved = 0;
        if (fs.existsSync(config.uploadFolder)) {
            const files = fs.readdirSync(config.uploadFolder);
            files.forEach(file => {
                const filePath = path.join(config.uploadFolder, file);
                if (fs.lstatSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                    uploadFilesRemoved++;
                }
            });
        }

        // Clean up output directories
        let outputDirsRemoved = 0;
        if (fs.existsSync(config.outputFolder)) {
            const dirs = fs.readdirSync(config.outputFolder);
            dirs.forEach(dir => {
                const dirPath = path.join(config.outputFolder, dir);
                if (fs.lstatSync(dirPath).isDirectory()) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    outputDirsRemoved++;
                }
            });
        }

        const message = `🧹 Cleanup completed: ${uploadFilesRemoved} upload files and ${outputDirsRemoved} stream directories removed`;
        console.log(message);

        res.json({
            message: message,
            upload_files_removed: uploadFilesRemoved,
            stream_directories_removed: outputDirsRemoved
        });

    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(500).json({ error: `Cleanup failed: ${error.message}` });
    }
});

// Stream info endpoint
app.get('/streams/:streamId/info', (req, res) => {
    const { streamId } = req.params;

    if (!activeStreams[streamId]) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    const stream = activeStreams[streamId];
    const isRunning = stream.process && !stream.process.killed;

    let segmentFiles = [];
    let playlistExists = false;

    if (fs.existsSync(stream.outputPath)) {
        const playlistPath = path.join(stream.outputPath, 'index.m3u8');
        playlistExists = fs.existsSync(playlistPath);

        const files = fs.readdirSync(stream.outputPath);
        segmentFiles = files
            .filter(file => file.endsWith('.ts'))
            .map(file => {
                const filePath = path.join(stream.outputPath, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    created: stats.mtime.getTime()
                };
            })
            .sort((a, b) => b.created - a.created); // Sort by newest first
    }

    res.json({
        stream_id: streamId,
        status: isRunning ? 'running' : 'stopped',
        process_id: stream.process ? stream.process.pid : null,
        playlist_exists: playlistExists,
        segment_count: segmentFiles.length,
        max_segments: config.maxSegments,
        auto_cleanup_enabled: true,
        loop_enabled: true,
        segments: segmentFiles,
        stream_url: playlistExists ? `/output/${streamId}/index.m3u8` : null
    });
});

process.on('uncaughtException', (err) => {
    logError('UNCAUGHT EXCEPTION', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logError('UNHANDLED PROMISE REJECTION', reason);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎥 Video Loop Streamer running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Upload folder: ${config.uploadFolder}`);
    console.log(`📁 Output folder: ${config.outputFolder}`);
    console.log(`🔄 Auto-loop enabled with ${config.maxSegments} max segments`);
    console.log(`🧹 Auto-cleanup enabled for old segments`);
});
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 9001;

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

/* ================= CONFIG ================= */
const config = {
    uploadFolder: 'uploads',
    outputFolder: 'output',
    maxFileSize: 500 * 1024 * 1024,
    maxConcurrentStreams: 10,
    maxSegments: 10
};

fs.mkdirSync(config.uploadFolder, { recursive: true });
fs.mkdirSync(config.outputFolder, { recursive: true });

/* ================= STATE ================= */
let activeStreams = {};
const pendingMerge = new Map();

/* ================= MULTER ================= */
const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, config.uploadFolder),
    filename: (_, file, cb) => {
        const safe = file.originalname.replace(/[<>:"/\\|?*]/g, '_');
        cb(null, `${Date.now()}_${safe}`);
    }
});
const upload = multer({ storage, limits: { fileSize: config.maxFileSize } });

/* ================= UTIL ================= */
function sanitize(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

function cleanupLater(file) {
    setTimeout(() => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }, 300000);
}

/* ================= MERGE RE-ENCODE ================= */
function mergeReencodeSequential(v1, v2, output, cb) {
    const cmd = [
        '-y',
        '-i', v1,
        '-i', v2,
        '-filter_complex',
        '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];' +
        '[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];' +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[outv][outa]',
        '-map','[outv]',
        '-map','[outa]',
        '-c:v','libx264',
        '-preset','veryfast',
        '-crf','23',
        '-pix_fmt','yuv420p',
        '-c:a','aac',
        '-b:a','128k',
        '-movflags','+faststart',
        output
    ];

    const p = spawn('ffmpeg', cmd);
    p.stderr.on('data', d => console.log('[merge]', d.toString()));
    p.on('exit', c => cb(c === 0));
}

/* ================= START HLS ================= */
function startFFmpegStream(input, outDir) {
    const args = [
        '-y',
        '-stream_loop','-1',
        '-i', input,
        '-c:v','libx264',
        '-preset','ultrafast',
        '-tune','zerolatency',
        '-g','48',
        '-c:a','aac',
        '-b:a','96k',
        '-f','hls',
        '-hls_time','6',
        '-hls_list_size','10',
        '-hls_flags','delete_segments+append_list',
        '-hls_segment_filename', path.join(outDir,'segment_%05d.ts'),
        path.join(outDir,'index.m3u8')
    ];

    const p = spawn('ffmpeg', args);
    exec(`renice +10 ${p.pid}`);
    return p;
}

/* ================= HTML UI ================= */
app.get('/', (req,res)=>{
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Video Loop Streamer</title>
<style>
body{font-family:Arial;background:#f5f5f5;max-width:900px;margin:auto;padding:20px}
.container{background:#fff;padding:20px;border-radius:8px;margin-bottom:20px}
button{padding:8px 12px;margin-top:10px}
</style>
</head>
<body>

<h2>Upload Single Video (Mode Lama)</h2>
<div class="container">
<form id="single">
<input type="text" name="name" placeholder="Stream Name" required><br>
<input type="file" name="file" required><br>
<button>Upload</button>
</form>
</div>

<h2>Upload 2 Video (Mode Merge)</h2>
<div class="container">
<input type="file" id="v1"><br>
<button onclick="upload1()">Upload Video 1</button><br><br>

<input type="file" id="v2"><br>
<input type="text" id="name" placeholder="Stream Name"><br>
<button onclick="upload2()">Upload Video 2 & Start</button>
</div>

<script>
let mergeId=null;

document.getElementById('single').onsubmit=async(e)=>{
e.preventDefault();
const f=new FormData(e.target);
await fetch('/upload',{method:'POST',body:f});
alert('Stream started');
};

async function upload1(){
const f=new FormData();
f.append('file',v1.files[0]);
const r=await fetch('/upload/step1',{method:'POST',body:f});
const j=await r.json();
mergeId=j.merge_id;
alert('Video 1 OK');
}

async function upload2(){
const f=new FormData();
f.append('file',v2.files[0]);
f.append('merge_id',mergeId);
f.append('name',name.value);
await fetch('/upload/step2',{method:'POST',body:f});
alert('Merged stream started');
}
</script>
</body>
</html>
`);
});

/* ================= UPLOAD SINGLE (LAMA) ================= */
app.post('/upload', upload.single('file'), (req,res)=>{
    const name = sanitize(req.body.name);
    const streamId = name+'_'+uuidv4().slice(0,8);
    const outDir = path.join(config.outputFolder,streamId);
    fs.mkdirSync(outDir,{recursive:true});

    const ff = startFFmpegStream(req.file.path,outDir);
    activeStreams[streamId]={process:ff,outputPath:outDir,inputPath:req.file.path};
    cleanupLater(req.file.path);

    res.json({stream_id:streamId});
});

/* ================= UPLOAD STEP 1 ================= */
app.post('/upload/step1', upload.single('file'), (req,res)=>{
    const id = uuidv4().slice(0,8);
    pendingMerge.set(id,{video1:req.file.path,time:Date.now()});
    res.json({merge_id:id});
});

/* ================= UPLOAD STEP 2 ================= */
app.post('/upload/step2', upload.single('file'), (req,res)=>{
    const { merge_id, name } = req.body;
    if(!pendingMerge.has(merge_id)) return res.status(400).json({error:'invalid merge id'});

    const v1=pendingMerge.get(merge_id).video1;
    const v2=req.file.path;

    const streamId=sanitize(name)+'_'+uuidv4().slice(0,8);
    const outDir=path.join(config.outputFolder,streamId);
    fs.mkdirSync(outDir,{recursive:true});

    const merged=path.join(config.uploadFolder,`${streamId}_merged.mp4`);

    mergeReencodeSequential(v1,v2,merged,(ok)=>{
        if(!ok) return res.status(500).json({error:'merge failed'});

        fs.unlinkSync(v1);
        fs.unlinkSync(v2);
        pendingMerge.delete(merge_id);

        const ff=startFFmpegStream(merged,outDir);
        activeStreams[streamId]={process:ff,outputPath:outDir,inputPath:merged};
        cleanupLater(merged);

        res.json({stream_id:streamId});
    });
});

/* ================= STATIC ================= */
app.use('/output', express.static(config.outputFolder));

/* ================= START ================= */
app.listen(PORT,'0.0.0.0',()=>{
console.log('🚀 Server running on port '+PORT);
});

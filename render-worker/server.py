import os
import json
import shutil
import tempfile
import subprocess

from flask import Flask, request, jsonify, send_file

app = Flask(__name__)

# --- Auth -----------------------------------------------------------------
# The worker never exposes this secret; it only verifies incoming Bearer tokens.
SECRET = os.environ.get("RENDER_WORKER_SECRET", "")


def _authorized():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    return bool(SECRET) and auth[len("Bearer "):] == SECRET


@app.before_request
def _guard():
    # /health is public; everything else requires the Bearer secret.
    if request.path == "/health":
        return
    if not _authorized():
        return jsonify({"error": "unauthorized"}), 401


# --- Helpers --------------------------------------------------------------
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


def _find_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def _duration(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(r.stdout.strip() or 0)
    except Exception:
        return 0.0


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=240)


# --- Health ---------------------------------------------------------------
@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "tss-ffmpeg-worker"})


# --- /extract-frame ------------------------------------------------------
@app.post("/extract-frame")
def extract_frame():
    if "video" not in request.files:
        return jsonify({"error": "video file required"}), 400

    tmp = tempfile.mkdtemp()
    try:
        inp = os.path.join(tmp, "in.mp4")
        out = os.path.join(tmp, "frame.jpg")
        request.files["video"].save(inp)

        # Preferred: seek from end of file.
        r = _run(["ffmpeg", "-y", "-sseof", "-0.05", "-i", inp,
                  "-frames:v", "1", "-q:v", "2", out])
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            # Fallback: probe duration and seek to (duration - 0.1).
            dur = _duration(inp)
            t = max(0.0, dur - 0.1)
            r = _run(["ffmpeg", "-y", "-ss", str(t), "-i", inp,
                      "-frames:v", "1", "-q:v", "2", out])
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            return jsonify({"error": "frame extraction failed",
                            "log": (r.stderr or "")[-2000:]}), 500

        return send_file(out, mimetype="image/jpeg",
                         download_name="scene1_last_frame.jpg")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --- /assemble -----------------------------------------------------------
def _build_drawtext(overlays, tmp):
    font = _find_font()
    if not font:
        return ""
    size_map = {"small": 32, "medium": 48, "large": 64}
    filters = []
    for i, o in enumerate(overlays or []):
        text = str(o.get("text", "") or "")
        if not text:
            continue
        tf = os.path.join(tmp, f"t{i}.txt")
        with open(tf, "w") as fh:
            fh.write(text)
        pos = str(o.get("position", "bottom-center"))
        if pos.startswith("top"):
            x, y = "(w-tw)/2", "40"
        elif pos == "center":
            x, y = "(w-tw)/2", "(h-th)/2"
        else:  # bottom-center (default)
            x, y = "(w-tw)/2", "h-th-40"
        fs = size_map.get(str(o.get("size", "medium")), 48)
        try:
            start = float(o.get("start", 0))
            end = float(o.get("end", 0))
        except Exception:
            start, end = 0.0, 0.0
        f = (
            f"drawtext=fontfile={font}:textfile={tf}:fontsize={fs}"
            f":fontcolor=white:bordercolor=black:borderw=3"
            f":x={x}:y={y}:enable='between(t,{start},{end})'"
        )
        filters.append(f)
    return ",".join(filters)


@app.post("/assemble")
def assemble():
    if "scene1" not in request.files:
        return jsonify({"error": "scene1 file required"}), 400

    try:
        parsed = json.loads(request.form.get("overlay", "[]") or "[]")
    except Exception:
        parsed = []
    # Accept either a bare array [...] or {"overlays": [...]}.
    overlays = parsed.get("overlays", []) if isinstance(parsed, dict) else parsed

    tmp = tempfile.mkdtemp()
    try:
        s1 = os.path.join(tmp, "scene1.mp4")
        s2 = os.path.join(tmp, "scene2.mp4")
        clean = os.path.join(tmp, "clean.mp4")
        final = os.path.join(tmp, "final.mp4")
        request.files["scene1"].save(s1)
        has_scene2 = "scene2" in request.files
        if has_scene2:
            request.files["scene2"].save(s2)

        # Pass 1: concatenate Scene 1 + Scene 2 (direct continuous cut, audio preserved).
        # Try stream-copy first (lossless, fast); fall back to re-encode if codecs differ.
        if has_scene2:
            listpath = os.path.join(tmp, "list.txt")
            with open(listpath, "w") as fh:
                fh.write(f"file '{s1}'\nfile '{s2}'\n")
            r = _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listpath,
                      "-c", "copy", clean])
            if r.returncode != 0 or not os.path.exists(clean):
                r = _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listpath,
                          "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                          "-c:a", "aac", "-b:a", "192k", clean])
                if r.returncode != 0 or not os.path.exists(clean):
                    return jsonify({"error": "concat failed",
                                    "log": (r.stderr or "")[-2000:]}), 500
        else:
            # 1-scene job: the clean video IS scene1 (no concat).
            shutil.copy(s1, clean)

        # Pass 2: burn overlay text AFTER concatenation (re-encode video, copy audio).
        vf = _build_drawtext(overlays, tmp)
        if vf:
            cmd = ["ffmpeg", "-y", "-i", clean, "-vf", vf,
                   "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                   "-c:a", "copy", final]
        else:
            cmd = ["ffmpeg", "-y", "-i", clean, "-c", "copy", final]
        r = _run(cmd)
        if r.returncode != 0 or not os.path.exists(final) or os.path.getsize(final) == 0:
            return jsonify({"error": "overlay/encode failed",
                            "log": (r.stderr or "")[-2000:]}), 500

        return send_file(final, mimetype="video/mp4", download_name="final_ugc.mp4")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
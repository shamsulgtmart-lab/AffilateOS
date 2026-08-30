FROM python:3.12-slim

# FFmpeg + fonts for FFmpeg drawtext overlay
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Render injects PORT at runtime; default 8080 for local runs.
ENV PORT=8080
EXPOSE 8080

# Shell form so ${PORT} is expanded when the container starts (Render sets PORT).
# 300s worker timeout suits video assembly; pick a Render plan that allows long requests.
CMD gunicorn -b 0.0.0.0:${PORT:-8080} --workers=2 --timeout=300 server:app
# Tools that generate the announcer sounds in src/client/public/sounds
# (generate.sh and make.sh here; src/client/public/sounds/README.md). The
# base image, Python packages and voice are pinned; ffmpeg and sox come from
# Debian bookworm (versions in the README).
FROM python:3.12.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    sox \
    curl \
    ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Piper TTS (GPL-3.0-or-later; the audio it makes is not covered by the GPL).
RUN pip install --no-cache-dir piper-tts==1.8.0 onnxruntime==1.30.0

# Voice "john" (en_US, medium, male): made by Bryce Beattie from public-domain
# LibriVox recordings, fine-tuned from his "kristin" voice (also LibriVox,
# trained from scratch); the piper-voices repo is MIT. Pinned to a repo
# commit and checked by sha256.
ARG VOICES_COMMIT=c10ece1aade47bb51c153c893d14e5bf8e5b7117
ARG VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_COMMIT}/en/en_US/john/medium
ARG VOICE_ONNX_SHA256=789c6c875726e627ddee93d51d8727859abe9c091c3d141591f4b83c2072e988
ARG VOICE_JSON_SHA256=af60f177b6b550f3d7a302720c0fb89e7f94a82b5dca464775ef63b1c69ba09a
ARG VOICE_CARD_SHA256=a056da65cd70dcbda96fc3420fe8d3442dbf3c8b75f49cdf800a715b42e299d1
WORKDIR /voice
RUN curl -fsSLo en_US-john-medium.onnx "$VOICE_URL/en_US-john-medium.onnx" \
    && curl -fsSLo en_US-john-medium.onnx.json "$VOICE_URL/en_US-john-medium.onnx.json" \
    && curl -fsSLo MODEL_CARD "$VOICE_URL/MODEL_CARD" \
    && printf '%s  %s\n' \
        "$VOICE_ONNX_SHA256" en_US-john-medium.onnx \
        "$VOICE_JSON_SHA256" en_US-john-medium.onnx.json \
        "$VOICE_CARD_SHA256" MODEL_CARD \
    | sha256sum -c -

WORKDIR /work

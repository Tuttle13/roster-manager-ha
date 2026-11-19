# Official Playwright image: Python + Chromium with all system libraries.
FROM mcr.microsoft.com/playwright/python:v1.65.2-noble

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data

RUN pip install --no-cache-dir --break-system-packages \
      playwright==1.65.2 aiohttp==3.14.5 cryptography

COPY app /app
WORKDIR /app

CMD ["python3", "-u", "/app/server.py"]

LABEL io.hass.type="addon" io.hass.version="0.3.1" io.hass.arch="amd64"

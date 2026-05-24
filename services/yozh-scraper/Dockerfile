FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/CyberYozh-data/yozh-scraper.git . \
    && pip install --no-cache-dir -r requirements.txt

RUN playwright install chromium --with-deps

ENV HOST=0.0.0.0
ENV PORT=8000
ENV WORKERS=2

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

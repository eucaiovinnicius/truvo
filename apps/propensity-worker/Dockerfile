FROM python:3.11.10-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt
COPY propensity_worker ./propensity_worker
RUN useradd --create-home --uid 10001 propensity
USER propensity
CMD ["python", "-m", "propensity_worker"]

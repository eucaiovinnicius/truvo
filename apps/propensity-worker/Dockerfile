FROM python:3.11.10-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
COPY apps/propensity-worker/requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt
COPY apps/propensity-worker/propensity_worker ./propensity_worker
RUN useradd --create-home --uid 10001 propensity
USER propensity
CMD ["python", "-m", "propensity_worker"]

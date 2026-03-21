# Base Dockerfile for all Python services in the TradeBot monorepo (development)

FROM python:3.12-slim

ARG SERVICE_NAME

# Install runtime utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /live

# Expose health check port (standard across all services)
EXPOSE 3000

ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}

# Prevent uv from writing to ~/.cache inside the container
ENV UV_NO_CACHE=1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

COPY --chown=root:root docker/python/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]

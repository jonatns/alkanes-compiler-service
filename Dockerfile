FROM rust:1.90-slim-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    ca-certificates \
    git \
    curl \
    clang \
    build-essential \
    protobuf-compiler \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install and configure sccache for faster Rust builds
RUN cargo install sccache
ENV RUSTC_WRAPPER=/usr/local/cargo/bin/sccache
ENV SCCACHE_DIR=/mnt/cache/sccache
ENV SCCACHE_CACHE_SIZE=10G

# Prebuild dummy project to warm up cache (optional)
WORKDIR /dummy
COPY dummy/Cargo.toml .
COPY dummy/src ./src
RUN rustup target add wasm32-unknown-unknown
RUN cargo build --release --target wasm32-unknown-unknown
RUN mkdir -p /mnt/cache/target && cp -r target /mnt/cache/target

# Main app
WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Environment
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV BUILDS_DIR=/tmp/builds

# Expose and mount cache
EXPOSE 8080
VOLUME ["/mnt/cache"]

# Start compiler service
CMD sccache --start-server && node dist/index.js

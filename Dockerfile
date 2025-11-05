FROM rust:1.90-slim-bookworm AS builder

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

RUN cargo install sccache
ENV RUSTC_WRAPPER=/usr/local/cargo/bin/sccache
ENV SCCACHE_DIR=/mnt/cache/sccache
ENV SCCACHE_CACHE_SIZE=10G

WORKDIR /dummy
COPY dummy/Cargo.toml .
COPY dummy/src ./src
RUN rustup target add wasm32-unknown-unknown
RUN cargo build --release --target wasm32-unknown-unknown

RUN mkdir -p /mnt/cache/target && cp -r target /mnt/cache/target

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ENV PATH="/usr/local/cargo/bin:${PATH}"

EXPOSE 8080

VOLUME ["/mnt/cache"]

ENV BUILDS_DIR=/tmp/builds

CMD sccache --start-server && node dist/index.js

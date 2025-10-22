FROM rust:1.90.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential clang llvm pkg-config protobuf-compiler \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH="${CARGO_HOME}/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]

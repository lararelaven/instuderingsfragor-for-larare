# Använd en officiell Node.js-basimage som inkluderar Python
FROM node:22-slim
# Eller en version som matchar din package.json engines.node om du har det, t.ex. node:22-slim

# Ställ in arbetskatalog
WORKDIR /usr/src/app

# Installera systemberoenden: Python, pip och ffmpeg
# 'slim'-versionen av Node-imagen har inte alltid allt, så vi installerar det vi behöver.
# apt-utils för att minska varningar, gnupg för att kunna lägga till nycklar (som för svtplay-dl:s repo)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    apt-utils \
    gnupg \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Installera svtplay-dl via pip (eller använd deras apt repo om du föredrar) [1]
RUN pip3 install --no-cache-dir svtplay-dl

# Kopiera package.json och package-lock.json (eller yarn.lock)
COPY package*.json./

# Installera Node.js-beroenden
# Om du använder npm ci, se till att package-lock.json är uppdaterad
RUN npm install --omit=dev
# Alternativt: npm ci --only=production

# Kopiera resten av applikationskoden
COPY..

# Exponera porten som appen körs på (Render kommer att mappa denna)
# PORT-miljövariabeln sätts automatiskt av Render till 10000, men din app lyssnar på process.env.PORT
EXPOSE ${PORT:-3000}

RUN which svtplay-dl
RUN ls -l /usr/local/bin/svtplay-dl

# Kommando för att starta appen
# Render använder Start Command från sina inställningar, men detta är bra som fallback/lokal Docker-körning
CMD [ "node", "server.js" ]
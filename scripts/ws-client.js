#!/usr/bin/env node

import net from 'net';
import crypto from 'crypto';

const host = process.env.WS_HOST || 'localhost';
const port = parseInt(process.env.WS_PORT || '8180', 10);
const url = `ws://${host}:${port}`;

let socket;
let isConnected = false;
let frameBuffer = Buffer.alloc(0);

function createKey() {
  return crypto.randomBytes(16).toString('base64');
}

function connect() {
  socket = net.createConnection(port, host, () => {
    const key = createKey();
    const request =
      `GET / HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    socket.write(request);
  });

  let headerDone = false;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    if (! headerDone) {
      buffer = Buffer.concat([buffer, chunk]);
      const str = buffer.toString();
      const pos = str.indexOf('\r\n\r\n');
      if (pos !== -1) {
        headerDone = true;
        isConnected = true;
        console.log(`✓ Connected to ${url}\n`);
        console.log('Commands:');
        console.log('  sub <table> [symbol]  - Subscribe (e.g., "sub instrument XBTUSD")');
        console.log('  unsub <table> [symbol] - Unsubscribe');
        console.log('  ping                   - Send ping');
        console.log('  exit                   - Disconnect\n');

        // Process any data after headers
        const rest = buffer.slice(pos + 4);
        if (rest.length > 0) {
          frameBuffer = Buffer.concat([frameBuffer, rest]);
          processFrames();
        }
        return;
      }
    } else {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      processFrames();
    }
  });

  socket.on('error', (err) => {
    console.error(`✗ Connection error: ${err.message}`);
    process.exit(1);
  });

  socket.on('close', () => {
    console.log('\n✗ Disconnected');
    process.exit(0);
  });
}

function processFrames() {
  while (frameBuffer.length >= 2) {
    const byte0 = frameBuffer[0];
    const byte1 = frameBuffer[1];

    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let len = byte1 & 0x7f;

    let headerLen = 2;
    if (len === 126) {
      if (frameBuffer.length < 4) return;
      len = frameBuffer.readUInt16BE(2);
      headerLen = 4;
    } else if (len === 127) {
      if (frameBuffer.length < 10) return;
      const hi = frameBuffer.readUInt32BE(2);
      const lo = frameBuffer.readUInt32BE(6);
      len = hi * 0x100000000 + lo;
      headerLen = 10;
    }

    if (masked) headerLen += 4;

    if (frameBuffer.length < headerLen + len) return;

    let payload = frameBuffer.slice(headerLen, headerLen + len);

    if (masked) {
      const maskKey = frameBuffer.slice(headerLen - 4, headerLen);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    if (opcode === 1) { // Text
      console.log('←', payload.toString('utf8'));
    } else if (opcode === 2) { // Binary
      console.log('← [binary]');
    } else if (opcode === 8) { // Close
      console.log('← [close]');
      socket.destroy();
    } else if (opcode === 9) { // Ping
      sendPong();
    }

    frameBuffer = frameBuffer.slice(headerLen + len);
  }
}

function sendMessage(text) {
  if (! isConnected) {
    console.log('? Not connected');
    return;
  }

  const data = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);

  let len = data.length;
  let headerLen = 2;
  if (len > 65535) {
    headerLen = 10;
  } else if (len > 125) {
    headerLen = 4;
  }

  const frame = Buffer.alloc(headerLen + 4 + len);
  frame[0] = 0x81; // FIN + Text

  let pos = 1;
  if (len <= 125) {
    frame[pos++] = 0x80 | len;
  } else if (len <= 65535) {
    frame[pos++] = 0xfe;
    frame.writeUInt16BE(len, pos);
    pos += 2;
  } else {
    frame[pos++] = 0xff;
    frame.writeUInt32BE(0, pos);
    pos += 4;
    frame.writeUInt32BE(len, pos);
    pos += 4;
  }

  mask.copy(frame, pos);
  pos += 4;

  for (let i = 0; i < len; i++) {
    frame[pos + i] = data[i] ^ mask[i % 4];
  }

  socket.write(frame);
  console.log('→', text);
}

function sendPong() {
  const frame = Buffer.alloc(2);
  frame[0] = 0x8a; // FIN + Pong
  frame[1] = 0x80; // MASK, len=0
  frame.writeUInt32BE(0, 2);
  socket.write(frame);
}

connect();

process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    const input = chunk.trim();
    if (! input) continue;

    if (input === 'exit') {
      socket.destroy();
      process.exit(0);
    }

    if (input === 'ping') {
      sendMessage('ping');
      continue;
    }

    const [cmd, ...args] = input.split(/\s+/);

    if (cmd === 'sub' && args.length >= 1) {
      const table = args[0];
      const symbol = args[1] || '';
      const msg = JSON.stringify({ op: 'subscribe', args: [symbol ? `${table}:${symbol}` : table] });
      sendMessage(msg);
      continue;
    }

    if (cmd === 'unsub' && args.length >= 1) {
      const table = args[0];
      const symbol = args[1] || '';
      const msg = JSON.stringify({ op: 'unsubscribe', args: [symbol ? `${table}:${symbol}` : table] });
      sendMessage(msg);
      continue;
    }

    console.log('? Unknown command');
  }
});

process.stdin.on('end', () => {
  socket.destroy();
  process.exit(0);
});

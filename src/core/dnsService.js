import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

const DEFAULT_HOSTNAME = "api.aibipocket.com";
const DEFAULT_PORT = 53;
const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_UPSTREAM = "1.1.1.1";

export class DnsService {
  constructor({ emit }) {
    this.emit = emit;
    this.udpServer = null;
    this.tcpServer = null;
    this.bound = null;
    this.lastAnswerEventAt = new Map();
  }

  async start() {
    if (this.udpServer || this.tcpServer) return { running: true, ...this.bound };

    const advertisedAddress = await detectLanAddress();
    if (!advertisedAddress) {
      throw new Error("DNS server could not find a LAN IPv4 address.");
    }

    const bindAddress = advertisedAddress;
    const port = DEFAULT_PORT;
    const hostname = DEFAULT_HOSTNAME;
    const upstream = parseUpstream(DEFAULT_UPSTREAM);

    const udpServer = dgram.createSocket({ type: "udp4", reuseAddr: true });
    udpServer.on("message", (message, remote) => {
      this.handleUdpMessage({ message, remote, hostname, advertisedAddress, upstream });
    });
    udpServer.on("error", (error) => {
      this.emit({
        type: "warning",
        title: "DNS server error",
        detail: error.message,
        payload: { code: error.code, message: error.message },
      });
    });

    await bindUdp(udpServer, port, bindAddress);
    this.udpServer = udpServer;

    const tcpServer = net.createServer((socket) => {
      this.handleTcpSocket({ socket, hostname, advertisedAddress, upstream });
    });
    tcpServer.on("error", (error) => {
      this.emit({
        type: "warning",
        title: "DNS TCP server error",
        detail: error.message,
        payload: { code: error.code, message: error.message },
      });
    });

    try {
      await listenTcp(tcpServer, port, bindAddress);
      this.tcpServer = tcpServer;
    } catch (error) {
      tcpServer.close();
      this.emit({
        type: "warning",
        title: "DNS TCP listener skipped",
        detail: error.message,
        payload: { code: error.code, message: error.message, bindAddress, port },
      });
    }

    this.bound = { bindAddress, port, hostname, address: advertisedAddress, upstream: `${upstream.host}:${upstream.port}` };
    this.emit({
      type: "mode",
      title: "DNS server active",
      detail: `${hostname} -> ${advertisedAddress} on ${bindAddress}:${port}`,
      payload: this.bound,
    });

    return { running: true, ...this.bound };
  }

  async stop() {
    await Promise.all([
      closeUdp(this.udpServer),
      closeTcp(this.tcpServer),
    ]);
    this.udpServer = null;
    this.tcpServer = null;
    this.bound = null;
    this.lastAnswerEventAt.clear();
    return { running: false };
  }

  async handleUdpMessage({ message, remote, hostname, advertisedAddress, upstream }) {
    try {
      const localResponse = buildLocalResponse(message, hostname, advertisedAddress);
      if (localResponse) {
        this.udpServer?.send(localResponse, remote.port, remote.address);
        this.emitAnswerEvent(message, hostname, advertisedAddress, remote);
        return;
      }

      const upstreamResponse = await forwardUdp(message, upstream);
      this.udpServer?.send(upstreamResponse, remote.port, remote.address);
    } catch (error) {
      const response = buildErrorResponse(message, 2);
      if (response) this.udpServer?.send(response, remote.port, remote.address);
      this.emit({
        type: "warning",
        title: "DNS query failed",
        detail: error.message,
        payload: { remote: `${remote.address}:${remote.port}`, message: error.message },
      });
    }
  }

  handleTcpSocket({ socket, hostname, advertisedAddress, upstream }) {
    let buffer = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const length = buffer.readUInt16BE(0);
        if (buffer.length < length + 2) return;
        const message = buffer.subarray(2, length + 2);
        buffer = buffer.subarray(length + 2);

        try {
          const response = buildLocalResponse(message, hostname, advertisedAddress) || await forwardUdp(message, upstream);
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length, 0);
          socket.write(Buffer.concat([prefix, response]));
          if (matchesHostname(parseQuestion(message)?.name, hostname)) {
            this.emitAnswerEvent(message, hostname, advertisedAddress, {
              address: socket.remoteAddress,
              port: socket.remotePort,
              protocol: "tcp",
            });
          }
        } catch (error) {
          const response = buildErrorResponse(message, 2);
          if (response) {
            const prefix = Buffer.alloc(2);
            prefix.writeUInt16BE(response.length, 0);
            socket.write(Buffer.concat([prefix, response]));
          }
          this.emit({
            type: "warning",
            title: "DNS TCP query failed",
            detail: error.message,
            payload: { remote: `${socket.remoteAddress}:${socket.remotePort}`, message: error.message },
          });
        }
      }
    });
  }

  emitAnswerEvent(message, hostname, advertisedAddress, remote) {
    const question = parseQuestion(message);
    if (!matchesHostname(question?.name, hostname)) return;

    const now = Date.now();
    const key = `${question.name}:${remote.address}`;
    if (now - (this.lastAnswerEventAt.get(key) || 0) < 15000) return;
    this.lastAnswerEventAt.set(key, now);

    this.emit({
      type: "robot_status",
      title: "DNS answered",
      detail: `${question.name} -> ${advertisedAddress}`,
      payload: {
        hostname: question.name,
        address: advertisedAddress,
        remote: `${remote.address}:${remote.port}`,
        queryType: question.type,
      },
    });
  }
}

function buildLocalResponse(query, hostname, address) {
  const question = parseQuestion(query);
  if (!question || !matchesHostname(question.name, hostname)) return null;

  const answerCount = question.type === 1 && question.classCode === 1 ? 1 : 0;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(question.id, 0);
  header.writeUInt16BE(0x8000 | (question.flags & 0x0100) | 0x0400 | 0x0080, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerCount, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const questionBytes = query.subarray(12, question.endOffset);
  if (!answerCount) return Buffer.concat([header, questionBytes]);

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(DEFAULT_TTL_SECONDS, 6);
  answer.writeUInt16BE(4, 10);
  writeIPv4(answer, address, 12);
  return Buffer.concat([header, questionBytes, answer]);
}

function buildErrorResponse(query, rcode) {
  if (query.length < 12) return null;
  const header = Buffer.from(query.subarray(0, 12));
  const flags = query.readUInt16BE(2);
  header.writeUInt16BE(0x8000 | (flags & 0x0100) | 0x0080 | (rcode & 0x0f), 2);
  header.writeUInt16BE(query.readUInt16BE(4), 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, query.subarray(12)]);
}

function parseQuestion(message) {
  if (!Buffer.isBuffer(message) || message.length < 17) return null;
  const questionCount = message.readUInt16BE(4);
  if (questionCount < 1) return null;

  let offset = 12;
  const labels = [];
  while (offset < message.length) {
    const length = message[offset];
    if ((length & 0xc0) !== 0) return null;
    offset += 1;
    if (length === 0) break;
    if (offset + length > message.length) return null;
    labels.push(message.subarray(offset, offset + length).toString("ascii"));
    offset += length;
  }

  if (offset + 4 > message.length || !labels.length) return null;
  return {
    id: message.readUInt16BE(0),
    flags: message.readUInt16BE(2),
    name: normalizeHostname(labels.join(".")),
    type: message.readUInt16BE(offset),
    classCode: message.readUInt16BE(offset + 2),
    endOffset: offset + 4,
  };
}

function matchesHostname(name, hostname) {
  if (!name) return false;
  return name === hostname || name.endsWith(`.${hostname}`);
}

function writeIPv4(buffer, address, offset) {
  const parts = String(address).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address for DNS response: ${address}`);
  }
  for (let index = 0; index < 4; index += 1) buffer[offset + index] = parts[index];
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().replace(/\.$/, "").toLowerCase();
}

function parseUpstream(value) {
  const [host, port] = String(value || DEFAULT_UPSTREAM).split(":");
  return { host: host || DEFAULT_UPSTREAM, port: Number(port || DEFAULT_PORT) };
}

function bindUdp(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.bind(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function listenTcp(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeUdp(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function closeTcp(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function forwardUdp(message, upstream, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`DNS upstream timed out: ${upstream.host}:${upstream.port}`));
    }, timeoutMs);

    socket.on("message", (response) => {
      clearTimeout(timeout);
      socket.close();
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
    socket.send(message, upstream.port, upstream.host);
  });
}

async function detectLanAddress() {
  const outbound = await detectOutboundAddress();
  if (outbound) return outbound;
  return getInterfaceAddresses().sort((a, b) => b.score - a.score)[0]?.address || "";
}

function detectOutboundAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const done = (address = "") => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(address);
    };

    socket.once("error", () => done(""));
    socket.connect(DEFAULT_PORT, DEFAULT_UPSTREAM, () => {
      const address = socket.address()?.address || "";
      done(isUsableIPv4(address) ? address : "");
    });
  });
}

function getInterfaceAddresses() {
  const rows = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isUsableIPv4(entry.address)) continue;
      rows.push({ name, address: entry.address, score: scoreInterface(name, entry.address) });
    }
  }
  return rows;
}

function isUsableIPv4(address) {
  return net.isIPv4(address) && !address.startsWith("127.") && !address.startsWith("169.254.");
}

function scoreInterface(name, address) {
  const lowerName = String(name).toLowerCase();
  let score = 0;
  if (lowerName.includes("wi-fi") || lowerName.includes("wifi") || lowerName.includes("wlan")) score += 30;
  if (lowerName.includes("ethernet")) score += 20;
  if (address.startsWith("192.168.")) score += 10;
  if (address.startsWith("10.")) score += 8;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 6;
  if (/(vethernet|virtual|vmware|virtualbox|docker|wsl|hyper-v|loopback)/i.test(name)) score -= 50;
  return score;
}

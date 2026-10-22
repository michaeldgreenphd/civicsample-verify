import crypto from 'node:crypto';
import net from 'node:net';

export interface PgConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

export function parsePgConnectionUrl(rawUrl: string): PgConnectionConfig {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Unsupported PostgreSQL protocol: ${parsed.protocol}`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database,
  };
}

interface FieldDesc {
  name: string;
  typeOid: number;
}

function decodeField(raw: string | null, typeOid: number): unknown {
  if (raw === null) return null;
  switch (typeOid) {
    case 16: // BOOLOID
      return raw === 't' || raw === 'true';
    case 20: // INT8OID
    case 21: // INT2OID
    case 23: // INT4OID
      return Number(raw);
    case 114: // JSONOID
    case 3802: // JSONBOID
      return JSON.parse(raw);
    case 1009: // TEXTARRAYOID
    case 2951: // UUIDARRAYOID
      if (raw === '{}') return [];
      return raw
        .slice(1, -1)
        .split(',')
        .map((item) =>
          item.startsWith('"') && item.endsWith('"')
            ? item.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
            : item,
        );
    default:
      return raw;
  }
}

function encodeParam(param: unknown): Buffer | null {
  if (param === null || param === undefined) return null;
  if (Array.isArray(param)) {
    const escaped = param.map(
      (item) => '"' + String(item).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"',
    );
    return Buffer.from(`{${escaped.join(',')}}`, 'utf8');
  }
  if (typeof param === 'boolean') {
    return Buffer.from(param ? 'true' : 'false', 'utf8');
  }
  if (typeof param === 'object') {
    return Buffer.from(JSON.stringify(param), 'utf8');
  }
  return Buffer.from(String(param), 'utf8');
}

function cstr(value: string): Buffer {
  return Buffer.from(value + '\0', 'utf8');
}

function frameMessage(type: string | null, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4, 0);
  if (type === null) {
    return Buffer.concat([len, body]);
  }
  return Buffer.concat([Buffer.from(type, 'ascii'), len, body]);
}

function parseErrorFields(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const code = payload[offset++];
    if (code === 0) break;
    const end = payload.indexOf(0, offset);
    if (end === -1) break;
    fields[String.fromCharCode(code)] = payload.subarray(offset, end).toString('utf8');
    offset = end + 1;
  }
  return fields;
}

function createPgError(fields: Record<string, string>): Error & { code?: string; detail?: string } {
  const msg = fields.M || 'PostgreSQL error';
  const detail = fields.D ? ` (${fields.D})` : '';
  const err = new Error(`error: ${msg}${detail}`) as Error & { code?: string; detail?: string };
  err.code = fields.C;
  err.detail = fields.D;
  return err;
}

/**
 * Minimal zero-dependency PostgreSQL v3 wire-protocol client over `node:net`.
 * Supports multiple independent TCP connections for true lock/isolation concurrency tests.
 */
export class PgWireConnection {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  private waiters: Array<(msg: { type: string; payload: Buffer }) => void> = [];
  private inbox: Array<{ type: string; payload: Buffer }> = [];
  private closedError: Error | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  public backendPid = 0;

  static async connect(urlOrConfig: string | PgConnectionConfig): Promise<PgWireConnection> {
    const config =
      typeof urlOrConfig === 'string' ? parsePgConnectionUrl(urlOrConfig) : urlOrConfig;
    const conn = new PgWireConnection();
    await conn.open(config);
    return conn;
  }

  private async open(config: PgConnectionConfig): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: config.host, port: config.port }, () => resolve());
      sock.setNoDelay(true);
      sock.once('error', reject);
      this.socket = sock;
    });

    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames();
    });
    this.socket.on('error', (err: Error) => {
      this.failAll(err);
    });
    this.socket.on('close', () => {
      this.failAll(new Error('PostgreSQL connection closed'));
    });

    // StartupMessage (protocol 3.0 = 196608)
    const proto = Buffer.alloc(4);
    proto.writeInt32BE(196608, 0);
    const startupBody = Buffer.concat([
      proto,
      cstr('user'),
      cstr(config.user),
      cstr('database'),
      cstr(config.database),
      cstr('client_encoding'),
      cstr('UTF8'),
      Buffer.from([0]),
    ]);
    this.socket.write(frameMessage(null, startupBody));

    let scramState: {
      clientNonce: string;
      clientFirstBare: string;
      saltedPassword?: Buffer;
      authMessage?: string;
    } | null = null;

    while (true) {
      const msg = await this.nextMessage();
      if (msg.type === 'E') {
        throw createPgError(parseErrorFields(msg.payload));
      }
      if (msg.type === 'R') {
        const authCode = msg.payload.readInt32BE(0);
        if (authCode === 0) {
          continue; // AuthenticationOk
        } else if (authCode === 3) {
          // AuthenticationCleartextPassword
          const pw = config.password ?? '';
          this.socket.write(frameMessage('p', cstr(pw)));
        } else if (authCode === 5) {
          // AuthenticationMD5Password
          const salt = msg.payload.subarray(4, 8);
          const pw = config.password ?? '';
          const inner = crypto
            .createHash('md5')
            .update(pw + config.user, 'utf8')
            .digest('hex');
          const outer = crypto
            .createHash('md5')
            .update(Buffer.concat([Buffer.from(inner, 'ascii'), salt]))
            .digest('hex');
          this.socket.write(frameMessage('p', cstr('md5' + outer)));
        } else if (authCode === 10) {
          // AuthenticationSASL (SCRAM-SHA-256)
          const clientNonce = crypto.randomBytes(18).toString('base64');
          const clientFirstBare = `n=,r=${clientNonce}`;
          const clientFirstMsg = `n,,${clientFirstBare}`;
          const mech = cstr('SCRAM-SHA-256');
          const initialLen = Buffer.alloc(4);
          const initialBuf = Buffer.from(clientFirstMsg, 'utf8');
          initialLen.writeInt32BE(initialBuf.length, 0);
          scramState = { clientNonce, clientFirstBare };
          this.socket.write(frameMessage('p', Buffer.concat([mech, initialLen, initialBuf])));
        } else if (authCode === 11) {
          // AuthenticationSASLContinue
          if (!scramState) throw new Error('Unexpected SASLContinue message');
          const serverFirst = msg.payload.subarray(4).toString('utf8');
          const parts = Object.fromEntries(
            serverFirst.split(',').map((kv) => [kv.slice(0, 1), kv.slice(2)]),
          );
          const nonce = parts.r;
          const salt = Buffer.from(parts.s, 'base64');
          const iterations = Number(parts.i);
          if (!nonce || !nonce.startsWith(scramState.clientNonce)) {
            throw new Error('SCRAM server nonce mismatch');
          }
          const saltedPassword = crypto.pbkdf2Sync(
            config.password ?? '',
            salt,
            iterations,
            32,
            'sha256',
          );
          const clientKey = crypto
            .createHmac('sha256', saltedPassword)
            .update('Client Key')
            .digest();
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const clientFinalWithoutProof = `c=biws,r=${nonce}`;
          const authMessage = `${scramState.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
          const clientSignature = crypto
            .createHmac('sha256', storedKey)
            .update(authMessage)
            .digest();
          const clientProof = Buffer.alloc(clientKey.length);
          for (let i = 0; i < clientKey.length; i++) {
            clientProof[i] = clientKey[i] ^ clientSignature[i];
          }
          scramState.saltedPassword = saltedPassword;
          scramState.authMessage = authMessage;
          const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`;
          this.socket.write(frameMessage('p', Buffer.from(clientFinal, 'utf8')));
        } else if (authCode === 12) {
          // AuthenticationSASLFinal
          if (!scramState?.saltedPassword || !scramState.authMessage) {
            throw new Error('Unexpected SASLFinal message');
          }
          const serverKey = crypto
            .createHmac('sha256', scramState.saltedPassword)
            .update('Server Key')
            .digest();
          const expectedServerSig = crypto
            .createHmac('sha256', serverKey)
            .update(scramState.authMessage)
            .digest('base64');
          const serverFinal = msg.payload.subarray(4).toString('utf8');
          if (!serverFinal.includes(`v=${expectedServerSig}`)) {
            throw new Error('SCRAM server signature verification failed');
          }
        } else {
          throw new Error(`Unsupported PostgreSQL authentication code: ${authCode}`);
        }
      } else if (msg.type === 'K') {
        this.backendPid = msg.payload.readInt32BE(0);
      } else if (msg.type === 'Z') {
        break; // ReadyForQuery
      }
    }
  }

  private drainFrames(): void {
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + length) break;
      const payload = this.buffer.subarray(5, 1 + length);
      this.buffer = this.buffer.subarray(1 + length);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ type, payload });
      } else {
        this.inbox.push({ type, payload });
      }
    }
  }

  private failAll(err: Error): void {
    if (!this.closedError) this.closedError = err;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ type: '!', payload: Buffer.from(err.message, 'utf8') });
    }
  }

  private nextMessage(): Promise<{ type: string; payload: Buffer }> {
    if (this.inbox.length > 0) {
      return Promise.resolve(this.inbox.shift()!);
    }
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push((msg) => {
        if (msg.type === '!') reject(this.closedError ?? new Error(msg.payload.toString('utf8')));
        else resolve(msg);
      });
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async exec(sql: string): Promise<void> {
    return this.enqueue(async () => {
      this.socket.write(frameMessage('Q', cstr(sql)));
      let firstError: Error | null = null;
      while (true) {
        const msg = await this.nextMessage();
        if (msg.type === 'E' && !firstError) {
          firstError = createPgError(parseErrorFields(msg.payload));
        } else if (msg.type === 'Z') {
          break;
        }
      }
      if (firstError) throw firstError;
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return this.enqueue(async () => {
      // Parse ('P')
      const parseBody = Buffer.concat([cstr(''), cstr(sql), Buffer.from([0, 0])]);
      // Bind ('B')
      const paramCountBuf = Buffer.alloc(2);
      paramCountBuf.writeInt16BE(params.length, 0);
      const paramParts: Buffer[] = [];
      for (const param of params) {
        const encoded = encodeParam(param);
        if (encoded === null) {
          const nullLen = Buffer.alloc(4);
          nullLen.writeInt32BE(-1, 0);
          paramParts.push(nullLen);
        } else {
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeInt32BE(encoded.length, 0);
          paramParts.push(lenBuf, encoded);
        }
      }
      const bindBody = Buffer.concat([
        cstr(''),
        cstr(''),
        Buffer.from([0, 0]), // 0 parameter format codes -> all text
        paramCountBuf,
        ...paramParts,
        Buffer.from([0, 0]), // 0 result format codes -> all text
      ]);
      // Describe ('D') portal ''
      const descBody = Buffer.concat([Buffer.from('P', 'ascii'), cstr('')]);
      // Execute ('E') portal '', unlimited rows
      const execBody = Buffer.concat([cstr(''), Buffer.from([0, 0, 0, 0])]);
      // Sync ('S')
      const syncMsg = frameMessage('S', Buffer.alloc(0));

      this.socket.write(
        Buffer.concat([
          frameMessage('P', parseBody),
          frameMessage('B', bindBody),
          frameMessage('D', descBody),
          frameMessage('E', execBody),
          syncMsg,
        ]),
      );

      let fields: FieldDesc[] = [];
      const rows: T[] = [];
      let firstError: Error | null = null;

      while (true) {
        const msg = await this.nextMessage();
        if (msg.type === 'T') {
          const count = msg.payload.readInt16BE(0);
          let offset = 2;
          fields = [];
          for (let i = 0; i < count; i++) {
            const nameEnd = msg.payload.indexOf(0, offset);
            const name = msg.payload.subarray(offset, nameEnd).toString('utf8');
            offset = nameEnd + 1;
            const typeOid = msg.payload.readInt32BE(offset + 6);
            offset += 18;
            fields.push({ name, typeOid });
          }
        } else if (msg.type === 'D') {
          const count = msg.payload.readInt16BE(0);
          let offset = 2;
          const row: Record<string, unknown> = {};
          for (let i = 0; i < count; i++) {
            const len = msg.payload.readInt32BE(offset);
            offset += 4;
            if (len === -1) {
              row[fields[i].name] = null;
            } else {
              const raw = msg.payload.subarray(offset, offset + len).toString('utf8');
              offset += len;
              row[fields[i].name] = decodeField(raw, fields[i].typeOid);
            }
          }
          rows.push(row as T);
        } else if (msg.type === 'E' && !firstError) {
          firstError = createPgError(parseErrorFields(msg.payload));
        } else if (msg.type === 'Z') {
          break;
        }
      }

      if (firstError) throw firstError;
      return { rows };
    });
  }

  async transaction<T>(fn: (tx: PgWireConnection) => Promise<T>): Promise<T> {
    await this.exec('begin');
    try {
      const result = await fn(this);
      await this.exec('commit');
      return result;
    } catch (error) {
      try {
        await this.exec('rollback');
      } catch {
        // ignore rollback error if connection dropped
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.socket || this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.write(frameMessage('X', Buffer.alloc(0)));
      this.socket.end();
    });
  }
}

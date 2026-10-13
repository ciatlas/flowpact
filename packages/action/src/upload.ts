/**
 * Uploads the contract drift artifact the way @actions/artifact 6.3.1 does (its lib/internal/upload), without its
 * 94 packages: CreateArtifact at the runner's artifact service, the zip to the signed blob URL it returns (Put Block,
 * Put Block List), then FinalizeArtifact with the zip's size and SHA-256. It needs only the runner's
 * ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL, never a GitHub token. Requests go through @actions/http-client, which
 * honors the runner's proxy settings. The artifact holds a few small text files, so the zip is built in memory.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';
import * as core from '@actions/core';
import { HttpClient } from '@actions/http-client';
import { BearerCredentialHandler } from '@actions/http-client/lib/auth';

const SERVICE = 'github.actions.results.api.v1.ArtifactService';
const USER_AGENT = 'flowpact-action';
/** The Blob service version @actions/artifact's blob client (@azure/storage-blob 12.34) sends. */
const BLOB_VERSION = '2026-10-06';
/** The library streams the zip to blob storage in blocks of this size. */
const BLOCK_SIZE = 8 * 1024 * 1024;
/** Characters the library refuses in the paths of the files (for NTFS), and in the name, where / and \ also are. */
const BAD_PATH = /[":<>|*?\r\n]/;
const BAD_NAME = /[":<>|*?\r\n\\/]/;

/** Waits between retries; tests replace it. */
export const retryWait = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

/** The library's GHES check: artifact uploads from actions work on github.com and GHE.com, not on Enterprise Server. */
function isGhes(): boolean {
  const host = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com').hostname
    .trimEnd()
    .toUpperCase();
  return host !== 'GITHUB.COM' && !host.endsWith('.GHE.COM') && !host.endsWith('.LOCALHOST');
}

/** The run and job ids the service wants, from the `Actions.Results:<run>:<job>` scope of the runtime token (a JWT). */
function backendIds(token: string): { workflow_run_backend_id: string; workflow_job_run_backend_id: string } {
  let scp: unknown;
  try {
    scp = (
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { scp?: unknown }
    ).scp;
  } catch {
    // The parse error would quote the token.
  }
  for (const scope of typeof scp === 'string' ? scp.split(' ') : []) {
    const parts = scope.split(':');
    if (parts[0] !== 'Actions.Results') continue;
    if (parts.length !== 3) break;
    return { workflow_run_backend_id: parts[1]!, workflow_job_run_backend_id: parts[2]! };
  }
  throw new Error('The ACTIONS_RUNTIME_TOKEN has no Actions.Results scope');
}

/** Registers the signature of a signed URL as a secret, raw and URL-encoded, so no log line can show it. */
function maskSignature(url: string): string[] {
  let sig: string | null = null;
  try {
    sig = new URL(url).searchParams.get('sig');
  } catch {}
  if (!sig) return [];
  const secrets = [...new Set([sig, encodeURIComponent(sig)])];
  for (const s of secrets) core.setSecret(s);
  return secrets;
}

/** Expiry for `retentionDays`, capped at the repository's maximum (the runner's GITHUB_RETENTION_DAYS). */
function expiresAt(retentionDays: number | undefined): string | undefined {
  if (!retentionDays) return undefined;
  const max = Number.parseInt(process.env.GITHUB_RETENTION_DAYS ?? '', 10);
  if (max && max < retentionDays) {
    core.warning(
      `Retention days cannot be greater than the maximum allowed retention set within the repository. Using ${max} instead.`,
    );
    retentionDays = max;
  }
  const date = new Date();
  date.setDate(date.getDate() + retentionDays);
  // A protobuf Timestamp in JSON: no fraction when the milliseconds are zero.
  return date.toISOString().replace('.000Z', 'Z');
}

/** Status codes the library retries, with its policy: 5 attempts, 8 s growing by 1.5x with jitter, 2 minutes at most. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/** Errors the library does not retry: the service is out of reach. */
const UNREACHABLE = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH']);

/** A twirp failure that is not retried. */
class Final extends Error {}

/** A twirp request that did not succeed: why, and how long the service asked to wait before the next attempt. */
interface TwirpFailure {
  failure: string;
  delay: number | undefined;
}

/** The wait a 429 reply asks for in its Retry-After header (whole seconds), in ms. */
function retryAfterDelay(status: number, header: string | string[] | undefined): number | undefined {
  const retryAfter = String(header ?? '').trim();
  return status === 429 && /^\d+$/.test(retryAfter) && Number(retryAfter) > 0
    ? Number(retryAfter) * 1000
    : undefined;
}

/** Why the service refused a request; throws when that is not retried (quota hit, or a status not retried). */
function replyFailure(
  method: string,
  status: number,
  statusMessage: string | undefined,
  reply: { msg?: string },
) {
  if (reply.msg?.includes('insufficient usage'))
    throw new Final('Artifact storage quota has been hit. Unable to upload any new artifacts');
  const failure = `(${status}) ${statusMessage}${reply.msg ? `: ${reply.msg}` : ''}`;
  if (!RETRY_STATUS.has(status)) throw new Final(`Failed to ${method}: ${failure}`);
  return failure;
}

/** Why a request got no reply, or one that is not JSON: retried, unless the service is out of reach. */
function requestFailure(method: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code && UNREACHABLE.has(code)) throw new Error(`Failed to ${method}: unable to make request: ${code}`);
  return (err as Error).message;
}

/** One twirp request: the reply, or a failure to retry; throws when it is not retried. */
async function twirpAttempt<T>(
  http: HttpClient,
  url: string,
  method: string,
  body: object,
): Promise<{ reply: T } | TwirpFailure> {
  let delay: number | undefined;
  try {
    const res = await http.post(url, JSON.stringify(body), { 'Content-Type': 'application/json' });
    const status = res.message.statusCode ?? 0;
    delay = retryAfterDelay(status, res.message.headers['retry-after']);
    const reply = JSON.parse(await res.readBody()) as T & { msg?: string };
    if (status >= 200 && status < 300) return { reply };
    return { failure: replyFailure(method, status, res.message.statusMessage, reply), delay };
  } catch (err) {
    if (err instanceof Final) throw err;
    return { failure: requestFailure(method, err), delay };
  }
}

/** The library's wait before attempt `attempt + 1`: 8 s, growing by 1.5x, with jitter after the first. */
function backoff(attempt: number): number {
  const min = 8000 * 1.5 ** (attempt - 1);
  return attempt === 1 ? min : Math.trunc(min + Math.random() * min * 0.5);
}

async function twirp<T>(http: HttpClient, base: string, method: string, body: object): Promise<T> {
  const url = new URL(`/twirp/${SERVICE}/${method}`, base).href;
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const outcome = await twirpAttempt<T>(http, url, method, body);
    if ('reply' in outcome) return outcome.reply;
    const { failure } = outcome;
    if (attempt === 5) throw new Error(`Failed to ${method} after 5 attempts: ${failure}`);
    const delay = outcome.delay ?? backoff(attempt);
    if (waited + delay > 120_000) throw new Error(`Failed to ${method}: ${failure}`);
    core.info(`${method} attempt ${attempt} of 5 failed: ${failure}. Retrying in ${delay} ms`);
    await retryWait.sleep(delay);
    waited += delay;
  }
}

/** Errors the blob client retries (as @azure/storage-blob's retry policy does), besides status 500 and 503. */
const BLOB_RETRY_ERRORS = [
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'ENOTFOUND',
  'TIMEOUT',
  'EPIPE',
  'REQUEST_SEND_ERROR',
];

/**
 * How long a blob request may go without progress before the upload stops (the library's
 * ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS, 5 minutes by default). A stalled upload is not retried, as in the library.
 */
const stallTimeout = () =>
  Number.parseInt(process.env.ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS ?? '', 10) || 300_000;

/** A blob request that did not succeed: why, and whether the Azure client would try again. */
interface BlobFailure {
  failure: string;
  retryable: boolean;
}

/** Why a blob request threw: a stalled upload (not retried), or an error the Azure client retries or not. */
function blobError(e: NodeJS.ErrnoException, redact: (s: string) => string): BlobFailure {
  // http-client's socket timeout: "Request timeout: <path and the signed query>".
  const stalled = e.message.startsWith('Request timeout');
  const failure = stalled
    ? `upload stalled: no progress in ${stallTimeout()} ms (${redact(e.message)})`
    : redact(e.message);
  const retryable =
    !stalled && BLOB_RETRY_ERRORS.some((c) => e.code === c || e.message.toUpperCase().includes(c));
  return { failure, retryable };
}

/** One try of a blob request: nothing when the blob service accepted it, else why not. */
async function blobAttempt(
  http: HttpClient,
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  redact: (s: string) => string,
): Promise<BlobFailure | undefined> {
  try {
    const res = await http.request('PUT', url, Readable.from([body]), {
      ...headers,
      'Content-Length': String(body.length),
      'x-ms-version': BLOB_VERSION,
      'x-ms-client-request-id': randomUUID(),
      Accept: 'application/xml',
    });
    const reply = await res.readBody();
    const status = res.message.statusCode ?? 0;
    if (status === 201) return undefined;
    const code = /<Code>([^<]*)<\/Code>/.exec(reply)?.[1];
    return {
      failure: `(${status}) ${code ?? res.message.statusMessage}`,
      retryable: status === 500 || status === 503,
    };
  } catch (err) {
    return blobError(err as NodeJS.ErrnoException, redact);
  }
}

/** One request to the signed blob URL; 4 tries, waiting 0, 4 and 12 seconds, like the Azure client. */
async function blobRequest(
  http: HttpClient,
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  what: string,
  secrets: string[],
): Promise<void> {
  const redact = (s: string) => secrets.reduce((out, secret) => out.replaceAll(secret, '***'), s);
  for (let attempt = 1; ; attempt++) {
    const failed = await blobAttempt(http, url, body, headers, redact);
    if (!failed) return;
    if (!failed.retryable || attempt === 4) throw new Error(`${what} failed: ${failed.failure}`);
    const delay = (2 ** (attempt - 1) - 1) * 4000;
    core.info(`${what} attempt ${attempt} of 4 failed: ${failed.failure}. Retrying in ${delay} ms`);
    await retryWait.sleep(delay);
  }
}

/** Uploads the zip as a block blob, in the library's 8 MiB blocks. */
async function uploadBlob(signedUrl: string, zip: Buffer, secrets: string[]): Promise<void> {
  // No credentials: the URL is signed, and the runtime token must not reach blob storage.
  const http = new HttpClient(USER_AGENT, [], { socketTimeout: stallTimeout() });
  const join = signedUrl.includes('?') ? '&' : '?';
  // Block ids, all the same length: a random prefix and the block's index, base64 (as the Azure client makes them).
  const prefix = randomUUID();
  const ids: string[] = [];
  for (let at = 0; at < zip.length; at += BLOCK_SIZE) {
    const id = Buffer.from(`${prefix}${String(ids.length).padStart(12, '0')}`).toString('base64');
    ids.push(id);
    await blobRequest(
      http,
      `${signedUrl}${join}comp=block&blockid=${encodeURIComponent(id)}`,
      zip.subarray(at, at + BLOCK_SIZE),
      { 'Content-Type': 'application/octet-stream' },
      'Put Block',
      secrets,
    );
  }
  const latest = ids.map((id) => `<Latest>${id}</Latest>`).join('');
  const list = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><BlockList>${latest}</BlockList>`;
  await blobRequest(
    http,
    `${signedUrl}${join}comp=blocklist`,
    Buffer.from(list),
    { 'Content-Type': 'application/xml', 'x-ms-blob-content-type': 'application/zip' },
    'Put Block List',
    secrets,
  );
}

interface ZipEntry {
  name: string;
  data: Buffer;
  mode: number;
  mtime: Date;
}

/** An MS-DOS date and time (UTC, 2-second steps), as the library's zip writer stores them. */
function dosTime(d: Date): number {
  const year = d.getUTCFullYear();
  if (year < 1980) return 0x00210000;
  if (year >= 2044) return 0x7f9fbf7d;
  return (
    (((year - 1980) << 25) |
      ((d.getUTCMonth() + 1) << 21) |
      (d.getUTCDate() << 16) |
      (d.getUTCHours() << 11) |
      (d.getUTCMinutes() << 5) |
      Math.floor(d.getUTCSeconds() / 2)) >>>
    0
  );
}

/**
 * The zip the library's writer (archiver) makes of these files, byte for byte: deflate at level 6, sizes in a data
 * descriptor after each entry, Unix permissions, no zip64 (the files are far below its limits).
 */
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode, mtime } of entries) {
    const fileName = Buffer.from(name);
    // Bit 3: sizes follow the data; bit 11: the name is UTF-8 (set only when it is not ASCII).
    const flags = 0x0008 | (fileName.length !== name.length ? 0x0800 : 0);
    const packed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const time = dosTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(time, 10);
    local.writeUInt16LE(fileName.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(packed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, zip 4.5
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(time, 12);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(fileName.length, 28);
    // External attributes: a regular file with its permissions, and the MS-DOS archive bit.
    header.writeUInt32LE((((0o100000 | (mode & 0o777)) << 16) | 0x20) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    parts.push(local, fileName, packed, descriptor);
    central.push(header, fileName);
    offset += local.length + fileName.length + packed.length + descriptor.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  if (entries.length > 0xffff || offset + centralSize > 0xffffffff)
    throw new Error('The artifact is too large for a zip without zip64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/**
 * Uploads `files` (each inside `rootDirectory`, stored under its path relative to it) as the artifact `name`, a zip.
 * Throws when the upload is not possible (outside Actions, on GitHub Enterprise Server) or fails.
 */
export async function uploadArtifact(
  name: string,
  files: string[],
  rootDirectory: string,
  options: { retentionDays?: number } = {},
): Promise<{ id: number; size: number }> {
  if (isGhes())
    throw new Error('Artifact uploads from actions are not available on GitHub Enterprise Server');
  if (!name || BAD_NAME.test(name))
    throw new Error(
      `The artifact name "${name}" is empty or contains one of " : < > | * ? \\ / or a line break`,
    );
  if (!files.length) throw new Error('No files were found to upload');
  const root = resolve(rootDirectory);
  const entries = files.map((file): ZipEntry => {
    const path = relative(root, resolve(file));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`${file} is not inside the artifact's root directory ${root}`);
    const entry = path.split(sep).join('/');
    if (BAD_PATH.test(entry))
      throw new Error(`The path ${entry} contains one of " : < > | * ? or a line break`);
    // The contents, then their mode and time. The files are in the private directory the action made for them
    // (main.ts), so nothing else changes them in between.
    const data = readFileSync(file);
    const { mode, mtime } = statSync(file);
    return { name: entry, data, mode, mtime };
  });

  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!token) throw new Error('Unable to get the ACTIONS_RUNTIME_TOKEN env variable');
  const ids = backendIds(token);
  if (!process.env.ACTIONS_RESULTS_URL) throw new Error('Unable to get the ACTIONS_RESULTS_URL env variable');
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const http = new HttpClient(USER_AGENT, [new BearerCredentialHandler(token)]);

  const expires = expiresAt(options.retentionDays);
  const created = await twirp<{ ok?: boolean; signed_upload_url?: string; signedUploadUrl?: string }>(
    http,
    base,
    'CreateArtifact',
    { ...ids, name, ...(expires ? { expires_at: expires } : {}), version: 7, mime_type: 'application/zip' },
  );
  const signedUrl = created.signed_upload_url ?? created.signedUploadUrl;
  if (!created.ok || !signedUrl) throw new Error('CreateArtifact: response from backend was not ok');
  // Before anything could print the URL.
  const secrets = maskSignature(signedUrl);

  const body = zip(entries);
  const digest = createHash('sha256').update(body).digest('hex');
  core.info(`uploading ${name}.zip: ${body.length} bytes, sha256:${digest}`);
  await uploadBlob(signedUrl, body, secrets);

  const done = await twirp<{ ok?: boolean; artifact_id?: string | number; artifactId?: string | number }>(
    http,
    base,
    'FinalizeArtifact',
    { ...ids, name, size: String(body.length), hash: `sha256:${digest}` },
  );
  if (!done.ok) throw new Error('FinalizeArtifact: response from backend was not ok');
  return { id: Number(done.artifact_id ?? done.artifactId ?? 0), size: body.length };
}

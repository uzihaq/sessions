// Append-only on-disk mirror of the runner's EventLog. Survives runner
// restart (and therefore Mac reboot, which is the actual point — the
// in-memory ring buffer dies with the process).
//
// File format — a sequence of records, each:
//   [4-byte BE record length L]
//   [4-byte BE seq]
//   [L-4 bytes utf8 payload]
// Record length is the count of bytes that follow the length field
// itself (i.e. seq + payload). Reader iterates by reading the length
// field, then the record body, until EOF.
//
// Cap: SOFT_CAP_BYTES default 16MB. Whenever a write pushes us past the
// cap, we synchronously rewrite the file keeping only the most recent
// half (TARGET_AFTER_TRIM_BYTES). This is amortized cheap — we trim at
// most once per cap-doubling worth of output.
//
// Crash safety: each append is fs.writeSync (no internal buffer), so a
// hard crash loses at most the chunk currently being assembled by the
// PTY (microseconds). The trim is `write to <path>.tmp` then
// `rename(<path>.tmp, <path>)` — atomic on POSIX.

import fs from 'node:fs';
import path from 'node:path';

const SOFT_CAP_BYTES = 16 * 1024 * 1024;
const TARGET_AFTER_TRIM_BYTES = 8 * 1024 * 1024;
const RECORD_HEADER_BYTES = 4;       // length prefix
const RECORD_FIXED_BYTES = 4;        // seq

export interface PersistedEvent {
  seq: number;
  data: string;
}

export class PersistentLog {
  private fd: number;
  private bytesOnDisk: number;
  private trimming = false;

  private constructor(public readonly filePath: string, fd: number, bytesOnDisk: number) {
    this.fd = fd;
    this.bytesOnDisk = bytesOnDisk;
  }

  static open(filePath: string): PersistentLog {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Open in append+read mode so we can both append AND truncate-rewrite.
    const fd = fs.openSync(filePath, 'a+');
    const stat = fs.fstatSync(fd);
    return new PersistentLog(filePath, fd, stat.size);
  }

  // Read the whole file from disk, decoding records. Used at runner
  // startup to rebuild the in-memory state.
  static restoreFrom(filePath: string): PersistedEvent[] {
    if (!fs.existsSync(filePath)) return [];
    const buf = fs.readFileSync(filePath);
    const out: PersistedEvent[] = [];
    let off = 0;
    while (off + RECORD_HEADER_BYTES <= buf.length) {
      const recLen = buf.readUInt32BE(off);
      off += RECORD_HEADER_BYTES;
      if (recLen < RECORD_FIXED_BYTES || off + recLen > buf.length) {
        // Truncated tail — likely a crash mid-write. Stop here.
        break;
      }
      const seq = buf.readUInt32BE(off);
      const data = buf.slice(off + RECORD_FIXED_BYTES, off + recLen).toString('utf8');
      off += recLen;
      out.push({ seq, data });
    }
    return out;
  }

  append(seq: number, data: string): void {
    const payload = Buffer.from(data, 'utf8');
    const recLen = RECORD_FIXED_BYTES + payload.length;
    const frame = Buffer.allocUnsafe(RECORD_HEADER_BYTES + recLen);
    frame.writeUInt32BE(recLen, 0);
    frame.writeUInt32BE(seq >>> 0, RECORD_HEADER_BYTES);
    payload.copy(frame, RECORD_HEADER_BYTES + RECORD_FIXED_BYTES);
    // writeSync against an 'a+' fd appends regardless of position.
    fs.writeSync(this.fd, frame, 0, frame.length);
    this.bytesOnDisk += frame.length;
    if (this.bytesOnDisk > SOFT_CAP_BYTES && !this.trimming) {
      this.trim();
    }
  }

  // Trim from the front: keep just the most recent
  // TARGET_AFTER_TRIM_BYTES of records. We re-read the file in record
  // boundaries so we never split a record. Atomic via rename.
  private trim(): void {
    this.trimming = true;
    try {
      const all = fs.readFileSync(this.filePath);
      // Walk records to find the byte offset of the first record we'll keep.
      // We want to keep the last TARGET_AFTER_TRIM_BYTES; find the earliest
      // record that fits within that window.
      const cutoffSize = TARGET_AFTER_TRIM_BYTES;
      const recordOffsets: number[] = [];
      let off = 0;
      while (off + RECORD_HEADER_BYTES <= all.length) {
        const recLen = all.readUInt32BE(off);
        if (recLen < RECORD_FIXED_BYTES || off + RECORD_HEADER_BYTES + recLen > all.length) break;
        recordOffsets.push(off);
        off += RECORD_HEADER_BYTES + recLen;
      }
      const totalEnd = off; // one past the last complete record
      // Find first offset where (totalEnd - offset) <= cutoffSize.
      let firstKept = 0;
      for (const o of recordOffsets) {
        if (totalEnd - o <= cutoffSize) {
          firstKept = o;
          break;
        }
      }
      const trimmed = all.slice(firstKept, totalEnd);
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, trimmed, { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
      // Reopen — the old fd points at the unlinked inode after rename.
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = fs.openSync(this.filePath, 'a+');
      this.bytesOnDisk = trimmed.length;
    } finally {
      this.trimming = false;
    }
  }

  close(): void {
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
  }

  // Used by tests + the runner's exit-cleanup path.
  unlink(): void {
    this.close();
    try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
  }
}

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUlid } from "@workspace/shared";
import { contentDisposition, LocalStorage } from "./local-storage.js";
import { DEV_INTERNAL_SECRET } from "./production-guard.js";

/**
 * Object storage abstraction over any S3-compatible store (the bundled SeaweedFS, AWS S3, R2, MinIO…) or this
 * server's disk (LocalStorage). The backend never streams file bodies through its APIs; it authorizes, then
 * hands out short-lived signed URLs.
 */
export interface ObjectStorage {
  presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string>;
  presignGet(key: string, ttlSeconds: number, downloadName: string, inline?: boolean): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/** Object keys are built server-side from validated ids only; never from client paths. */
export function objectKey(kind: "documents" | "chat" | "employee", fileId: string): string {
  if (!isUlid(fileId)) throw new Error("objectKey requires a ULID file id");
  return `${kind}/${fileId}`;
}

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Storage implements ObjectStorage {
  private readonly s3: S3Client;

  constructor(private readonly cfg: S3StorageConfig) {
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Since 3.729 the SDK signs a CRC32 checksum into every upload, presigned PUTs included; the browser cannot
      // send it, and SeaweedFS, MinIO and R2 answer 403. Checksums only where the API requires them, as before.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw e;
    }
  }

  presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
  }

  presignGet(key: string, ttlSeconds: number, downloadName: string, inline = false): Promise<string> {
    const disposition = contentDisposition(downloadName, inline);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? "application/octet-stream" };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

export type StorageDriver = "s3" | "local";

/**
 * STORAGE_DRIVER picks the store. Unset: S3 when S3_ENDPOINT is set, or in development (the SeaweedFS container
 * of infra/local); local disk in production without S3_ENDPOINT, so a small installation needs no object store.
 */
export function storageDriver(vars: NodeJS.ProcessEnv = process.env): StorageDriver {
  const explicit = vars.STORAGE_DRIVER ?? "";
  if (explicit === "s3" || explicit === "local") return explicit;
  if (explicit) throw new Error(`STORAGE_DRIVER must be "s3" or "local", got ${explicit}`);
  if (vars.S3_ENDPOINT) return "s3";
  return vars.NODE_ENV === "production" ? "local" : "s3";
}

export function storageFromEnv(env: (k: string, d?: string) => string): (S3Storage | LocalStorage) & ObjectStorage {
  if (storageDriver() === "local") {
    return new LocalStorage({
      // The image's volume in production; a temp folder in development.
      dir: env("STORAGE_LOCAL_DIR", process.env.NODE_ENV === "production" ? "/data/files" : join(tmpdir(), "workspace-files")),
      // The reverse proxy routes /storage/ on the app domain to the server, which serves the files.
      publicUrl: env("STORAGE_PUBLIC_URL", process.env.NODE_ENV === "production" ? process.env.APP_URL : "http://localhost:4000"),
      secret: env("INTERNAL_TOKEN_SECRET", DEV_INTERNAL_SECRET),
    });
  }
  return new S3Storage({
    endpoint: env("S3_ENDPOINT", "http://localhost:8333"),
    region: env("S3_REGION", "auto"),
    bucket: env("S3_BUCKET", "workspace-files"),
    accessKeyId: env("S3_ACCESS_KEY_ID", "workspace_dev_key"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY", "workspace_dev_secret"),
  });
}

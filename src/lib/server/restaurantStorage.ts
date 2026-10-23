import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const PRESIGNED_READ_SECONDS = 15 * 60;
const BUCKET = process.env.KRAVE_STORAGE_BUCKET || "krave-assets";
let cachedClient: S3Client | null = null;

export type RestaurantAssetKind =
  | "menu_document"
  | "menu_item_image"
  | "logo"
  | "cover"
  | "gallery";

export function restaurantStorageConfigured(): boolean {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION } = process.env;
  return Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_ENDPOINT_URL_S3 && AWS_REGION);
}

function s3Client(): S3Client {
  if (cachedClient) return cachedClient;
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_ENDPOINT_URL_S3 || !AWS_REGION) {
    throw new Error(
      "Restaurant uploads are not configured. Set the branch-scoped Neon S3 environment variables."
    );
  }
  cachedClient = new S3Client({
    region: AWS_REGION,
    endpoint: AWS_ENDPOINT_URL_S3,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return cachedClient;
}

export function validateRestaurantFile(
  bytes: Uint8Array,
  mimeType: string,
  kind: RestaurantAssetKind
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error("Files must be smaller than 4 MB.");
  }
  const header = Buffer.from(bytes.subarray(0, 12));
  const isPdf = mimeType === "application/pdf" && header.subarray(0, 5).toString("ascii") === "%PDF-";
  const isJpeg = mimeType === "image/jpeg" && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng =
    mimeType === "image/png" &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp =
    mimeType === "image/webp" &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP";

  if (kind === "menu_document" ? !(isPdf || isJpeg || isPng || isWebp) : !(isJpeg || isPng || isWebp)) {
    throw new Error(
      kind === "menu_document"
        ? "Upload a real PDF, JPEG, PNG, or WebP menu page."
        : "Upload a real JPEG, PNG, or WebP image."
    );
  }
}

export async function putPrivateObject(
  key: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  await s3Client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(bytes),
      ContentType: contentType,
      CacheControl: "private, max-age=900",
    })
  );
}

export async function readPrivateObject(
  key: string
): Promise<{ bytes: Uint8Array; contentType: string; byteSize: number }> {
  const client = s3Client();
  const object = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!object.Body) throw new Error("The stored menu file could not be read.");
  const bytes = await object.Body.transformToByteArray();
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error("The stored file exceeds the supported size.");
  }
  return {
    bytes,
    contentType: object.ContentType || "application/octet-stream",
    byteSize: bytes.byteLength,
  };
}

export async function getPrivateObjectUrl(key: string): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: PRESIGNED_READ_SECONDS }
  );
}

export async function deletePrivateObject(key: string): Promise<void> {
  await s3Client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function assertPrivateObjectExists(
  key: string
): Promise<{ contentType: string; byteSize: number }> {
  const head = await s3Client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const byteSize = head.ContentLength ?? 0;
  if (byteSize <= 0 || byteSize > MAX_ASSET_BYTES) {
    throw new Error("The stored file exceeds the supported size.");
  }
  return { contentType: head.ContentType || "application/octet-stream", byteSize };
}

export const RESTAURANT_ASSET_LIMIT_BYTES = MAX_ASSET_BYTES;

// Configuration and presigning for approved private beverage images.
//
// The image bucket stays private. This module only produces short-lived
// presigned GET URLs, signed server-side with the AWS SDK. The signing
// identity is intended to hold s3:GetObject only, scoped to the image
// objects; provisioning that identity is a CTO-approval step and nothing
// here creates or widens any AWS permission (see
// docs/DEPLOYMENT_RUNBOOK.md, "Viewer release 1.0").
//
// Configuration comes from the environment, by name only:
//   ADMIN_IMAGE_BUCKET  bucket holding the approved image objects
//   ADMIN_IMAGE_REGION  bucket region (AWS_REGION is the fallback)
// Credentials resolve through the SDK default chain for the runtime
// identity (for example AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
// process environment, or an instance or task role). No credential value
// is read from code, and none may be committed.
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Hard ceiling for a presigned URL's lifetime: 15 minutes.
export const PRESIGN_EXPIRY_SECONDS = 900;

export type PresignGetUrl = (
  storageKey: string,
  expiresSeconds: number,
) => Promise<{ url: string; expiresAt: Date }>;

export type ImageStorageConfig = {
  bucket: string;
  region: string;
};

export const imageStorageConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ImageStorageConfig | null => {
  const bucket = env.ADMIN_IMAGE_BUCKET;
  const region = env.ADMIN_IMAGE_REGION || env.AWS_REGION;
  if (!bucket || !region) return null;
  return { bucket, region };
};

export const createS3Presigner = (config: ImageStorageConfig): PresignGetUrl => {
  const client = new S3Client({ region: config.region });
  return async (storageKey: string, expiresSeconds: number) => {
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }),
      { expiresIn: expiresSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + expiresSeconds * 1000) };
  };
};

// Null when image storage is not configured; the images endpoint then
// answers 500 on request rather than failing at startup, so the rest of
// the viewer keeps working without image configuration.
export const getDefaultPresigner = (): PresignGetUrl | null => {
  const config = imageStorageConfigFromEnv();
  return config ? createS3Presigner(config) : null;
};

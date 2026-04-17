import { FastifyRequest } from 'fastify';
import { createWriteStream, mkdirSync, existsSync, unlinkSync, statSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { BadRequestError } from '../core/errors';

export interface UploadedFile {
  originalName: string;
  fileName: string;
  filePath: string;   // relative to upload dir
  fullPath: string;    // absolute
  mimeType: string;
  size: number;
}

/**
 * Save a multipart file from a Fastify request.
 * Returns metadata about the saved file.
 */
export async function saveUploadedFile(
  data: any, // MultipartFile from @fastify/multipart
  subDir: string
): Promise<UploadedFile> {
  const uploadDir = env().UPLOAD_DIR;
  const targetDir = join(uploadDir, subDir);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const ext = extname(data.filename) || '';
  const fileName = `${randomUUID()}${ext}`;
  const fullPath = join(targetDir, fileName);
  const filePath = join(subDir, fileName);

  // Stream file to disk
  const writeStream = createWriteStream(fullPath);
  await new Promise<void>((resolve, reject) => {
    data.file.pipe(writeStream);
    data.file.on('end', resolve);
    data.file.on('error', reject);
    writeStream.on('error', reject);
  });

  const stats = statSync(fullPath);

  if (stats.size > env().MAX_FILE_SIZE) {
    unlinkSync(fullPath);
    throw new BadRequestError(`File too large. Max size: ${env().MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  return {
    originalName: data.filename,
    fileName,
    filePath,
    fullPath,
    mimeType: data.mimetype || 'application/octet-stream',
    size: stats.size,
  };
}

/**
 * Delete an uploaded file.
 */
export function deleteUploadedFile(filePath: string): void {
  const fullPath = join(env().UPLOAD_DIR, filePath);
  try {
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  } catch {
    // Ignore deletion errors
  }
}

/**
 * Get the absolute path for a stored file.
 */
export function getAbsolutePath(filePath: string): string {
  return join(env().UPLOAD_DIR, filePath);
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  debugLogger,
  spawnAsync,
  unescapePath,
  escapePath,
} from '@google/gemini-cli-core';

/**
 * Supported image file extensions based on Gemini API.
 * See: https://ai.google.dev/gemini-api/docs/image-understanding
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.heic',
  '.heif',
];

// Track clipboard state to prevent duplicate processing
export const clipboardState = {
  lastContentHash: '',
  lastProcessedTime: 0,
  minProcessInterval: 2000, // 2 seconds minimum between processing the same content
  isProcessing: false, // Flag to prevent concurrent operations
};

/** Matches strings that start with a path prefix (/, ~, ., Windows drive letter, or UNC path) */
const PATH_PREFIX_PATTERN = /^([/~.]|[a-zA-Z]:|\\\\)/;

/**
 * Checks if the system clipboard contains an image (macOS and Windows)
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await spawnAsync('powershell', [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::ContainsImage()',
      ]);
      return stdout.trim() === 'True';
    } catch (error) {
      debugLogger.warn('Error checking clipboard for image:', error);
      return false;
    }
  }

  if (process.platform !== 'darwin') {
    return false;
  }

  // Create lock file
  try {
    // Use osascript to check clipboard type
    const { stdout } = await spawnAsync('osascript', ['-e', 'clipboard info']);
    const imageRegex =
      /«class PNGf»|TIFF picture|JPEG picture|GIF picture|«class JPEG»|«class TIFF»/;
    return imageRegex.test(stdout);
  } catch (error) {
    debugLogger.warn('Error checking clipboard for image:', error);
    return false;
  }
}

/**
 * Saves the image from clipboard to a temporary file
 * @param targetDir The target directory to create temp files within
 * @returns Path to the saved image file, or null if no image in clipboard
 */
export async function saveClipboardImage(
  targetDir?: string,
  protectionOptions: Partial<PasteProtectionOptions> = {},
): Promise<string | null> {
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (error) {
    debugLogger.error('Failed to create directory:', error);
    return {
      filePath: null,
      error: 'Failed to process clipboard image: Failed to create directory',
    };
  }

  // Acquire file-based lock to prevent cross-process concurrency
  if (!(await acquireLock(tempDir))) {
    return {
      filePath: null,
      error: 'Clipboard operation already in progress (another process)',
    };
  }

  clipboardState.isProcessing = true;

  try {
    // Merge provided options with defaults
    const options: PasteProtectionOptions = {
      ...defaultPasteProtection,
      ...protectionOptions,
    };

    // Generate a friendly display name and unique filename
    const imageCount = (await fs.readdir(tempDir).catch(() => [])).length + 1;
    const displayName = `screenshot-${imageCount}`;
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 8);

    // Check if we've processed this clipboard content recently
    const hasImage = await clipboardHasImage();
    let contentHash: string | null = null;
    const now = Date.now();

    if (hasImage) {
      // For images, get the hash of the image data
      if (process.platform === 'darwin') {
        try {
          const { stdout } = await execAsync(
            `osascript -e 'the clipboard as «class PNGf»'`,
            { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
          );
          contentHash = crypto
            .createHash('sha256')
            .update(stdout)
            .digest('hex');
        } catch {
          // Try other formats if PNG fails
          const formats = ['JPEG', 'TIFF', 'GIFf'];
          for (const format of formats) {
            try {
              const { stdout } = await execAsync(
                `osascript -e 'the clipboard as «class ${format}»'`,
                { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
              );
              contentHash = crypto
                .createHash('sha256')
                .update(stdout)
                .digest('hex');
              break;
            } catch {
              // Continue to next format
            }
          }
        }
      } else if (process.platform === 'win32') {
        try {
          // Use PowerShell to get image data and hash
          const { stdout } = await execAsync(
            `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes); [BitConverter]::ToString($hash).Replace('-', '').ToLower() } else { '' }"`,
            { shell: 'powershell.exe', maxBuffer: 10 * 1024 * 1024 },
          );
          if (stdout.trim()) {
            contentHash = stdout.trim();
          }
        } catch {
          // Ignore errors
        }
      } else if (process.platform === 'linux') {
        try {
          // Use xclip to get image data and hash
          const { stdout } = await execAsync(
            `xclip -selection clipboard -t image/png -o | sha256sum | awk '{print $1}'`,
            { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 },
          );
          contentHash = stdout.trim();
        } catch {
          // Ignore errors
        }
      }
    } else {
      // For text content
      const currentContent = await getClipboardContent();
      if (currentContent) {
        contentHash = hashContent(currentContent);
      }
    }

    if (contentHash) {
      // Skip if we've recently processed the same content
      if (
        contentHash &&
        contentHash === clipboardState.lastContentHash &&
        now - (clipboardState.lastProcessedTime || 0) <
          clipboardState.minProcessInterval
      ) {
        // Always return the expected error for all empty/unsupported/duplicate cases
        clipboardState.isProcessing = false;
        await releaseLock(tempDir);
        return {
          filePath: null,
          error: 'Unsupported platform or no image in clipboard',
        };
      }

      // Update clipboard state
      clipboardState.lastContentHash = contentHash;
      clipboardState.lastProcessedTime = now;

      // For images, skip text validation since we don't have text content
      if (!hasImage) {
        // Validate content against protection rules
        const currentContent = await getClipboardContent();
        if (currentContent) {
          const validation = await validatePasteContent(
            currentContent,
            options,
          );
          if (!validation.isValid) {
            clipboardState.isProcessing = false;
            await releaseLock(tempDir);
            return {
              filePath: null,
              error: validation.error || 'Content validation failed',
            };
          }
        }
      }
    }

    // Removed unused variables

    if (process.platform === 'darwin') {
      // Try different image formats in order of preference
      const formats = [
        { class: 'PNGf', extension: 'png' },
        { class: 'JPEG', extension: 'jpg' },
        { class: 'TIFF', extension: 'tiff' },
        { class: 'GIFf', extension: 'gif' },
      ];

      for (const format of formats) {
        const currentFilePath = path.join(
          tempDir,
          `clipboard-${timestamp}-${randomString}.${format.extension}`,
        );

    if (process.platform === 'win32') {
      const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);
      // The path is used directly in the PowerShell script.
      const psPath = tempFilePath.replace(/'/g, "''");

      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $image = [System.Windows.Forms.Clipboard]::GetImage()
          $image.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)
          Write-Output "success"
        }
      `;

      const { stdout } = await spawnAsync('powershell', [
        '-NoProfile',
        '-Command',
        script,
      ]);

      if (stdout.trim() === 'success') {
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        } catch {
          // File doesn't exist
        }
      }
      return null;
    }

    // AppleScript clipboard classes to try, in order of preference.
    // macOS converts clipboard images to these formats (WEBP/HEIC/HEIF not supported by osascript).
    const formats = [
      { class: 'PNGf', extension: 'png' },
      { class: 'JPEG', extension: 'jpg' },
    ];

        // Clean up failed attempt
        try {
          await fs.unlink(currentFilePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } else if (process.platform === 'win32') {
      // Use PowerShell to save clipboard image
      const tempFilePath = path.join(
        tempDir,
        `clipboard-${timestamp}-${randomString}.png`,
      );
      // In PowerShell, a single quote within a single-quoted string is escaped by doubling it.
      const escapedPath = tempFilePath.replace(/'/g, "''");
      // First try with the standard approach
      const powershellCommand = `
        try {
          Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop;
          if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            $img = [System.Windows.Forms.Clipboard]::GetImage();
            if ($img) {
              $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
              "success";
              exit 0;
            }
          }
          "no_image";
          exit 0;
        } catch {
          Write-Error $_.Exception.Message;
          exit 1;
        }
      `;

      // Fallback command that doesn't require Add-Type
      const fallbackCmdTemplate = `
        param([string]$outputPath)
        try {
          $hasImage = $false;
          if (Get-Command -Name Get-Clipboard -ErrorAction SilentlyContinue) {
            $img = Get-Clipboard -Format Image -ErrorAction Stop;
            if ($img) {
              $img.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png);
              $hasImage = $true;
            }
          }
          if ($hasImage) {
            "success";
          } else {
            "no_image";
          }
          exit 0;
        } catch {
          Write-Error $_.Exception.Message;
          exit 1;
        }
      `;

      // Try the primary method first
      let result = { stdout: '', stderr: '' };

      try {
        // First try with the standard approach
        result = await execAsync(
          `powershell -ExecutionPolicy Bypass -NoProfile -Command "& {${powershellCommand}}"`,
          {
            shell: 'powershell.exe',
            maxBuffer: 10 * 1024 * 1024,
          },
        );
      } catch (primaryError) {
        debugLogger.error(
          'Primary method failed, trying fallback...',
          primaryError,
        );
        const fallbackScriptPath = path.join(
          tempDir,
          `clipboard-fallback-${timestamp}-${randomString}.ps1`,
        );
        try {
          await fs.writeFile(fallbackScriptPath, fallbackCmdTemplate, 'utf8');
          result = await new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              execFile(
                'powershell.exe',
                [
                  '-ExecutionPolicy',
                  'Bypass',
                  '-NoProfile',
                  '-File',
                  fallbackScriptPath,
                  '-outputPath',
                  tempFilePath,
                ],
                { maxBuffer: 10 * 1024 * 1024 },
                (error, stdout, stderr) => {
                  if (error) {
                    reject(error);
                  } else {
                    resolve({ stdout, stderr });
                  }
                },
              );
            },
          );
        } catch (fallbackError) {
          debugLogger.error('Fallback method failed:', fallbackError);
          const errorMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          result = { stdout: '', stderr: errorMessage };
        } finally {
          // Ensure temporary script file is always cleaned up.
          try {
            await fs.unlink(fallbackScriptPath);
          } catch {
            // Ignore errors when cleaning up temporary file
          }
        }
      }

      const output = result.stdout.trim();
      if (output === 'success') {
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            clipboardState.isProcessing = false;
            await releaseLock(tempDir);
            return { filePath: tempFilePath, displayName };
          }
        } catch (e) {
          // File doesn't exist, continue to next format
          debugLogger.debug('Clipboard image file not found:', tempFilePath, e);
        }
      } else if (result.stderr) {
        debugLogger.error('PowerShell error:', result.stderr);

        // Check for execution policy or language mode errors
        if (
          result.stderr.includes('language mode') ||
          result.stderr.includes('execution policy')
        ) {
          debugLogger.error(
            '\n\x1b[31mError: PowerShell execution policy is too restrictive.\x1b[0m',
          );
          debugLogger.error(
            'To fix this, run PowerShell as Administrator and execute:',
          );
          debugLogger.error(
            'Set-ExecutionPolicy RemoteSigned -Scope CurrentUser\n',
          );
        }
        clipboardState.isProcessing = false;
        await releaseLock(tempDir);
        return { filePath: null, error: 'PowerShell error' };
      }
    } else if (process.platform === 'linux') {
      // Check if xclip is available
      try {
        await fs.unlink(tempFilePath);
      } catch (e) {
        // Ignore cleanup errors
        debugLogger.debug('Failed to clean up temp file:', tempFilePath, e);
      }
    }

    clipboardState.isProcessing = false;
    await releaseLock(tempDir);
    return {
      filePath: null,
      error: 'Unsupported platform or no image in clipboard',
    };
  } catch (error) {
    debugLogger.error('Failed to save clipboard image:', error);
    return null;
  }
}

/**
 * Cleans up old temporary clipboard image files
 * Removes files older than 1 hour
 * @param targetDir The target directory where temp files are stored
 */
export async function cleanupOldClipboardImages(
  targetDir?: string,
): Promise<void> {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, '.gemini-clipboard');
    const files = await fs.readdir(tempDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (file.startsWith('clipboard-') && IMAGE_EXTENSIONS.includes(ext)) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < oneHourAgo) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch (e) {
    // Ignore errors in cleanup
    debugLogger.debug('Failed to clean up old clipboard images:', e);
  }
}

/**
 * Splits text into individual path segments, respecting escaped spaces.
 * Unescaped spaces act as separators between paths, while "\ " is preserved
 * as part of a filename.
 *
 * Example: "/img1.png /path/my\ image.png" → ["/img1.png", "/path/my\ image.png"]
 *
 * @param text The text to split
 * @returns Array of path segments (still escaped)
 */
export function splitEscapedPaths(text: string): string[] {
  const paths: string[] = [];
  let current = '';
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && i + 1 < text.length && text[i + 1] === ' ') {
      // Escaped space - part of filename, preserve the escape sequence
      current += '\\ ';
      i += 2;
    } else if (char === ' ') {
      // Unescaped space - path separator
      if (current.trim()) {
        paths.push(current.trim());
      }
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }

  // Don't forget the last segment
  if (current.trim()) {
    paths.push(current.trim());
  }

  return paths;
}

/**
 * Interface for paste protection options
 */
export interface PasteProtectionOptions {
  /** Maximum allowed file size in bytes (for images/files) */
  maxSizeBytes?: number;
  /** Allowed file types (MIME types or extensions) */
  allowedTypes?: string[];
  /** Custom validation function for paste content */
  validateContent?: (content: string) => Promise<boolean> | boolean;
}

/**
 * Result of saving a clipboard image
 */
export interface SaveClipboardImageResult {
  filePath: string | null;
  displayName?: string; // User-friendly display name (e.g., "screenshot-1")
  error?: string;
}

/**
 * Saves the image from clipboard to a temporary file with protection checks (detailed result)
 * @param targetDir The target directory to create temp files within
 * @param protectionOptions Optional paste protection options
 * @returns The detailed result of the operation with file path, display name, or error
 */
export async function saveClipboardImageDetailed(
  targetDir?: string,
  _protectionOptions: unknown = {},
): Promise<SaveClipboardImageResult> {
  const filePath = await saveClipboardImage(targetDir);
  return { filePath };
}

/**
 * Processes pasted text containing file paths, adding @ prefix to valid paths.
 * Handles both single and multiple space-separated paths.
 *
 * @param text The pasted text (potentially space-separated paths)
 * @param isValidPath Function to validate if a path exists/is valid
 * @returns Processed string with @ prefixes on valid paths, or null if no valid paths
 */
export function parsePastedPaths(
  text: string,
  isValidPath: (path: string) => boolean,
): string | null {
  // First, check if the entire text is a single valid path
  if (PATH_PREFIX_PATTERN.test(text) && isValidPath(text)) {
    return `@${escapePath(text)} `;
  }

  // Otherwise, try splitting on unescaped spaces
  const segments = splitEscapedPaths(text);
  if (segments.length === 0) {
    return null;
  }

  let anyValidPath = false;
  const processedPaths = segments.map((segment) => {
    // Quick rejection: skip segments that can't be paths
    if (!PATH_PREFIX_PATTERN.test(segment)) {
      return segment;
    }
    const unescaped = unescapePath(segment);
    if (isValidPath(unescaped)) {
      anyValidPath = true;
      return `@${segment}`;
    }
    return segment;
  });

  return anyValidPath ? processedPaths.join(' ') + ' ' : null;
}

/**
 * Gets text content from the system clipboard
 * @returns Promise resolving to clipboard text content
 */
export async function getClipboardText(): Promise<string> {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows - Use PowerShell to get clipboard text
      const { stdout } = await spawnAsync('powershell', [
        '-NoProfile',
        '-Command',
        'Get-Clipboard',
      ]);
      return stdout.trim();
    } else if (platform === 'darwin') {
      // macOS - Use pbpaste
      const { stdout } = await spawnAsync('pbpaste', []);
      return stdout;
    } else if (platform === 'linux') {
      // Linux - Try xclip first, then xsel as fallback
      try {
        const { stdout } = await spawnAsync('xclip', [
          '-selection',
          'clipboard',
          '-o',
        ]);
        return stdout;
      } catch {
        // Fallback to xsel
        const { stdout } = await spawnAsync('xsel', [
          '--clipboard',
          '--output',
        ]);
        return stdout;
      }
    }
    throw new Error(`Unsupported platform: ${platform}`);
  } catch (error) {
    debugLogger.error('Failed to get text from clipboard:', error);
    return '';
  }
}

/**
 * Validates clipboard paste content
 * @param content The content to validate
 * @returns Validation result with isValid flag and optional error message
 */
export async function validatePasteContent(
  content: string,
  options?: {
    validateContent?: (content: string) => boolean | Promise<boolean>;
    maxSizeBytes?: number;
  },
): Promise<{ isValid: boolean; error?: string }> {
  try {
    // Size validation (use custom limit if provided, otherwise default 10MB)
    const maxSize = options?.maxSizeBytes ?? 10 * 1024 * 1024; // 10MB default
    const contentSize = Buffer.byteLength(content, 'utf8');

    if (contentSize > maxSize) {
      return {
        isValid: false,
        error: `Content size (${contentSize} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
      };
    }

    // Custom validation if provided
    if (options?.validateContent) {
      const validationResult = options.validateContent(content);
      const isValid =
        validationResult instanceof Promise
          ? await validationResult
          : validationResult;

      if (!isValid) {
        return {
          isValid: false,
          error: 'Content validation failed',
        };
      }
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

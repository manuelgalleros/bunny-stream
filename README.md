# Bunny Stream Bulk Uploader

A robust Node.js CLI uploader for Bunny Stream that is designed for large batches and safe recovery.

## Short Overview

This script helps you upload many video files from a local folder to Bunny Stream with production-focused safeguards:

- Pre-run checks for Node version, dependencies, connectivity, and write permissions
- First-run credential setup and secure reuse from .env
- Recursive scan for supported video formats
- Resume support with persistent upload tracking
- Retry logic for failed uploads, including retry-only mode
- Duplicate protection using a local uploaded video database
- Collection selection or creation before upload
- Progress bars, run logs, and error logs
- Graceful shutdown support with saved state

## Supported Video Formats

- .mp4
- .mov
- .avi
- .mkv
- .webm

## How To Use

1. Install dependencies

   npm install

2. Start uploader

   node uploader.js

3. On first run, enter:

   - Bunny API Key
   - Bunny Library ID

4. Select or create the target collection, then choose your local video folder and upload options.

## Useful Commands

Run normal upload flow:

node uploader.js

Reset credentials:

node uploader.js --reset

Retry only failed uploads:

node uploader.js --retry-failed

View recent run and error logs:

node uploader.js --view-logs

View more log lines:

node uploader.js --view-logs --lines=200

## Output Files

- upload-log.json: structured per-file upload tracking
- uploaded-videos-db.json: uploaded video database for deduplication
- run.log: run timeline and retry events
- error.log: detailed error records

## Notes

- If upload is interrupted, run the script again to resume.
- If failures remain, use retry-failed mode.
- Use view-logs to inspect what failed and why.

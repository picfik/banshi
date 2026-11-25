import assert from "node:assert/strict";
import test from "node:test";
import { getInlinePreviewContentType } from "../shared/attachments.js";

test("identifies browser-previewable documents and images", () => {
  for (const [filename, contentType, expected] of [
    ["report.pdf", "application/pdf", "application/pdf"],
    ["notes.txt", "text/plain", "text/plain"],
    ["table.csv", "text/csv", "text/plain"],
    ["notes.md", "text/markdown", "text/plain"],
    ["scan.JPEG", "application/octet-stream", "image/jpeg"],
    ["diagram.svg", "image/svg+xml", "image/svg+xml"],
    ["photo.avif", "image/avif", "image/avif"],
    ["photo.tiff", "image/tiff", null],
    ["photo.heic", "image/heic", null],
    ["camera.cr3", "application/octet-stream", null],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", null],
    ["page.html", "text/html", null],
  ]) {
    assert.equal(getInlinePreviewContentType(filename, contentType), expected, filename);
  }
});

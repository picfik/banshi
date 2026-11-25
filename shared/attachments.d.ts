export const MAX_ATTACHMENT_SIZE_BYTES: number;
export const MAX_ATTACHMENT_TEXT_PREVIEW_CHARS: number;
export const SUPPORTED_ATTACHMENT_EXTENSIONS: readonly string[];
export function isSupportedAttachmentName(filename: string): boolean;
export function getInlinePreviewContentType(filename: string, contentType: string): string | null;

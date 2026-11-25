export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_PREVIEW_CHARS = 24_000;

export const SUPPORTED_ATTACHMENT_EXTENSIONS = Object.freeze([
  ".pdf",
  ".doc", ".dot", ".docx", ".docm", ".dotx", ".dotm", ".docb",
  ".xls", ".xlt", ".xla", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam",
  ".ppt", ".pot", ".pps", ".ppa", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam",
  ".odt", ".ott", ".oth", ".odm", ".fodt", ".ods", ".ots", ".fods", ".odp", ".otp", ".fodp",
  ".odg", ".otg", ".fodg", ".odf", ".odb", ".sxc", ".sxd", ".sxi", ".sxw",
  ".jpg", ".jpeg", ".jpe", ".jfif", ".pjpeg", ".pjp", ".png", ".apng", ".gif", ".bmp", ".dib",
  ".webp", ".avif", ".heic", ".heif", ".heics", ".heifs", ".hif", ".tif", ".tiff",
  ".ico", ".cur", ".icns", ".svg", ".svgz", ".wmf", ".emf",
  ".jp2", ".j2k", ".jpf", ".jpx", ".jpm", ".mj2", ".jxl", ".jxr", ".wdp", ".hdp",
  ".pcx", ".tga", ".targa", ".psd", ".psb", ".xcf", ".kra", ".ora",
  ".ppm", ".pgm", ".pbm", ".pnm", ".pam", ".xbm", ".xpm", ".qoi",
  ".hdr", ".exr", ".dds", ".ktx", ".ktx2", ".basis", ".bpg", ".flif",
  ".jng", ".mng", ".ras", ".sun", ".iff", ".lbm", ".ilbm", ".sgi", ".rgb", ".rgba", ".bw",
  ".fits", ".fit", ".fts", ".cin", ".dpx", ".pic", ".pict", ".pct", ".pntg",
  ".3fr", ".ari", ".arw", ".bay", ".cap", ".cr2", ".cr3", ".crw", ".dcs", ".dcr", ".dng",
  ".drf", ".eip", ".erf", ".fff", ".gpr", ".iiq", ".k25", ".kdc", ".mdc", ".mef", ".mos",
  ".mrw", ".nef", ".nrw", ".obm", ".orf", ".pef", ".ptx", ".pxn", ".r3d", ".raf", ".raw",
  ".rw2", ".rwl", ".rwz", ".sr2", ".srf", ".srw", ".x3f",
  ".wps", ".wpt", ".et", ".ett", ".dps", ".dpt", ".pages", ".numbers", ".key",
  ".txt", ".rtf", ".csv", ".tsv", ".md", ".markdown", ".rst", ".tex", ".latex", ".bib",
  ".html", ".htm", ".xhtml", ".xml", ".json", ".yaml", ".yml", ".log", ".ini", ".conf", ".cfg",
  ".properties", ".sql", ".epub", ".mobi", ".azw", ".azw3", ".djvu", ".djv", ".xps", ".oxps",
  ".ps", ".eps", ".vsd", ".vsdx", ".vss", ".vst", ".vdx", ".vsx", ".vssx", ".vstx",
  ".one", ".onepkg", ".pub", ".mpp", ".mpt", ".accdb", ".mdb", ".msg", ".eml", ".oft", ".pst", ".ost",
  ".wk1", ".wk3", ".wks", ".123", ".wpd", ".wp5", ".wp6", ".fb2", ".cbz", ".cbr", ".chm", ".lit",
  ".dwg", ".dxf", ".dgn", ".step", ".stp", ".iges", ".igs",
  ".zip", ".zipx", ".rar", ".7z", ".7zip", ".tar", ".gz", ".gzip", ".tgz", ".bz", ".bz2", ".bzip2",
  ".tbz", ".tbz2", ".xz", ".txz", ".z", ".lz", ".lzma", ".lzo", ".lz4", ".lzop", ".br",
  ".zst", ".zstd", ".tzst", ".cab", ".arj", ".ace", ".arc", ".lzh", ".lha", ".alz", ".egg",
  ".zpaq", ".zoo", ".taz", ".tz", ".tlz", ".wim", ".esd", ".001", ".jar",
  ".war", ".ear", ".cpio", ".sit", ".sitx", ".xar", ".iso", ".dmg",
]);

const supportedExtensions = new Set(SUPPORTED_ATTACHMENT_EXTENSIONS);
const previewableImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const previewableTextExtensions = new Set([
  ".txt", ".csv", ".tsv", ".md", ".markdown", ".rst", ".tex", ".latex", ".bib",
  ".xml", ".json", ".yaml", ".yml", ".log", ".ini", ".conf", ".cfg", ".properties", ".sql",
]);
const previewableImageExtensions = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".jpe", "image/jpeg"], [".jfif", "image/jpeg"],
  [".pjpeg", "image/jpeg"], [".pjp", "image/jpeg"],
  [".png", "image/png"], [".apng", "image/png"], [".gif", "image/gif"], [".webp", "image/webp"],
  [".bmp", "image/bmp"], [".dib", "image/bmp"], [".avif", "image/avif"],
  [".svg", "image/svg+xml"], [".ico", "image/x-icon"], [".cur", "image/x-icon"],
]);

export function isSupportedAttachmentName(filename) {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return supportedExtensions.has(extension);
}

export function getInlinePreviewContentType(filename, contentType) {
  const normalizedType = contentType?.split(";")[0].trim().toLowerCase();
  if (normalizedType === "application/pdf" || normalizedType === "text/plain") return normalizedType;
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (previewableTextExtensions.has(extension)) return "text/plain";
  return previewableImageExtensions.get(extension) ??
    (previewableImageTypes.has(normalizedType) ? normalizedType : null);
}

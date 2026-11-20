export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_PREVIEW_CHARS = 24_000;

export const SUPPORTED_ATTACHMENT_EXTENSIONS = Object.freeze([
  ".pdf",
  ".doc", ".dot", ".docx", ".docm", ".dotx", ".dotm", ".docb",
  ".xls", ".xlt", ".xla", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam",
  ".ppt", ".pot", ".pps", ".ppa", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam",
  ".odt", ".ott", ".oth", ".odm", ".fodt", ".ods", ".ots", ".fods", ".odp", ".otp", ".fodp",
  ".odg", ".otg", ".fodg", ".odf", ".odb", ".sxc", ".sxd", ".sxi", ".sxw",
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

export function isSupportedAttachmentName(filename) {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return supportedExtensions.has(extension);
}

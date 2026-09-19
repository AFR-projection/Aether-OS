/**
 * Which application opens which file.
 *
 * A desktop that sends every double-click to a text editor is not a desktop.
 * The rule here is deliberately the same one a real file manager uses: the name
 * decides first, because an extension is what a user sees and what other
 * programs trust, and the server's `mimeType` breaks the tie when the name says
 * nothing — which on a real machine is often, since `/etc/hostname`, `.env` and
 * `Dockerfile` all have no useful extension.
 *
 * Both signals are read the same way they are on the server: an extension or a
 * content type can promote a file into a viewer, and neither can demote one out
 * of the editor.
 */

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'binary';

const EXTENSION_KINDS: Record<string, FileKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.avif': 'image',
  '.ico': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.mov': 'video',
  '.avi': 'video',
  // `.m4v` and `.m4a` are the same container with different payloads; the
  // browser picks the right decoder from the bytes, so the name only decides
  // which element gets asked.
  '.m4v': 'video',
  '.m4a': 'audio',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  '.pdf': 'pdf',
  '.zip': 'archive',
  '.gz': 'archive',
  '.tar': 'archive',
  '.tgz': 'archive',
  '.bz2': 'archive',
  '.xz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
};

/** The extension of a lowercase name, or an empty string when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file (`.env`), not an extension.
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Classifies a file for the purpose of choosing an application.
 *
 * `mimeType` is what the server reported for the bytes it actually read, so it
 * is authoritative when the name is not. `encoding` is the server's verdict on
 * the bytes themselves and is the final word on whether the editor can open a
 * file at all.
 */
export function classifyFile(input: {
  name: string;
  mimeType?: string | undefined;
  encoding?: 'utf8' | 'base64' | undefined;
}): FileKind {
  const extension = extensionOf(input.name);
  const byName = EXTENSION_KINDS[extension];
  if (byName !== undefined) return byName;

  const mime = input.mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';

  // The bytes were readable as text, which trumps everything except a format
  // already recognised above — an SVG is text that happens to be a picture.
  if (input.encoding === 'utf8') return 'text';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (mime === 'application/zip' || mime === 'application/gzip') return 'archive';

  return 'binary';
}

/** True when the file should open in the Media Viewer rather than the editor. */
export function isViewable(kind: FileKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
}

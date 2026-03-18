import type { FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';

export interface LocalAttachmentInfo {
  accessibleFiles: FileAttachment[];
  inaccessibleFiles: FileAttachment[];
}

function quotePath(filePath: string): string {
  return JSON.stringify(filePath);
}

function describeFile(file: FileAttachment): string {
  const segments = [file.name];
  if (file.type) {
    segments.push(file.type);
  }
  if (typeof file.size === 'number' && Number.isFinite(file.size)) {
    segments.push(`${file.size} bytes`);
  }
  return segments.join(' | ');
}

export function splitLocalAttachments(files?: FileAttachment[]): LocalAttachmentInfo {
  const list = files ?? [];
  return {
    accessibleFiles: list.filter((file) => typeof file.filePath === 'string' && file.filePath.trim().length > 0),
    inaccessibleFiles: list.filter((file) => !file.filePath || !file.filePath.trim()),
  };
}

export function buildLocalAttachmentSystemNote(files?: FileAttachment[]): string {
  const { accessibleFiles, inaccessibleFiles } = splitLocalAttachments(files);

  if (accessibleFiles.length === 0 && inaccessibleFiles.length === 0) {
    return '';
  }

  const sections: string[] = [];

  if (accessibleFiles.length > 0) {
    const lines = accessibleFiles.map((file, index) => {
      const filePath = file.filePath as string;
      return `${index + 1}. ${describeFile(file)}\n   Path: ${quotePath(filePath)}`;
    });

    sections.push([
      `[System note: The user attached ${accessibleFiles.length} file(s) that have been saved into the working directory for you.]`,
      'Read the relevant files directly from these local paths before answering or modifying code:',
      ...lines,
    ].join('\n'));
  }

  if (inaccessibleFiles.length > 0) {
    sections.push(`[System note: ${inaccessibleFiles.length} attachment(s) could not be written to a local path, so inspect them only if their content is already present elsewhere in the conversation.]`);
  }

  return sections.join('\n\n');
}

export function appendLocalAttachmentSystemNote(prompt: string, files?: FileAttachment[]): string {
  const note = buildLocalAttachmentSystemNote(files);
  if (!note) {
    return prompt;
  }
  return `${prompt}${prompt.trim() ? '\n\n' : ''}${note}`;
}

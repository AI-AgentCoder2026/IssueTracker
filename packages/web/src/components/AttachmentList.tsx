import { useRef, useState } from 'react';
import { issueApi } from '../api/repo';
import { formatBytes, formatDateTime } from '../lib/format';
import type { IssueAttachment, IssueId } from '../api/types';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { useToast } from './Toast';

export interface AttachmentListProps {
  issueId: IssueId;
  attachments: IssueAttachment[];
  isLoading: boolean;
  onChanged: () => void;
  canUpload?: boolean;
  canDelete?: boolean;
}

/** File list with drag-and-drop upload, per-file delete and a download link. */
export function AttachmentList({
  issueId,
  attachments,
  isLoading,
  onChanged,
  canUpload = true,
  canDelete = true,
}: AttachmentListProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  const upload = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    setUploading(true);
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        await issueApi.uploadAttachment(issueId, file);
      } catch (error) {
        failed += 1;
        toast.apiError(error);
      }
    }
    setUploading(false);
    if (failed === 0) {
      toast.success(files.length === 1 ? 'File uploaded' : `${files.length} files uploaded`);
      onChanged();
    }
  };

  return (
    <div className="stack-sm">
      {isLoading ? (
        <p className="subtle">Loading attachments…</p>
      ) : attachments.length === 0 ? (
        <EmptyState
          icon="📎"
          title="No attachments"
          description="Drop a file here or use the button to attach one."
        />
      ) : (
        <div className="link-list">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="link-row">
              <span className="row grow" style={{ gap: 8, minWidth: 0 }}>
                <span aria-hidden="true">📄</span>
                <a
                  className="truncate"
                  href={issueApi.attachmentUrl(attachment.id)}
                  target="_blank"
                  rel="noreferrer"
                  title={attachment.filename}
                >
                  {attachment.filename}
                </a>
                <span className="subtle nowrap">
                  {formatBytes(attachment.sizeBytes)} · {formatDateTime(attachment.createdAt)}
                </span>
              </span>
              {canDelete ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete attachment ${attachment.filename}`}
                  onClick={async () => {
                    try {
                      await issueApi.removeAttachment(attachment.id);
                      toast.success('Attachment deleted');
                      onChanged();
                    } catch (error) {
                      toast.apiError(error);
                    }
                  }}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canUpload ? (
        <div
          className="row"
          style={{
            padding: 12,
            border: isDragging ? '1px dashed var(--accent)' : '1px dashed var(--border)',
            borderRadius: 'var(--radius-md)',
            background: isDragging ? 'var(--accent-soft)' : 'transparent',
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            void upload(event.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            id={`attachment-input-${issueId}`}
            type="file"
            multiple
            className="visually-hidden"
            onChange={(event) => {
              void upload(event.target.files);
              event.target.value = '';
            }}
          />
          <Button size="sm" onClick={() => inputRef.current?.click()} loading={uploading}>
            Attach files
          </Button>
          <span className="subtle">or drop them here</span>
        </div>
      ) : null}
    </div>
  );
}

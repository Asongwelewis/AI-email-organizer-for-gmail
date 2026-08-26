import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import type { UserLabel } from '@web/types/labels';

/**
 * Renaming and removing a folder.
 *
 * Both endpoints have existed since stage 2 with nothing calling them, so a folder whose name read
 * badly was permanent. Neither is a cosmetic operation:
 *
 *   - renaming a folder renames **every Gmail label beneath it**, because the tree lives in the
 *     database and only a leaf's full path exists in Gmail;
 *   - removing one does **not** unlabel the mail under it. Deleting a Gmail label never does, so
 *     the messages keep a label the folder list no longer explains. The dialog says so rather than
 *     letting a person discover it in their mailbox.
 */
export function FolderActions({ folder }: { folder: UserLabel }) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.leafName);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.labels });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pivotPlan });
  };

  const renameMutation = useMutation({
    mutationFn: (leafName: string) => api.renameLabel(folder.id, leafName),
    onSuccess: () => {
      setRenaming(false);
      settled();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteLabel(folder.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      settled();
    },
  });

  const trimmed = name.trim();

  return (
    <div className="folder-actions">
      {renaming ? (
        <form
          className="folder-actions__rename"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && trimmed !== folder.leafName) renameMutation.mutate(trimmed);
            else setRenaming(false);
          }}
        >
          <label className="sr-only" htmlFor={`rename-${folder.id}`}>
            Folder name
          </label>
          <input
            id={`rename-${folder.id}`}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={renameMutation.isPending}
          >
            Save
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => {
              setName(folder.leafName);
              setRenaming(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button className="button button--quiet" type="button" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setConfirmingDelete(true)}
          >
            Remove
          </button>
        </>
      )}

      {renameMutation.isError ? <ErrorNotice error={renameMutation.error} /> : null}
      {deleteMutation.isError ? <ErrorNotice error={deleteMutation.error} /> : null}

      <ConfirmDialog
        open={confirmingDelete}
        destructive
        busy={deleteMutation.isPending}
        title={`Remove ${folder.leafName}?`}
        description={
          'The folder disappears from MailMind, but the mail already filed into it keeps its Gmail label — deleting a label never unlabels the mail beneath it. Use the label sweep to clear those.'
        }
        confirmLabel="Remove folder"
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

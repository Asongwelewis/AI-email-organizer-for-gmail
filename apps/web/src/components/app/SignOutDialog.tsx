import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { MagneticButton } from '@web/components/MagneticButton';
import { useAuth } from '@web/context/useAuth';
import { api } from '@web/services/http';

/**
 * Signing out is where a person decides what happens to their data.
 *
 * AMO keeps nothing a person did not choose to leave behind: every sign-out offers to keep the
 * data — so the folders are waiting at the next sign-in with the same Google account — or to delete
 * all of it, which is the same irreversible deletion as the data-deletion page (Google access
 * revoked first, then every message, folder and decision removed). Deleting takes a second tap,
 * because there is no undo.
 */
export function useSignOut() {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failed, setFailed] = useState(false);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirmingDelete(false);
    setFailed(false);
  };

  const keep = async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await api.deleteAccount();
      // The server already ended the session; this clears what the browser still remembers.
      await logout().catch(() => undefined);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const dialog = (
    <SignOutDialog
      open={open}
      busy={busy}
      confirmingDelete={confirmingDelete}
      failed={failed}
      onKeep={() => void keep()}
      onDelete={() => void remove()}
      onCancel={close}
    />
  );
  return { requestSignOut: () => setOpen(true), dialog };
}

function SignOutDialog({
  open,
  busy,
  confirmingDelete,
  failed,
  onKeep,
  onDelete,
  onCancel,
}: {
  open: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  failed: boolean;
  onKeep: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    keepRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onCancel();
          }}
        >
          <motion.div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sign-out-title"
            aria-describedby="sign-out-description"
            initial={{ opacity: 0, y: 22, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
          >
            <span className="eyebrow">Your data stays yours</span>
            <h2 id="sign-out-title">Sign out of AMO</h2>
            <p id="sign-out-description">
              {confirmingDelete
                ? 'This permanently deletes your AMO account, every stored email detail, folder and classification, and revokes AMO’s access to your Gmail. It cannot be undone. Your mail itself stays in Gmail.'
                : 'Keep your data and your folders will be waiting next time you sign in with this Google account. Or delete everything AMO stores about you, permanently.'}
            </p>
            {failed ? (
              <p className="sign-out__error" role="alert">
                Your data could not be deleted, so you are still signed in. Please try again.
              </p>
            ) : null}
            <div className="confirm-dialog__actions">
              <MagneticButton variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </MagneticButton>
              <MagneticButton variant="danger" onClick={onDelete} disabled={busy}>
                {confirmingDelete
                  ? busy
                    ? 'Deleting…'
                    : 'Yes, delete everything'
                  : 'Delete my data'}
              </MagneticButton>
              {confirmingDelete ? null : (
                <MagneticButton ref={keepRef} variant="ink" onClick={onKeep} disabled={busy}>
                  {busy ? 'Signing out…' : 'Keep my data'}
                </MagneticButton>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

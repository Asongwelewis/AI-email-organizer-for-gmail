import { useMemo, useState } from 'react';
import { Check, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { MagneticButton } from '@web/components/MagneticButton';
import { InfoTooltip, WorkflowRail } from '@web/components/ProductWorkflow';
import { RouteLoader } from '@web/components/RouteLoader';
import { useGmailSyncStatusQuery } from '@web/queries/gmailQueries';
import { useLabelActions, useLabels } from '@web/queries/labelsQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import type { ConfirmLabelInput, LabelSource } from '@web/types/labels';

interface DraftLabel {
  key: string;
  leafName: string;
  source: LabelSource;
}

export function LabelsPage() {
  const labels = useLabels();
  const sync = useGmailSyncStatusQuery(true);
  const actions = useLabelActions();
  const [drafts, setDrafts] = useState<DraftLabel[] | null>(null);
  const [customName, setCustomName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [proposalOutcome, setProposalOutcome] = useState<'EMPTY' | null>(null);

  const proposals = labels.data?.proposals;
  const approved = labels.data?.labels ?? [];
  const maxLabels = labels.data?.maxLabels ?? 25;

  // Proposals seed the editable draft; approved labels are already live in Gmail.
  const workingSet = useMemo<DraftLabel[]>(
    () =>
      drafts ??
      (proposals ?? []).map((proposal) => ({
        key: proposal.id,
        leafName: proposal.leafName,
        source: 'AI_PROPOSED' as const,
      })),
    [drafts, proposals],
  );

  if (labels.isLoading) return <RouteLoader label="Loading your labels" />;

  // A failed read must say so. Rendering the empty state here is what made a broken
  // labels flow look like an account that simply had no labels yet.
  if (labels.isError) {
    return (
      <div className="labels-page">
        <header className="page-heading">
          <div>
            <span className="eyebrow">Step 2 · Your labels</span>
            <h1>Your labels could not be loaded</h1>
          </div>
        </header>
        <section className="labels-panel" aria-labelledby="labels-error-title">
          <h2 id="labels-error-title" className="visually-hidden">
            Error details
          </h2>
          <p className="labels-error" role="alert">
            {getSafeErrorMessage(labels.error, 'The labels service did not respond.')}
          </p>
          <div className="labels-actions">
            <MagneticButton onClick={() => void labels.refetch()}>Try again</MagneticButton>
          </div>
        </section>
      </div>
    );
  }

  const update = (next: DraftLabel[]) => setDrafts(next);

  const propose = async () => {
    try {
      const result = await actions.propose.mutateAsync();
      setDrafts(null);
      // An empty set is not a success. Say what happened instead of implying work was done.
      if (result.proposals.length === 0) {
        setProposalOutcome('EMPTY');
        return;
      }
      setProposalOutcome(null);
      toast.success(
        `${result.proposals.length} label ${
          result.proposals.length === 1 ? 'proposal is' : 'proposals are'
        } ready for your review.`,
      );
    } catch (error) {
      setProposalOutcome(null);
      toast.error(getSafeErrorMessage(error, 'Labels could not be proposed.'));
    }
  };

  const addCustom = () => {
    const leafName = customName.trim();
    if (!leafName) return;
    if (workingSet.length >= maxLabels) {
      toast.error(`This account is limited to ${maxLabels} labels.`);
      return;
    }
    update([...workingSet, { key: `custom-${Date.now()}`, leafName, source: 'USER_CREATED' }]);
    setCustomName('');
  };

  const confirm = async () => {
    const payload: ConfirmLabelInput[] = workingSet.map((label) => ({
      leafName: label.leafName.trim(),
      source: label.source,
    }));
    try {
      await actions.confirm.mutateAsync(payload);
      setDrafts(null);
      setConfirming(false);
      toast.success('Labels confirmed and created in Gmail.');
    } catch (error) {
      setConfirming(false);
      toast.error(getSafeErrorMessage(error, 'Labels could not be confirmed.'));
    }
  };

  const busy = actions.propose.isPending || actions.confirm.isPending;
  const syncedMessages = sync.data?.syncedMessages ?? 0;

  return (
    <div className="labels-page" data-tutorial="labels-hero">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Step 2 · Your labels</span>
          <h1>Decide how MailMind files your mail</h1>
          <p>
            MailMind reads your synchronized metadata and proposes a label set. Nothing reaches
            Gmail until you confirm, and automation may only use labels you approved.
          </p>
        </div>
        <MagneticButton onClick={() => void propose()} disabled={busy}>
          <Sparkles aria-hidden="true" />
          {(proposals?.length ?? 0) > 0 ? 'Propose again' : 'Propose labels'}
        </MagneticButton>
      </header>

      <WorkflowRail current="labels" sync={sync.data} />

      <section className="labels-panel" aria-labelledby="approved-title">
        <div className="labels-panel__heading">
          <div>
            <span className="eyebrow">Approved</span>
            <h2 id="approved-title">Live in Gmail</h2>
          </div>
          <span>
            {approved.length} of {maxLabels} labels
            <InfoTooltip label="Approved labels">
              Automation files every message into exactly one of these labels, or leaves it in the
              inbox when none of them fit.
            </InfoTooltip>
          </span>
        </div>
        {approved.length === 0 ? (
          <p className="labels-empty">
            No labels yet.{' '}
            {syncedMessages > 0
              ? 'Propose a set below to get started.'
              : 'Synchronize Gmail first, then propose a set.'}
          </p>
        ) : (
          <ul className="labels-list">
            {approved.map((label) => (
              <ApprovedLabelRow key={label.id} id={label.id} leafName={label.leafName} />
            ))}
          </ul>
        )}
      </section>

      <section className="labels-panel" aria-labelledby="proposed-title">
        <div className="labels-panel__heading">
          <div>
            <span className="eyebrow">Proposed</span>
            <h2 id="proposed-title">Review before anything is created</h2>
          </div>
          <span>{workingSet.length} pending</span>
        </div>
        {workingSet.length === 0 ? (
          proposalOutcome === 'EMPTY' ? (
            <p className="labels-empty" role="status">
              That run analyzed your synchronized mail and found nothing above the confidence
              threshold, so no labels were proposed. Synchronize more mail, or add your own label
              below and confirm it.
            </p>
          ) : (
            <p className="labels-empty">
              No pending proposals. Use Propose labels to analyze your synchronized mail.
            </p>
          )
        ) : (
          <ul className="labels-list">
            {workingSet.map((draft, index) => (
              <li key={draft.key} className="labels-row">
                <label className="labels-row__name">
                  <span className="visually-hidden">Label name</span>
                  <input
                    value={draft.leafName}
                    onChange={(event) => {
                      const next = [...workingSet];
                      next[index] = { ...draft, leafName: event.target.value };
                      update(next);
                    }}
                  />
                </label>
                <span className="labels-row__source">
                  {draft.source === 'AI_PROPOSED' ? 'Proposed' : 'Custom'}
                </span>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove ${draft.leafName}`}
                  onClick={() => update(workingSet.filter((item) => item.key !== draft.key))}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="labels-add">
          <label>
            <span className="visually-hidden">Add a custom label</span>
            <input
              value={customName}
              placeholder="Add your own label"
              onChange={(event) => setCustomName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustom();
                }
              }}
            />
          </label>
          <button type="button" onClick={addCustom} disabled={!customName.trim()}>
            <Plus aria-hidden="true" /> Add
          </button>
        </div>

        <div className="labels-actions">
          <MagneticButton
            onClick={() => setConfirming(true)}
            disabled={busy || workingSet.length === 0}
          >
            <Check aria-hidden="true" />
            Confirm and create in Gmail
          </MagneticButton>
          <small>
            Confirming creates each label in Gmail as <code>MailMind/&lt;name&gt;</code>. Existing
            mail is not moved by this step.
          </small>
        </div>
      </section>

      <ConfirmDialog
        open={confirming}
        title="Create these labels in Gmail?"
        description={`MailMind will create ${workingSet.length} label${
          workingSet.length === 1 ? '' : 's'
        } in your Gmail account. No messages are moved or relabeled by this action.`}
        confirmLabel="Create labels"
        busy={actions.confirm.isPending}
        onConfirm={() => void confirm()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function ApprovedLabelRow({ id, leafName }: { id: string; leafName: string }) {
  const actions = useLabelActions();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(leafName);
  const [removing, setRemoving] = useState(false);

  const rename = async () => {
    try {
      await actions.rename.mutateAsync({ id, leafName: name.trim() });
      setEditing(false);
      toast.success('Label renamed in MailMind and Gmail.');
    } catch (error) {
      toast.error(getSafeErrorMessage(error, 'The label could not be renamed.'));
    }
  };

  const remove = async () => {
    try {
      await actions.remove.mutateAsync(id);
      setRemoving(false);
      toast.success('Label removed from MailMind. The Gmail label was left in place.');
    } catch (error) {
      setRemoving(false);
      toast.error(getSafeErrorMessage(error, 'The label could not be removed.'));
    }
  };

  return (
    <li className="labels-row">
      {editing ? (
        <label className="labels-row__name">
          <span className="visually-hidden">Rename {leafName}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
      ) : (
        <span className="labels-row__name">MailMind/{leafName}</span>
      )}
      <div className="labels-row__controls">
        {editing ? (
          <>
            <button type="button" onClick={() => void rename()} disabled={actions.rename.isPending}>
              Save
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setName(leafName);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            Rename
          </button>
        )}
        <button
          type="button"
          className="quiet"
          aria-label={`Delete ${leafName}`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
      <ConfirmDialog
        open={removing}
        title={`Stop using MailMind/${leafName}?`}
        description="MailMind stops filing mail under this label. The Gmail label and every message already filed under it stay exactly where they are."
        confirmLabel="Stop using it"
        destructive
        busy={actions.remove.isPending}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(false)}
      />
    </li>
  );
}

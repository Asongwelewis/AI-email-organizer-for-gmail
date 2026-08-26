import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ renameLabel: vi.fn(), deleteLabel: vi.fn() }));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { FolderActions } from './FolderActions';
import type { UserLabel } from '@web/types/labels';

const folder = {
  id: 'label-1',
  parentId: null,
  depth: 1,
  leafName: 'Netflix',
  path: 'MailMind/Netflix',
  gmailLabelId: 'Label_1',
} as unknown as UserLabel;

/**
 * Both endpoints existed since stage 2 with nothing calling them, so a folder whose name read
 * badly was permanent. Neither operation is cosmetic, which is most of what these tests pin.
 */
describe('FolderActions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.renameLabel.mockResolvedValue({ ...folder, leafName: 'Netflix billing' });
    mocks.deleteLabel.mockResolvedValue(undefined);
  });

  it('renames a folder to what was typed', async () => {
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Folder name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Netflix billing');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.renameLabel).toHaveBeenCalledWith('label-1', 'Netflix billing'),
    );
  });

  // Renaming a folder renames every Gmail label beneath it, so a no-op rename is a remote write
  // for nothing. It closes the form instead.
  it('does not call the server when the name did not change', async () => {
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.renameLabel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
  });

  it('abandons a rename without writing anything', async () => {
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.type(screen.getByLabelText('Folder name'), ' something');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.renameLabel).not.toHaveBeenCalled();
  });

  /**
   * The thing a person would otherwise discover in their own mailbox: deleting a Gmail label never
   * unlabels the mail beneath it, so removing a folder leaves those messages wearing a label the
   * folder list no longer explains.
   */
  it('warns that removing a folder leaves its mail labelled', async () => {
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText(/keeps its Gmail label/i)).toBeInTheDocument();
    expect(mocks.deleteLabel).not.toHaveBeenCalled();
  });

  it('removes the folder only after the warning is accepted', async () => {
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(await screen.findByRole('button', { name: /remove folder/i }));

    await waitFor(() => expect(mocks.deleteLabel).toHaveBeenCalledWith('label-1'));
  });

  it('shows the server code when a rename is refused', async () => {
    mocks.renameLabel.mockRejectedValue(
      apiError('LABEL_VALIDATION_FAILED', 'A sibling already has that name.', 422),
    );
    renderScreen(<FolderActions folder={folder} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Folder name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Taken');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('LABEL_VALIDATION_FAILED');
  });
});

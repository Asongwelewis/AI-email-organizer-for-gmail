import { useRef, useState, type FormEvent } from 'react';
import { Check, Send } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, useLocation } from 'react-router-dom';

import { MOTION, useEntrance } from '@web/lib/motion';
import { api } from '@web/services/http';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import { FEEDBACK_KINDS, type FeedbackKind } from '@web/types/feedback';

/** What each bucket means, in the sender's words rather than the schema's. */
const KIND_LABELS: Record<FeedbackKind, string> = {
  PROBLEM: 'Something is broken',
  IDEA: 'I have an idea',
  PRAISE: 'This is good',
  OTHER: 'Something else',
};

/** Mirrors the server's bound and the table's check constraint. */
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 4000;

/**
 * Somewhere for a person who was handed the link to say something back.
 *
 * Public, and signed-out by design: the people whose opinion is most worth having are the ones who
 * bounced off the app before making an account. It replaces a `mailto:` that pointed at a
 * placeholder address, so until the operator details in `legal-contact.ts` are filled in this is
 * the only working way to reach whoever runs this deployment.
 */
export function FeedbackPage() {
  const entrance = useEntrance();
  const location = useLocation();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [kind, setKind] = useState<FeedbackKind>('PROBLEM');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  /*
   * The route the visitor came from, when a link passed one. Narrowed rather than coerced: router
   * state is whatever the last navigation put there, and `String(undefined)` is the string
   * "undefined", which the server rejects — turning a missing nicety into a failed submission.
   * Someone who typed the URL in directly simply has no origin to report.
   */
  const from = (location.state as { from?: unknown } | null)?.from;
  const page = typeof from === 'string' && from.startsWith('/') ? from.split('?')[0] : undefined;

  const remaining = MAX_MESSAGE - message.trim().length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    /*
     * Validated on submit rather than on every keystroke: telling somebody their sentence is too
     * short while they are still typing it is the form arguing with them mid-thought.
     */
    const trimmed = message.trim();
    if (trimmed.length < MIN_MESSAGE) {
      setFieldError(`A sentence or two, please — at least ${MIN_MESSAGE} characters.`);
      messageRef.current?.focus();
      return;
    }
    setFieldError(null);
    setStatus('sending');

    try {
      await api.sendFeedback({
        kind,
        message: trimmed,
        // Empty means they did not want a reply, which is a choice rather than a missing value.
        ...(contact.trim() ? { contact: contact.trim() } : {}),
        ...(page ? { page } : {}),
      });
      setStatus('sent');
    } catch (error) {
      setStatus('idle');
      setSubmitError(
        getSafeErrorMessage(error, 'That did not send. Check your connection and try again.'),
      );
    }
  }

  return (
    <main className="legal-doc">
      <div className="legal-doc__column">
        <Link className="legal-doc__back" to="/">
          ← MailMind AI
        </Link>
        <h1>Send feedback</h1>

        <AnimatePresence mode="wait" initial={false}>
          {status === 'sent' ? (
            /*
             * A crossfade in place, not a redirect. Where the form was is exactly where somebody
             * is looking, and a navigation would cost them the page they were on.
             */
            <motion.div
              key="sent"
              className="feedback-sent"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: MOTION.duration.base, ease: MOTION.ease.out }}
            >
              <Check aria-hidden="true" />
              <h2>Sent. Thank you.</h2>
              <p>
                {contact.trim()
                  ? `If a reply is needed, it will go to ${contact.trim()}.`
                  : 'You did not leave an address, so there will not be a reply — but it was read.'}
              </p>
              <Link className="button" to="/">
                Back to the start
              </Link>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              className="feedback-form"
              onSubmit={(event) => void submit(event)}
              noValidate
              exit={{ opacity: 0, transition: { duration: MOTION.duration.fast } }}
            >
              <motion.p className="legal-doc__updated" {...entrance(0)}>
                Broken, confusing, or missing something? This goes straight to whoever runs this
                deployment. No account needed.
              </motion.p>

              <motion.fieldset className="feedback-kinds" {...entrance(1)}>
                <legend>What kind of note is this?</legend>
                {FEEDBACK_KINDS.map((option) => (
                  <label
                    key={option}
                    className={`feedback-kind${kind === option ? ' feedback-kind--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={option}
                      checked={kind === option}
                      onChange={() => setKind(option)}
                    />
                    {KIND_LABELS[option]}
                  </label>
                ))}
              </motion.fieldset>

              <motion.div className="feedback-field" {...entrance(2)}>
                <label htmlFor="feedback-message">
                  What happened? <span aria-hidden="true">*</span>
                </label>
                <p className="feedback-help" id="feedback-message-help">
                  If something went wrong, the error code MailMind showed you is the single most
                  useful thing to include.
                </p>
                <textarea
                  id="feedback-message"
                  ref={messageRef}
                  rows={7}
                  required
                  maxLength={MAX_MESSAGE}
                  value={message}
                  aria-describedby="feedback-message-help feedback-message-count"
                  aria-invalid={fieldError ? true : undefined}
                  aria-errormessage={fieldError ? 'feedback-message-error' : undefined}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    // Clear on edit: an error that outlives the thing it described is just noise.
                    if (fieldError) setFieldError(null);
                  }}
                />
                <div className="feedback-field__foot">
                  {/* Below the field it describes, per the error-placement rule. */}
                  {fieldError ? (
                    <span className="feedback-error" id="feedback-message-error" role="alert">
                      {fieldError}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span
                    className="feedback-count"
                    id="feedback-message-count"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {remaining < 200 ? `${remaining} characters left` : ''}
                  </span>
                </div>
              </motion.div>

              <motion.div className="feedback-field" {...entrance(3)}>
                <label htmlFor="feedback-contact">Your email, if you want an answer</label>
                <p className="feedback-help" id="feedback-contact-help">
                  Optional. Leave it blank and this stays anonymous — nothing else about you is
                  recorded either way.
                </p>
                <input
                  id="feedback-contact"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={320}
                  value={contact}
                  aria-describedby="feedback-contact-help"
                  onChange={(event) => setContact(event.target.value)}
                />
              </motion.div>

              {submitError ? (
                <p className="feedback-error feedback-error--form" role="alert">
                  {submitError}
                </p>
              ) : null}

              <motion.div className="feedback-actions" {...entrance(4)}>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={status === 'sending'}
                >
                  <Send aria-hidden="true" />
                  {status === 'sending' ? 'Sending…' : 'Send feedback'}
                </button>
                <Link className="button button--quiet" to="/support">
                  Read the support notes first
                </Link>
              </motion.div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}

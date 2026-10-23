import { ArrowRight, Check, LockKeyhole, MousePointer2 } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { Link } from 'react-router-dom';

import heroImage from '@web/assets/mailmind-editorial-hero.png';
import { AmoLogo } from '@web/components/AmoLogo';
import { BrandMark } from '@web/components/BrandMark';
import { MOTION, useEntrance, useReveal } from '@web/lib/motion';

/*
 * Measured on the founder's own Gmail in October 2026: 11,388 stored messages, of which 11,245 are
 * the kind AMO sorts (not drafts, sent mail, spam or trash). Every number below is from that
 * mailbox, and the page says so, because a number with no source is a claim.
 */
const CLASSIFICATION_FACTS = [
  { value: '11,244', label: 'of 11,245 emails classified' },
  { value: '93%', label: 'correct in a hand-checked sample' },
  { value: '< 1 min', label: 'from arrival to its folder' },
] as const;

const principles = [
  {
    number: '01',
    title: 'Classified',
    copy: 'Every email is given its sender, its area of life and what it is for — a receipt, a job match, a security alert — by smart classification built from AI-labelled examples. No AI model ever reads your mail.',
    facts: CLASSIFICATION_FACTS,
  },
  {
    number: '02',
    title: 'Automated',
    copy: 'AMO checks your Gmail every minute. A new email is classified and filed into its folder the moment it arrives — no buttons to press, no queue to clear, nothing to approve.',
  },
  {
    number: '03',
    title: 'Permission on your terms',
    copy: 'Google sign-in and Gmail access stay separate, read-only, and yours to revoke. Your data stays yours: when you sign out, keep it for next time or delete every trace of it from AMO.',
  },
] as const;

const workflow = [
  {
    title: 'Sign in with Google.',
    copy: 'Create your AMO identity using your basic Google profile. This step does not grant Gmail access.',
  },
  {
    title: 'Connect Gmail.',
    copy: "Grant read-only Gmail access separately. AMO reads the sender, subject, date and Gmail's preview line — never the body of an email or an attachment.",
  },
  {
    title: 'Your mail is classified.',
    copy: 'The moment you connect, AMO classifies the last two years of your mail on the free plan — and every new email after that, automatically.',
  },
  {
    title: 'Organized into folders.',
    copy: 'Classified mail is filed into folders by sender, area of life and purpose, ready to browse and search as soon as classification finishes.',
  },
] as const;

export function LandingPage() {
  const reduceMotion = useReducedMotion();
  const entrance = useEntrance();
  const reveal = useReveal();
  const { scrollYProgress } = useScroll();
  /*
   * Parallax is the one effect most likely to make somebody feel unwell, so it is the first thing
   * to go when they have asked for less motion. Held to 54px: enough to give the hero some depth,
   * not enough to detach the image from the words beside it.
   */
  const imageY = useTransform(scrollYProgress, [0, 0.45], [0, reduceMotion ? 0 : 54]);

  return (
    <>
      <section className="landing-hero">
        <div className="landing-hero__copy">
          <motion.div className="landing-kicker" {...entrance(0)}>
            <span /> An automated, classified mail organizer
          </motion.div>
          <motion.h1 className="landing-hero__logo" {...entrance(1)}>
            <AmoLogo />
            <span className="sr-only">AMO</span>
          </motion.h1>
          <motion.p className="landing-hero__promise" {...entrance(2)}>
            Your mail, classified and organized,
            <br />
            automatically.
          </motion.p>
          <motion.p className="landing-hero__lede" {...entrance(3)}>
            AMO classifies every email the moment it reaches your inbox and organizes it into
            folders for you — by sender, area of life and purpose. It works only from what your
            inbox list already shows, so the body of your mail is never read, and your data stays
            yours.
          </motion.p>
          <motion.div className="landing-hero__actions" {...entrance(4)}>
            <Link className="cta-link" to="/login" data-cursor>
              Begin with Google <ArrowRight aria-hidden="true" />
            </Link>
            <span className="privacy-note">
              <LockKeyhole aria-hidden="true" /> No Gmail access at sign-in
            </span>
          </motion.div>
        </div>

        {/*
          Was a 1.15s clip-path wipe. Clip-path is not a compositor-only property, so it repainted
          a full-bleed image every frame, and the duration was nearly three times the ceiling for
          an elaborate move. Opacity and a small scale say the same thing, on the GPU, in 400ms.
        */}
        <motion.figure
          className="landing-hero__visual"
          {...(reduceMotion
            ? {}
            : {
                initial: { opacity: 0, scale: 1.04 },
                animate: { opacity: 1, scale: 1 },
                transition: { duration: MOTION.duration.slow, ease: MOTION.ease.out, delay: 0.08 },
              })}
          style={{ y: imageY }}
        >
          <img
            src={heroImage}
            alt="Artful paper correspondence arranged into an organized filing system"
          />
          <figcaption>
            <span>AMO study № 01</span>
            <span>Order without overreach</span>
          </figcaption>
        </motion.figure>

        <div className="scroll-cue" aria-hidden="true">
          <MousePointer2 /> <span>Scroll to unfold</span>
        </div>
      </section>

      <section className="principles-section" id="principles" aria-labelledby="principles-title">
        <motion.div className="section-intro" {...reveal()}>
          <span className="eyebrow">The operating principles</span>
          <h2 id="principles-title" aria-label="Made to classify. Built to organize.">
            Made to classify.
            <br />
            Built to organize.
          </h2>
        </motion.div>
        <div className="principles-grid">
          {principles.map((principle, index) => (
            <motion.article key={principle.number} className="principle-card" {...reveal(index)}>
              <span className="principle-card__number">{principle.number}</span>
              <h3>{principle.title}</h3>
              <p>{principle.copy}</p>
              {'facts' in principle ? (
                <>
                  <dl className="principle-card__facts">
                    {principle.facts.map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.value}</dt>
                        <dd>{fact.label}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="principle-card__source">
                    Measured on a real 11,000-email Gmail inbox, October 2026.
                  </p>
                </>
              ) : null}
              <Check aria-hidden="true" />
            </motion.article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="how-it-works" aria-labelledby="workflow-title">
        <div className="workflow-panel">
          <motion.div className="workflow-panel__header" {...reveal()}>
            <span className="eyebrow">How it works</span>
            <h2 id="workflow-title" aria-label="Four steps. Two of them are yours.">
              Four steps.
              <br />
              Two of them are yours.
            </h2>
            <p>
              You sign in and connect Gmail. Classifying and organizing every email after that is
              AMO&rsquo;s job.
            </p>
          </motion.div>
          <ol className="workflow-steps">
            {workflow.map((step, index) => (
              <motion.li key={step.title} {...reveal(index)}>
                <div className="workflow-step__meta">
                  <span>0{index + 1}</span>
                  <Check aria-hidden="true" />
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <motion.section className="landing-final-cta" {...reveal()}>
        <BrandMark compact />
        <h2>Bring calm to the review queue.</h2>
        <p>
          Sign in, connect Gmail when you choose, and let AMO classify and organize the rest. Your
          data stays yours — keep it or delete it every time you sign out.
        </p>
        <Link className="cta-link cta-link--paper" to="/login">
          Continue with Google <ArrowRight aria-hidden="true" />
        </Link>
      </motion.section>
    </>
  );
}

import { ArrowRight, Check, LockKeyhole, MousePointer2 } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { Link } from 'react-router-dom';

import heroImage from '@web/assets/mailmind-editorial-hero.png';
import { BrandMark } from '@web/components/BrandMark';
import { MOTION, useEntrance, useReveal } from '@web/lib/motion';

const principles = [
  {
    number: '01',
    title: 'Suggestions, not surprises',
    copy: 'MailMind finds useful patterns in synchronized Gmail metadata and turns them into label suggestions for you to review.',
  },
  {
    number: '02',
    title: 'Your decision comes first',
    copy: 'Approve, reject, defer, or refine each suggestion. A review decision never changes your Gmail messages or labels.',
  },
  {
    number: '03',
    title: 'Permission on your terms',
    copy: 'Google sign-in and Gmail access stay separate. You can disconnect Gmail without deleting your MailMind account.',
  },
] as const;

const workflow = [
  {
    title: 'Sign in with Google.',
    copy: 'Create your MailMind identity using your basic Google profile. This step does not grant Gmail access.',
  },
  {
    title: 'Connect Gmail.',
    copy: 'Authorize Gmail separately, then synchronize the message metadata MailMind needs to find organization patterns.',
  },
  {
    title: 'Review suggested labels.',
    copy: 'MailMind groups recurring senders and topics into controlled label suggestions with clear reasons.',
  },
  {
    title: 'Approve or reject suggestions.',
    copy: 'Keep, refine, defer, or reject each idea. Your review is recorded, but Gmail is not changed at this stage.',
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
            <span /> A human-reviewed Gmail organizer
          </motion.div>
          <motion.h1 {...entrance(1)}>
            MailMind <em>AI</em>
          </motion.h1>
          <motion.p className="landing-hero__promise" {...entrance(2)}>
            Thoughtful Gmail organization,
            <br />
            with every suggestion reviewed by you.
          </motion.p>
          <motion.p className="landing-hero__lede" {...entrance(3)}>
            MailMind AI securely analyzes synchronized Gmail metadata to identify recurring senders
            and topics, then suggests useful labels for you to approve or reject. Reviewing a
            suggestion does not change Gmail at this stage.
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
            <span>MailMind study № 01</span>
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
          <h2 id="principles-title">
            Made to recommend.
            <br />
            Built to ask first.
          </h2>
        </motion.div>
        <div className="principles-grid">
          {principles.map((principle, index) => (
            <motion.article key={principle.number} className="principle-card" {...reveal(index)}>
              <span className="principle-card__number">{principle.number}</span>
              <h3>{principle.title}</h3>
              <p>{principle.copy}</p>
              <Check aria-hidden="true" />
            </motion.article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="how-it-works" aria-labelledby="workflow-title">
        <div className="workflow-panel">
          <motion.div className="workflow-panel__header" {...reveal()}>
            <span className="eyebrow">How it works</span>
            <h2 id="workflow-title" aria-label="Four clear steps. Every choice stays yours.">
              Four clear steps.
              <br />
              Every choice stays yours.
            </h2>
            <p>
              From secure sign-in to label review, MailMind keeps identity, Gmail permission, and
              every organization decision explicit.
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
          Start with a secure MailMind AI identity. Connect Gmail only when you choose, and keep
          every label suggestion under your control.
        </p>
        <Link className="cta-link cta-link--paper" to="/login">
          Continue with Google <ArrowRight aria-hidden="true" />
        </Link>
      </motion.section>
    </>
  );
}
